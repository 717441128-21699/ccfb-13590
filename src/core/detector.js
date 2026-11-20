// 机械表走时检测器（流式）。
// 处理链：带通选频 → 包络 → 噪声底 → 冲击起点 → IOI 周期估计 → 标准摆频识别
//        → 节拍网格对齐（离格冲击剔除）→ 每拍 P1/P2/P3 子声拆分
//        → 稳健奇偶拟合（日差/偏振）→ 升角时间换算摆幅。
// 设计要点对标行业开源校表仪：
//  - 子声时刻用"包络阈值穿越的亚样本起点"，不用峰值点；
//  - 日差与偏振来自 t = a + P·k + c·(-1)^k 的稳健回归；
//  - 日历/陀飞轮/磕碰等离格事件不进网格，只计入干扰统计；
//  - 同一段信号无论分多少块喂入，结果一致（全部状态在类内维护）。

import { makeWatchBandpass } from '../dsp/filters.js';
import {
  EnvelopeFollower, RunningFloor, findPeaks, onsetFromPeak, median, mean,
} from '../dsp/envelope.js';
import { findLocalSubpeaks } from '../dsp/subpeaks.js';
import {
  estimatePeriodFromIOI,
  fitBeatGrid, fitParityLine, nominalBeatPeriodSec, STANDARD_BPH,
} from '../dsp/period.js';
import {
  amplitudeFromLiftTime, beatErrorMs, rateFromPeriod, residualToRateSd,
  liftTimeWindowSec, DEFAULT_LIFT_ANGLE_DEG,
} from './geometry.js';

export class WatchDetector {
  constructor(opts = {}) {
    this.fs = opts.fs || 48000;
    this.liftAngleDeg = opts.liftAngleDeg || DEFAULT_LIFT_ANGLE_DEG;
    this.ampRange = opts.ampRange || [140, 345];
    this.minSnrDb = opts.minSnrDb ?? 6;
    this.lockHits = opts.lockHits ?? 2;

    this.band = makeWatchBandpass(this.fs);
    this.envFollower = new EnvelopeFollower(this.fs, 0.4, 3.0);
    this.floorTracker = new RunningFloor(this.fs, 400, 0.15);

    // 包络/噪声底/快速整流三路环形缓冲，保留 1.2s 供子声回溯
    this.ringLen = Math.round(this.fs * 1.2);
    this.envRing = new Float64Array(this.ringLen);
    this.floorRing = new Float64Array(this.ringLen);
    this.rectRing = new Float64Array(this.ringLen); // 快速整流，用于亚样本起点
    this.ringWrite = 0;
    this.ringFilled = 0;

    this.sampleCount = 0;
    this.onsets = [];              // [{t, snrDb, height, assigned}]
    this.pendingTicks = [];
    this.lockState = 'search';     // search | locked
    this.lockScore = 0;
    this.periodSec = null;
    this.bph = null;
    this.t0 = null;
    this.nonStandard = false;

    // 奇偶模板：对齐累加同奇偶拍的整流波形，噪声相消、周期三子声增强。
    // 锚点可能是 P3（P1 在其前，最长升角约 19ms）或 P1（P3 在其后），
    // 故前后各留 22ms，保证两种情况下 P1→P3 全段都在窗内。
    this.tplPreMs = 22;
    this.tplPostMs = 22;
    this.tplLen = Math.round(this.fs * (this.tplPreMs + this.tplPostMs) / 1000);
    this.templates = [
      { sum: new Float64Array(this.tplLen), n: 0 }, // 偶拍(tic)
      { sum: new Float64Array(this.tplLen), n: 0 }, // 奇拍(tac)
    ];

    this.windowTicks = [];
    this.rateSd = NaN;
    this.beatErrorMs = NaN;
    this.amplitudeDeg = NaN;
    this.amplitudeSpreadDeg = NaN;
    this.tLiftMedianSec = NaN;
    this.fitPeriod = null;
    this.paritySec = null;
    this.fitSigmaSec = NaN;
    this.quality = {
      fillRate: NaN, offGridRate: NaN, jitterMs: NaN, snrDb: NaN,
      p1DetectedRate: NaN, offGridCount: 0,
    };
    this.offGridEvents = [];
  }

  reset() {
    this.band.reset();
    this.envFollower.reset();
    this.floorTracker.reset();
    this.envRing.fill(0);
    this.floorRing.fill(0);
    this.rectRing.fill(0);
    this.ringWrite = 0;
    this.ringFilled = 0;
    this.sampleCount = 0;
    this.onsets = [];
    this.pendingTicks = [];
    this.lockState = 'search';
    this.lockScore = 0;
    this.periodSec = null;
    this.bph = null;
    this.t0 = null;
    this.windowTicks = [];
    this.offGridEvents = [];
    this.templates = [
      { sum: new Float64Array(this.tplLen), n: 0 },
      { sum: new Float64Array(this.tplLen), n: 0 },
    ];
  }

  // 把一块包络写入环形缓冲
  _pushRing(env, floor, rect) {
    for (let i = 0; i < env.length; i++) {
      this.envRing[this.ringWrite] = env[i];
      this.floorRing[this.ringWrite] = floor[i];
      this.rectRing[this.ringWrite] = rect[i];
      this.ringWrite = (this.ringWrite + 1) % this.ringLen;
    }
    this.ringFilled = Math.min(this.ringLen, this.ringFilled + env.length);
  }

  // 取覆盖 [tLoSec, tHiSec] 的线性视图（环形缓冲可能回绕，复制到连续数组）
  _ringView(tLoSec, tHiSec) {
    const fs = this.fs;
    const iLo = Math.max(0, Math.round(tLoSec * fs) - (this.sampleCount - this.ringFilled));
    const iHi = Math.min(this.ringFilled - 1, Math.round(tHiSec * fs) - (this.sampleCount - this.ringFilled));
    // 转换为环形索引
    const start = (this.ringWrite - this.ringFilled + this.ringLen) % this.ringLen;
    const absLo = Math.max(0, iLo);
    const absHi = Math.min(this.ringFilled - 1, iHi);
    const len = absHi - absLo + 1;
    if (len <= 0) return null;
    const env = new Float64Array(len);
    const flr = new Float64Array(len);
    const rect = new Float64Array(len);
    for (let i = 0; i < len; i++) {
      const idx = (start + absLo + i) % this.ringLen;
      env[i] = this.envRing[idx];
      flr[i] = this.floorRing[idx];
      rect[i] = this.rectRing[idx];
    }
    const baseSample = this.sampleCount - this.ringFilled + absLo;
    return { env, floor: flr, rect, baseSample };
  }

  // 喂入一块 PCM（任意长度，建议 0.25–1s）。返回该块产生的新拍。
  process(chunk) {
    const fs = this.fs;
    const x = Float64Array.from(chunk);
    const baseSample = this.sampleCount;
    this.sampleCount += x.length;

    this.band.process(x);
    const env = this.envFollower.process(x);
    const floor = this.floorTracker.process(env);
    // 快速整流（~0.8ms 衰减）：子声峰定位与亚样本起点用，
    // 衰减足够短以分辨 P1→P3（间隔 ≥5.9ms），又比裸整流更抗噪。
    const rect = new Float64Array(x.length);
    const rRel = Math.exp(-1 / (fs * 0.0008));
    let re = 0;
    for (let i = 0; i < x.length; i++) {
      const v = Math.abs(x[i]);
      re = v > re ? 0.5 * v + 0.5 * re : rRel * re;
      rect[i] = re;
    }
    this._pushRing(env, floor, rect);

    // 全局拍起点：高阈值 + 4ms 不应期
    const refractory = Math.round(fs * 0.004);
    const peaks = findPeaks(env, 0, refractory);
    for (const pk of peaks) {
      const f = floor[pk.index];
      const h = env[pk.index];
      if (h <= f * 1.8) continue;
      const snrLin = h / Math.max(f, 1e-9);
      // 上限 60dB：底噪接近零时比值会虚高到上百分贝，没有物理意义
      const snrDb = Math.min(60, 20 * Math.log10(snrLin));
      if (snrDb < this.minSnrDb) continue;
      const local = onsetFromPeak(env, pk.index, f, 0.12);
      const t = (baseSample + local) / fs;
      this.onsets.push({ t, snrDb, height: h, assigned: false });
    }
    if (this.onsets.length > 600) {
      this.onsets.splice(0, this.onsets.length - 600);
    }

    if (this.lockState === 'search') this._tryLock();
    const produced = this.lockState === 'locked' ? this._assignTicks() : [];
    if (this.lockState === 'locked') this._updateMetrics();
    return produced;
  }

  _tryLock() {
    const est = estimatePeriodFromIOI(this.onsets.map((o) => o.t), this.fs);
    if (!est) return;
    const times = this.onsets.map((o) => o.t);
    // 对每个标准摆频做网格试配，综合"落格数 + 残差紧凑度 + 命中率"评分。
    // 干扰产生的假周期即使落格点多，残差也分散，评分低于真实节拍。
    let best = null;
    for (const bph of STANDARD_BPH) {
      const nominal = nominalBeatPeriodSec(bph);
      const grid = fitBeatGrid(times, nominal, nominal * 0.1);
      if (grid.beats.length < 8) continue;
      const resid = grid.beats.map((b) => Math.abs(b.residual));
      resid.sort((a, b) => a - b);
      const medResid = resid[resid.length >> 1];
      const total = grid.beats.length + grid.offGrid.length;
      const hitRate = grid.beats.length / total;
      // 紧容差（±3% 周期）内的落格数是真假周期的决定性区别：
      // 真周期的拍紧密聚集在网格上，假周期只能靠宽容差凑数。
      const tight = grid.beats.filter((b) => Math.abs(b.residual) <= nominal * 0.03).length;
      const residScore = 1 - Math.min(1, medResid / (nominal * 0.1));
      const score = tight * 0.05 + hitRate * 2 + residScore * 1.5 + Math.log10(grid.beats.length) * 0.2;
      if (!best || score > best.score) {
        best = { bph, nominal, grid, score, hitRate, nBeats: grid.beats.length, tight };
      }
    }
    if (!best) {
      this.lockScore = Math.max(0, this.lockScore - 1);
      return;
    }
    // 接受门槛：强噪声下短数据里多个标准频率会"偶然"拟合（5 秒内 18000/25200/36000
    // 可能同样吻合），属于欠定问题。要求至少 50 个落格拍（约 6–10 秒）才锁定，
    // 让真实周期的紧容差聚集随数据积累稳定胜出。
    if (best.nBeats >= 50 && (best.hitRate >= 0.4 || best.nBeats >= 70)) {
      // 交叉验证：低命中率时要求紧容差拍数占比足够高，临界则继续观察。
      const tightRatio = best.tight / Math.max(1, best.nBeats);
      if (best.hitRate < 0.55 && tightRatio < 0.45 && this.onsets.length < 900) {
        this.lockScore = Math.max(0, this.lockScore - 1);
        return;
      }
      this.lockScore++;
      if (this.lockScore >= this.lockHits || best.nBeats >= 50) {
        const freqChanged = this.lockState === 'locked' && this.bph !== best.bph;
        this.lockState = 'locked';
        this.periodSec = best.nominal;
        this.bph = best.bph;
        this.t0 = best.grid.t0;
        this.nonStandard = false;
        for (const o of this.onsets) o.assigned = false;
        // 重新锁定到不同频率：清空旧频率残留的拍与模板，避免污染指标
        if (freqChanged) {
          this.windowTicks = [];
          this.templates = [
            { sum: new Float64Array(this.tplLen), n: 0 },
            { sum: new Float64Array(this.tplLen), n: 0 },
          ];
          this.rateSd = NaN; this.beatErrorMs = NaN; this.amplitudeDeg = NaN;
        }
      }
    } else {
      this.lockScore = Math.max(0, this.lockScore - 1);
    }
  }

  _assignTicks() {
    const P = this.periodSec;
    const produced = [];
    const tol = P * 0.18;
    // 同一拍号只保留残差最小的锚点（一个拍的多个子峰会产生多个锚点）
    const bestForK = new Map();
    const offGrid = [];
    for (const o of this.onsets) {
      if (o.assigned) continue;
      const k = Math.round((o.t - this.t0) / P);
      const expected = this.t0 + k * P;
      const residual = o.t - expected;
      if (Math.abs(residual) <= tol) {
        const cur = bestForK.get(k);
        if (!cur || Math.abs(residual) < Math.abs(cur.t - (this.t0 + k * P))) {
          bestForK.set(k, o);
        }
      } else if (Math.abs(residual) > P * 0.35) {
        offGrid.push(o);
      }
    }
    for (const o of offGrid) {
      o.assigned = true;
      this.offGridEvents.push({ t: o.t, snrDb: o.snrDb });
      if (this.offGridEvents.length > 300) this.offGridEvents.shift();
    }
    for (const [k, o] of bestForK) {
      o.assigned = true;
      // 已建过该拍号则跳过（滚动窗里可能残留）
      if (this.windowTicks.some((w) => w.k === k)) continue;
      const tick = this._buildTick(k, o);
      if (tick) {
        this.pendingTicks.push(tick);
        produced.push(tick);
      }
    }
    // 只保留最近 2s 内未分配的起点（等下一块到来再判）
    const now = this.sampleCount / this.fs;
    this.onsets = this.onsets.filter((o) => !o.assigned || now - o.t < 2);
    return produced;
  }

  // 在锚点附近的包络环形缓冲里扫描 P1/P2/P3 三个子声。
  // 锚点是该拍最响的包络峰（通常即 P3，也可能是 P1/P2）。
  // 策略：取 [锚点-tHi, 锚点+tHi] 窗内全部合格子峰，按时间排序后用升角物理窗配对。
  _buildTick(k, anchor) {
    const P = this.periodSec;
    const [tLo, tHi] = liftTimeWindowSec(this.bph, this.liftAngleDeg, this.ampRange);
    // 搜索窗贴近物理升角范围（真 tLift 落在 [tLo,tHi]），两侧留 30% 余量，
    // 但绝不超过节拍半周期的 28%，杜绝相邻拍事件进入。
    const halfWin = Math.min(tHi * 0.7, P * 0.28);
    const margin = 0.002;
    const view = this._ringView(anchor.t - halfWin - margin, anchor.t + halfWin + margin);
    let p1T = NaN, p2T = NaN, p3T = NaN;

    if (view) {
      const subs = findLocalSubpeaks(
        view.env, view.floor, view.baseSample, this.fs,
        anchor.t - halfWin - margin, anchor.t + halfWin + margin,
        { refractoryMs: 0.3, floorFraction: 0.15, relThreshold: 0.12, rectBuf: view.rect },
      );
      if (subs.length >= 2) {
        // 物理升角窗的中位跨度，作为配对的偏好基准
        const gapMid = (tLo + tHi) / 2;
        const maxH = Math.max(...subs.map((s) => s.height));
        // 噪声会在窗内制造大量低峰，冒充 P1 把跨度拉长。对策：
        //  1) P1 能量须达 P3 的 30%（真开锁声虽弱但仍是成簇事件，高于随机噪声峰）；
        //  2) 跨度收紧到 [tLo·0.85, tHi·1.1]，排除噪声拉出的超长 gap；
        //  3) 评分以"跨度接近物理中位"为主导，响度为辅。
        let best = null;
        for (let i = 0; i < subs.length; i++) {
          for (let j = subs.length - 1; j > i; j--) {
            const gap = subs[j].onsetSec - subs[i].onsetSec;
            if (gap < tLo * 0.85 || gap > tHi * 1.1) continue;
            if (subs[i].height < subs[j].height * 0.3) continue;
            const loudScore = subs[j].height / maxH;
            const gapScore = 1 - Math.min(1, Math.abs(gap - gapMid) / gapMid);
            const score = gapScore * 0.65 + loudScore * 0.35;
            if (!best || score > best.score) {
              best = { i, j, gap, score };
            }
          }
        }
        if (best) {
          p1T = subs[best.i].onsetSec;
          p3T = subs[best.j].onsetSec;
          // P2：i,j 之间相对位置最接近 45% 升角的子峰
          let best2 = null, bestErr = Infinity;
          for (let q = best.i + 1; q < best.j; q++) {
            const frac = (subs[q].onsetSec - p1T) / Math.max(best.gap, 1e-9);
            const err = Math.abs(frac - 0.45);
            if (err < bestErr) { bestErr = err; best2 = subs[q]; }
          }
          if (best2) p2T = best2.onsetSec;
        }
      }
    }

    // 回退：子峰不足时用锚点自身（tLift=0，摆幅 NaN，不参与摆幅统计）
    if (!isFinite(p1T)) p1T = anchor.t;
    if (!isFinite(p3T)) p3T = anchor.t;

    const tLift = Math.max(0, p3T - p1T);
    const amp = tLift > 1e-4 ? amplitudeFromLiftTime(tLift, this.liftAngleDeg, this.bph) : NaN;
    const gridResidual = anchor.t - (this.t0 + k * P);
    return {
      k,
      t: anchor.t,
      residualSec: gridResidual,
      rateSd: residualToRateSd(gridResidual, this.bph),
      p1T, p2T, p3T,
      tLiftSec: tLift,
      amplitudeDeg: amp,
      snrDb: anchor.snrDb,
      parity: (k & 1) ? -1 : 1,
    };
  }

  _updateMetrics() {
    for (const tk of this.pendingTicks) {
      if (!this.windowTicks.some((w) => w.k === tk.k)) {
        this.windowTicks.push(tk);
        this._accumulateTemplate(tk);
      }
    }
    this.pendingTicks.length = 0;
    this.windowTicks.sort((a, b) => a.k - b.k);
    // 滚动窗取 480 拍（28800 下约 60s）：样本越多，奇偶偏振项的噪声收缩越小。
    const maxWindow = 480;
    if (this.windowTicks.length > maxWindow) {
      this.windowTicks.splice(0, this.windowTicks.length - maxWindow);
    }

    const ticks = this.windowTicks;
    if (ticks.length < 8) return;

    const fit = fitParityLine(ticks.map((t) => ({ t: t.t, k: t.k })));
    if (fit) {
      this.fitPeriod = fit.period;
      this.paritySec = fit.paritySec;
      this.fitSigmaSec = fit.sigmaSec;
      this.rateSd = rateFromPeriod(fit.period, this.bph);
      this.beatErrorMs = beatErrorMs(fit.paritySec);
      // 用回归截距重定相位基准：网格 t0 = a - c（k=0、偶拍的零相位时刻）。
      // 这样即使日差很大，下一块起点仍按"实测节拍"对齐，残差不会随时间累积。
      this.t0 = fit.intercept - fit.paritySec;
      this.periodSec = fit.period;
    }

    // 摆幅：优先用奇偶模板（多拍对齐累加，噪声相消），模板未成形时退回单拍众数。
    const tplLift = this._liftFromTemplate();
    const liftsAll = ticks
      .filter((t) => Number.isFinite(t.amplitudeDeg) && t.tLiftSec > 1e-4)
      .map((t) => t.tLiftSec);
    if (tplLift) {
      this.tLiftMedianSec = tplLift.tLiftSec;
      this.amplitudeDeg = amplitudeFromLiftTime(this.tLiftMedianSec, this.liftAngleDeg, this.bph);
      const amps = ticks
        .filter((t) => Number.isFinite(t.amplitudeDeg))
        .map((t) => t.amplitudeDeg);
      this.amplitudeSpreadDeg = amps.length >= 5 ? 1.4826 * this._mad(amps) : NaN;
    } else if (liftsAll.length >= 6) {
      this.tLiftMedianSec = this._modeLiftTime(liftsAll);
      this.amplitudeDeg = amplitudeFromLiftTime(this.tLiftMedianSec, this.liftAngleDeg, this.bph);
    }

    const ks = ticks.map((t) => t.k);
    const span = ks[ks.length - 1] - ks[0] + 1;
    this.quality.fillRate = span ? ticks.length / span : 0;
    this.quality.jitterMs = (this.fitSigmaSec || NaN) * 1000;
    this.quality.snrDb = mean(ticks.map((t) => t.snrDb));
    this.quality.p1DetectedRate = ticks
      .filter((t) => isFinite(t.p1T) && isFinite(t.p3T) && t.p3T - t.p1T > 1e-4).length / ticks.length;
    this.quality.offGridRate = this.offGridEvents.length /
      Math.max(1, ticks.length + this.offGridEvents.length);
    this.quality.offGridCount = this.offGridEvents.length;
  }

  _mad(vals) {
    const m = median(vals);
    return median(vals.map((v) => Math.abs(v - m)));
  }

  // 把一个拍的整流片段按锚点做亚样本对齐，累加进对应奇偶模板。
  // 日差/偏振使每拍锚点相对整数样本有亚样本相位漂移，直接取整累加会把模板峰
  // 涂抹变宽、产生假峰；这里用线性插值把片段移位到精确锚点再累加。
  _accumulateTemplate(tick) {
    const parityIdx = tick.parity > 0 ? 0 : 1;
    const tpl = this.templates[parityIdx];
    const fs = this.fs;
    const preSamples = Math.round(fs * this.tplPreMs / 1000);
    const anchorExact = tick.t * fs;                 // 浮点样本号
    const anchorInt = Math.floor(anchorExact);
    const frac = anchorExact - anchorInt;            // 亚样本相位 0..1
    const ringStart = (this.ringWrite - this.ringFilled + this.ringLen) % this.ringLen;
    const ringBase = this.sampleCount - this.ringFilled;
    const decay = 0.85;

    const readRing = (globalSample) => {
      const abs = globalSample - ringBase;
      if (abs < 0 || abs >= this.ringFilled) return 0;
      return this.rectRing[(ringStart + abs) % this.ringLen];
    };

    for (let i = 0; i < this.tplLen; i++) {
      // 模板 i 处对应锚点前 preSamples 个样本，加上亚样本分数做插值
      const g0 = anchorInt - preSamples + i;
      const v0 = readRing(g0);
      const v1 = readRing(g0 + 1);
      const v = v0 * (1 - frac) + v1 * frac;
      tpl.sum[i] = tpl.sum[i] * decay + v;
    }
    tpl.n = Math.min(16, tpl.n + 1);
  }

  // 从模板测量 P1→P3 升角时间。
  // 物理判据（不依赖"居中"假设，故全摆幅量程适用）：
  //  模板最强峰 = P3（落下声，拍内最响）；P1（开锁）是 P3 之前、
  //  落在物理升角窗 [tLo,tHi] 内的最早显著子声。
  //  若最强峰后还存在同窗内显著峰，则最强峰实为 P1，取其后的 P3。
  _liftFromTemplate() {
    const [tLo, tHi] = liftTimeWindowSec(this.bph, this.liftAngleDeg, this.ampRange);
    const results = [];
    for (const tpl of this.templates) {
      if (tpl.n < 6) continue;
      const avg = tpl.sum;
      const base = -Math.round(this.fs * this.tplPreMs / 1000);
      const zeroFloor = new Float64Array(this.tplLen);
      const subs = findLocalSubpeaks(avg, zeroFloor, base, this.fs,
        -this.tplPreMs / 1000 + 0.001, this.tplPostMs / 1000 - 0.001,
        { refractoryMs: 0.3, relThreshold: 0.18, rectBuf: avg });
      if (subs.length < 2) continue;

      const hMax = Math.max(...subs.map((s) => s.height));
      const sigRatio = 0.35;

      // 严格物理窗：相邻拍事件落在 tHi 之外，1.05 倍容差仅吸收亚样本测量误差。
      const gapMin = tLo * 0.9;
      const gapMax = tHi * 1.05;
      // 枚举所有时间有序、跨度合法、两峰都够响的 (P1=i, P3=j) 峰对。
      // P3（落下）是拍内最响子声：最佳峰对的末峰高度应接近全局最大峰。
      let best = null;
      for (let i = 0; i < subs.length; i++) {
        for (let j = i + 1; j < subs.length; j++) {
          const gap = subs[j].onsetSec - subs[i].onsetSec;
          if (gap < gapMin || gap > gapMax) continue;
          if (subs[i].height < hMax * sigRatio) continue;
          if (subs[j].height < hMax * sigRatio) continue;
          // 评分：末峰响度为主（P3 最响），两峰都显著为辅
          const endScore = subs[j].height / hMax;
          const startScore = subs[i].height / hMax;
          const score = endScore * 1.5 + startScore * 0.5;
          if (!best || score > best.score) {
            best = { gap, score, endH: subs[j].height, startH: subs[i].height };
          }
        }
      }
      if (best) results.push({ gap: best.gap, endH: best.endH });
    }
    if (!results.length) return null;
    // 两奇偶模板：一致（差 <1.5ms）取均值；不一致时信末峰更响（P3 更突出）的模板
    if (results.length === 2) {
      if (Math.abs(results[0].gap - results[1].gap) < 0.0015) {
        return { tLiftSec: (results[0].gap + results[1].gap) / 2 };
      }
      results.sort((a, b) => b.endH - a.endH);
    }
    return { tLiftSec: results[0].gap };
  }

  // 升角时间众数：1ms bin 直方图找主峰，再在主峰 ±1.5ms 内取中位数精修。
  // 错误配对产生的 tLift 分散且随机，真拍集中，故众数对噪声鲁棒。
  _modeLiftTime(lifts) {
    const binMs = 1;
    let lo = Infinity, hi = 0;
    for (const v of lifts) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    lo *= 1000; hi *= 1000;
    const nBins = Math.max(2, Math.ceil((hi - lo) / binMs) + 1);
    const hist = new Float64Array(nBins);
    for (const v of lifts) {
      const b = Math.min(nBins - 1, Math.max(0, Math.floor((v * 1000 - lo) / binMs)));
      hist[b]++;
    }
    let bestB = 0;
    for (let b = 1; b < nBins; b++) if (hist[b] > hist[bestB]) bestB = b;
    const modeCenterMs = lo + (bestB + 0.5) * binMs;
    const near = lifts
      .filter((v) => Math.abs(v * 1000 - modeCenterMs) <= 1.5)
      .sort((a, b) => a - b);
    if (near.length >= 3) return near[near.length >> 1];
    return modeCenterMs / 1000;
  }

  snapshot() {
    return {
      locked: this.lockState === 'locked',
      bph: this.bph,
      nonStandard: this.nonStandard,
      rateSd: this.rateSd,
      beatErrorMs: this.beatErrorMs,
      amplitudeDeg: this.amplitudeDeg,
      amplitudeSpreadDeg: this.amplitudeSpreadDeg,
      tLiftMs: this.tLiftMedianSec * 1000,
      periodSec: this.fitPeriod ?? this.periodSec,
      ticks: this.windowTicks.slice(-180),
      quality: { ...this.quality },
      offGridEvents: this.offGridEvents.slice(-30),
      analyzedSec: this.sampleCount / this.fs,
      liftAngleDeg: this.liftAngleDeg,
    };
  }
}

// 一次性分析整段信号（测试用）：内部按 0.5s 分块喂入，返回最终快照与全部拍。
export function analyzeBuffer(samples, fs, opts = {}) {
  const det = new WatchDetector({ ...opts, fs });
  const chunk = Math.round(fs * 0.5);
  let all = [];
  for (let off = 0; off < samples.length; off += chunk) {
    const part = samples.subarray ? samples.subarray(off, off + chunk) : samples.slice(off, off + chunk);
    const got = det.process(part);
    all = all.concat(got);
  }
  return { detector: det, snapshot: det.snapshot(), ticks: all };
}
