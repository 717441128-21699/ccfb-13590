// 机械表走时声合成器：按给定物理参数生成可复现的"咔嗒"信号，并输出精确真值。
// 设计对标行业校表仪的合成测试信号：
//  - 每拍三个子声 P1 开锁 / P2 冲击 / P3 落下，均为阻尼正弦多模态 burst
//  - 真实日差、偏振、摆幅、升角、抖动、漏拍、削波、有色噪声、市电哼扰、随机冲击
//  - 日历跳字：在指定时刻注入一串不在节拍网格上的低频机构咔哒
//  - 陀飞轮：笼架周期（默认 60s/转）的慢幅度调制 + 每转一次离格软撞击
// 所有随机数来自带种子的 PRNG，测试可精确复现。

import { liftTimeFromAmplitude } from './geometry.js';
import { makeWatchBandpass } from '../dsp/filters.js';
import { nominalBeatPeriodSec } from '../dsp/period.js';

// mulberry32 种子随机
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Box-Muller 高斯
function gaussian(rand) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// 阻尼正弦多模态叠加：out 上从 t0 起叠加 sum amp·exp(-τ/decay)·sin(2π f τ)
// 每个模态为 [频率Hz, 相对幅度, 衰减秒]
function addBurst(out, fs, t0, level, modes) {
  const n0 = Math.max(0, Math.floor(t0 * fs));
  // burst 支持到 8 倍最大衰减常数；至少写 1 个样本，避免短 burst 取整倒挂
  const maxDecay = Math.max(...modes.map((m) => m[2]));
  const n1 = Math.min(out.length, Math.max(n0 + 1, Math.ceil((t0 + 8 * maxDecay) * fs)));
  for (let n = n0; n < n1; n++) {
    const tau = n / fs - t0;
    if (tau < 0) continue;
    let y = 0;
    for (const m of modes) {
      const f = m[0], amp = m[1], decay = m[2];
      y += amp * Math.exp(-tau / decay) * Math.sin(2 * Math.PI * f * tau);
    }
    out[n] += level * y;
  }
}

// 三子声各自的共振模态 [频率Hz, 相对幅度, 衰减s]
// P1 开锁：弱、高频、短；P2 冲击：中频；P3 落下：最响、最长、多模态
const P1_MODES = [[7200, 0.5, 0.0009], [9800, 0.3, 0.0006]];
const P2_MODES = [[4200, 0.7, 0.0016], [6100, 0.4, 0.0011]];
const P3_MODES = [[2600, 1.0, 0.0042], [3900, 0.7, 0.0028], [5400, 0.45, 0.0019]];
const P2_FRACTION = 0.45; // P2 位于 t_lift 的 45% 处（行业惯例值）

// 日历机构声模态：低频、长衰减，明显区别于擒纵高频咔嗒
const DATE_MODES = [[900, 1.0, 0.014], [1500, 0.6, 0.009], [2200, 0.35, 0.006]];
// 陀飞轮笼架软撞击：更低沉
const CAGE_MODES = [[650, 1.0, 0.022], [1100, 0.5, 0.014]];
// 随机冲击噪声（桌面磕碰等）
const IMPACT_MODES = [[3200, 0.8, 0.003], [7800, 0.5, 0.0015]];

// 有色噪声序列
function coloredNoise(rand, n, color) {
  const out = new Float64Array(n);
  if (color === 'white' || !color) {
    for (let i = 0; i < n; i++) out[i] = gaussian(rand);
    return out;
  }
  if (color === 'pink') {
    // Paul Kellet 近似 1/f 滤波
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < n; i++) {
      const w = gaussian(rand);
      b0 = 0.99765 * b0 + w * 0.0990460;
      b1 = 0.96300 * b1 + w * 0.2965164;
      b2 = 0.57000 * b2 + w * 1.0526913;
      out[i] = b0 + b1 + b2 + w * 0.1848;
    }
    return out;
  }
  if (color === 'brown') {
    // 泄漏积分，截止约 400Hz
    let last = 0;
    const alpha = 2 * Math.PI * 400 / 48000;
    for (let i = 0; i < n; i++) {
      const w = gaussian(rand);
      last = last + alpha * (w - last);
      out[i] = last * 3.2;
    }
    return out;
  }
  throw new Error(`未知噪声颜色: ${color}`);
}

/**
 * 合成机械表信号。
 * @param {object} p 参数
 *  bph 摆频(18000/21600/25200/28800/36000)；rateSd 日差 s/d；beatErrorMs 偏振 ms；
 *  amplitudeDeg 摆幅度；liftAngleDeg 升角度；fs 采样率；seconds 时长；
 *  snrDb P3 峰值对带内噪声 RMS 的信噪比；noiseColor 'white'|'pink'|'brown'|null；
 *  jitterUs 每拍高斯抖动标准差；mainsHz 市电基频(null 关闭)；mainsLevel 相对 P3；
 *  p1Gain P1 额外增益(可弱到 0.05)；missProb 整拍静默概率；
 *  clipLevel 削波电平(null 不削)；seed 随机种子；
 *  ampVariation 摆幅随机游走分数；rateDriftSdPerMin 日漂移；
 *  impactHz 随机冲击发生率；dateChangeAtSec 日历跳字时刻(null 关闭)；dateClicks 咔哒数；
 *  tourbillon 是否启用陀飞轮；cagePeriodSec 笼架转一周秒数；cageMod 摆幅调制深度。
 * @returns {{samples: Float64Array, truth: object, params: object}}
 */
export function synthWatch(p = {}) {
  const {
    bph = 28800,
    rateSd = 0,
    beatErrorMs = 0,
    amplitudeDeg = 280,
    liftAngleDeg = 52,
    fs = 48000,
    seconds = 120,
    snrDb = 30,
    noiseColor = 'pink',
    jitterUs = 50,
    mainsHz = null,
    mainsLevel = 0.3,
    p1Gain = 1,
    missProb = 0,
    clipLevel = null,
    seed = 1,
    ampVariation = 0,
    rateDriftSdPerMin = 0,
    impactHz = 0,
    dateChangeAtSec = null,
    dateClicks = 9,
    tourbillon = false,
    cagePeriodSec = 60,
    cageMod = 0.12,
  } = p;

  const rand = mulberry32(seed);
  const n = Math.round(fs * seconds);
  const out = new Float64Array(n);
  const nominalP = nominalBeatPeriodSec(bph);
  const basePeriod = nominalP / (1 + rateSd / 86400);
  const parityC = beatErrorMs / 1000 / 2; // t = a + Pk + c(-1)^k 中的 c
  const tLift0 = liftTimeFromAmplitude(amplitudeDeg, liftAngleDeg, bph);
  const P3_LEVEL = 0.5; // P3 峰值基准电平

  const truth = {
    bph, fs, nominalPeriodSec: nominalP, tLiftSec: tLift0,
    rateSd, beatErrorMs, amplitudeDeg, liftAngleDeg,
    k: [], p1: [], p2: [], p3: [], removedK: [],
    dateClicks: [], cageClicks: [], impacts: [],
  };

  let t = nominalP * rand(); // 随机起始相位
  let k = 0;
  let ampWalk = 0;
  while (t < seconds - 0.05) {
    // 日漂移：周期随时间线性变化
    const driftFactor = 1 + (rateDriftSdPerMin * (t / 60)) / 86400;
    const period = basePeriod / driftFactor;
    const stepT = t + period;

    // 摆幅随机游走 → t_lift 缓慢变化（合成器内部限制在物理可行域）
    if (ampVariation > 0) {
      ampWalk = 0.85 * ampWalk + gaussian(rand) * ampVariation;
    }
    const curAmp = Math.min(340, Math.max(120, amplitudeDeg * (1 + ampWalk)));
    const curLift = liftTimeFromAmplitude(curAmp, liftAngleDeg, bph);

    // 每拍抖动 + 奇偶偏振偏移
    const jitter = gaussian(rand) * jitterUs / 1e6;
    const parity = (k & 1) ? -1 : 1;
    const tBeat = t + jitter + parityC * parity;

    const missed = rand() < missProb;
    // 陀飞轮摆幅调制
    const cageEnv = tourbillon ? 1 + cageMod * Math.sin(2 * Math.PI * t / cagePeriodSec) : 1;

    if (!missed) {
      const t1 = tBeat;
      const t2 = tBeat + P2_FRACTION * curLift;
      const t3 = tBeat + curLift;
      addBurst(out, fs, t1, P3_LEVEL * p1Gain * cageEnv, P1_MODES);
      addBurst(out, fs, t2, P3_LEVEL * 0.55 * cageEnv, P2_MODES);
      addBurst(out, fs, t3, P3_LEVEL * cageEnv, P3_MODES);
      truth.k.push(k);
      truth.p1.push(t1); truth.p2.push(t2); truth.p3.push(t3);
    } else {
      truth.removedK.push(k);
    }
    t = stepT;
    k++;
  }

  // ---- 日历跳字：离格低频咔哒群 ----
  if (dateChangeAtSec != null && dateChangeAtSec < seconds) {
    let ct = dateChangeAtSec;
    for (let i = 0; i < dateClicks; i++) {
      // 间隔 40–260ms 的不规则序列，刻意避开节拍网格
      ct += 0.04 + rand() * 0.22;
      if (ct >= seconds - 0.1) break;
      const lvl = P3_LEVEL * (0.7 + rand() * 0.6);
      addBurst(out, fs, ct, lvl, DATE_MODES);
      truth.dateClicks.push(ct);
    }
  }

  // ---- 陀飞轮：每转一次笼架软撞击（离格） ----
  if (tourbillon) {
    for (let ct = cagePeriodSec * (0.3 + rand() * 0.4); ct < seconds; ct += cagePeriodSec) {
      const lvl = P3_LEVEL * (0.35 + rand() * 0.25);
      addBurst(out, fs, ct, lvl, CAGE_MODES);
      truth.cageClicks.push(ct);
    }
  }

  // ---- 随机冲击（磕碰/环境）----
  if (impactHz > 0) {
    let ct = -Math.log(rand()) / impactHz;
    while (ct < seconds) {
      const lvl = P3_LEVEL * (0.4 + rand() * 0.8);
      addBurst(out, fs, ct, lvl, IMPACT_MODES);
      truth.impacts.push(ct);
      ct += -Math.log(rand()) / impactHz;
    }
  }

  // ---- 市电哼扰：基频 + 3 次谐波 ----
  if (mainsHz) {
    for (let i = 0; i < n; i++) {
      const tt = i / fs;
      let hum = 0;
      for (let h = 1; h <= 4; h++) {
        hum += Math.sin(2 * Math.PI * mainsHz * h * tt + h) / h;
      }
      out[i] += P3_LEVEL * mainsLevel * hum / 2.08;
    }
  }

  // ---- 测量带内信号 RMS，按目标 SNR 配噪声 ----
  // SNR 口径与检测器一致：P3 峰值 / 同一带通频带内的噪声 RMS。
  // 因此先测滤波后信号峰值，再让"滤波后噪声 RMS"达到目标值，最后把原始噪声加回。
  if (snrDb != null && Number.isFinite(snrDb)) {
    const band = makeWatchBandpass(fs);
    const filtered = band.process(Float64Array.from(out));
    let sigPeak = 1e-12;
    for (const v of filtered) {
      const a = Math.abs(v);
      if (a > sigPeak) sigPeak = a;
    }
    const noise = coloredNoise(rand, n, noiseColor);
    const nf = makeWatchBandpass(fs);
    const nfFiltered = nf.process(Float64Array.from(noise));
    let nSumSq = 0;
    for (const v of nfFiltered) nSumSq += v * v;
    const noiseBandRms = Math.sqrt(nSumSq / n) || 1e-12;
    const targetNoiseBandRms = sigPeak / Math.pow(10, snrDb / 20);
    const scale = targetNoiseBandRms / noiseBandRms;
    for (let i = 0; i < n; i++) out[i] += noise[i] * scale;
  }

  // ---- 削波 ----
  if (clipLevel != null) {
    for (let i = 0; i < n; i++) {
      if (out[i] > clipLevel) out[i] = clipLevel;
      else if (out[i] < -clipLevel) out[i] = -clipLevel;
    }
  }

  truth.periodSec = basePeriod;
  return { samples: out, truth, params: { ...p, bph, fs, seconds } };
}
