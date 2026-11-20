// analyzer.js — 机械表走时分析器（纯 ES Module，浏览器/Node 共用）
// 处理链：带通 → 自适应包络起振点 → 拍网格捕获（评分搜索，抗倍/分频）
//         → 数字锁相环跟踪（允许慢漂移）→ 每拍三子声 1D 聚类学习
//         → 异声剔除（日历/陀飞轮/磕碰）→ 日差/偏振/摆幅/位差指标
// 所有时间单位：内部秒，输出按需要换算。

'use strict';

import {
  detectOnsets, spectralCentroid, median, mad, mean,
  circularMedian, clamp, RingBuffer, bandpassChain,
} from './dsp.js';

// 常见摆频候选（拍/小时），覆盖半摆/全摆表
const BPH_CANDIDATES = [14400, 16200, 18000, 19800, 21600, 25200, 28800, 33600, 36000];

const CENTROID_FREQS = [450, 700, 1000, 1600, 2400, 3400, 4800, 6500, 8500, 10500];

export class WatchAnalyzer {
  constructor(opts = {}) {
    this.fs = opts.sampleRate || 96000;
    this.liftAngleDeg = opts.liftAngleDeg ?? 52;
    this.minLockSec = opts.minLockSec ?? 2.0;
    this.acquireSec = opts.acquireSec ?? 3.0;
    this.slotTolMs = opts.slotTolMs ?? 1.6;     // 锚点匹配容差
    this.clusterGapMs = opts.clusterGapMs ?? 6.0;
    this.minClusterSupport = opts.minClusterSupport ?? 0.14;
    this.lowCentroidHz = opts.lowCentroidHz ?? 2200;   // 低于此质心判为日历类闷响
    this.historySec = opts.historySec ?? 150;   // 保留历史窗口

    this.state = 'acquiring';                    // acquiring | locked
    this.B = null;                               // 当前拍间隔（秒）
    this.anchor = null;                          // 最近一个锚点时间（秒）
    this.anchorK = 0;                            // 锚点拍号
    this.onsets = new RingBuffer(12000);         // ~30s 起振点足够重新捕获
    this.beats = new RingBuffer(4096);           // 锚定的拍 {t,k,slots:[{type?,t,onset,centroid}]}
    this.rejected = new RingBuffer(512);         // 被剔除的异声
    this.clusters = null;                        // [{type, offMed, offMad, support, centroid}]
    this.lockStats = { coverage: 0, lastReacquire: -1 };
    this.filters = bandpassChain(this.fs, 900, 11000);
    this.detectorState = { env: 0, floor: 0, warmupDone: false };
    this.t0 = null;                              // 首个样本绝对时间基准
    this.processedSamples = 0;
    this.diagnostics = { onsetCount: 0, lastChunkOnsets: 0, envelope: null, filtered: null };
  }

  reset() {
    this.state = 'acquiring'; this.B = null; this.anchor = null; this.anchorK = 0;
    this.onsets.clear(); this.beats.clear(); this.rejected.clear();
    this.clusters = null; this.lockStats = { coverage: 0, lastReacquire: -1 };
    this.processedSamples = 0; this.t0 = null;
    this.detectorState = { env: 0, floor: 0, warmupDone: false };
    for (const bq of this.filters) bq.reset();
  }

  /** 处理一块音频（Float 数组，任意长度；建议 0.5–2 秒一块） */
  process(samples) {
    if (this.t0 === null) this.t0 = 0;
    const timeOffset = this.processedSamples / this.fs;
    const { onsets, envelope, filtered } = detectOnsets(samples, this.fs, {
      filters: this.filters,
      state: this.detectorState,
      timeOffset,
    });

    // 谱质心特征（音色），用于异声识别；o.idx 为块内亚采样索引
    for (const o of onsets) {
      o.centroid = spectralCentroid(samples, this.fs, o.idx,
        Math.round(0.004 * this.fs), CENTROID_FREQS);
    }
    this.diagnostics.envelope = envelope;
    this.diagnostics.filtered = filtered;
    this.diagnostics.lastChunkOnsets = onsets.length;

    for (const o of onsets) {
      this.onsets.push(o);
      if (this.state === 'acquiring') this._acquire(o);
      else this._track(o);
    }
    this.processedSamples += samples.length;
    if (this.state === 'locked') {
      this._pruneOld();
      this._learnClusters();
      this._checkHealth();
    }
    return this.getMetrics();
  }

  /* ---------------- 阶段 1：捕获拍周期与相位 ---------------- */

  _acquire(o) {
    const span = this.onsets.length ? o.t - this.onsets.all[0].t : 0;
    if (span < this.acquireSec) return;
    const list = this.onsets.all;
    const scored = BPH_CANDIDATES.map((bph) => {
      const B = 3600 / bph;
      const score = this._scorePeriod(list, B);
      const combined = score.sharpness * 0.6 + score.peakScore * 0.2 + score.coverage * 0.2;
      return { bph, B, combined, ...score };
    });
    // 真周期的自相关锐度最高（分频/倍频都会摊薄锐度）。
    // 若锐度最高者显著领先（>0.05），直接采用；否则在锐度接近的候选中用综合分。
    const bySharp = scored.slice().sort((a, b) => b.sharpness - a.sharpness);
    let best;
    if (bySharp[0].sharpness - bySharp[1].sharpness > 0.03) best = bySharp[0];
    else best = scored.reduce((p, c) => (c.combined > p.combined ? c : p));
    if (best && best.coverage >= 0.45 && best.sharpness >= 0.15 &&
        best.anchored >= 12) {
      // 线性回归精修 B 与初始锚点：t = anchor + k·B
      const fit = this._refinePeriod(list, best.B);
      if (fit) {
        this.B = fit.B; this.anchor = fit.anchor; this.anchorK = fit.k0;
        this.state = 'locked';
        this.beats.clear();
        for (const on of list) this._assignToGrid(on, true);
        this._learnClusters();
        this._alignPhase(list);
      }
    }
  }

  /**
   * 相位对齐：把锚点平移到冲击簇（最强、位于平衡点）的中位偏移，使 impulse 对准 off=0。
   * 冲击声由强度可靠识别，不受左右摆偏振影响。平移后重建拍与簇。
   */
  _alignPhase(list) {
    if (!this.clusters || this.clusters.length < 2) return;
    let imp = this.clusters.find((c) => c.type === 'impulse');
    if (!imp) {
      // 两簇表：取两簇中点
      const s = this.clusters.slice().sort((a, b) => a.offMed - b.offMed);
      imp = { offMed: (s[0].offMed + s[1].offMed) / 2 };
    }
    const mid = imp.offMed;
    if (Math.abs(mid) < 0.05) return;               // 已对齐
    this.anchor += mid / 1000;
    this.beats.clear();
    for (const on of list) this._assignToGrid(on, true);
    this._learnClusters();
  }

  /**
   * 周期评分（抗倍频/分频、抗假阳性）。主判别量 = 折叠相位直方图的圆形自相关锐度：
   * 真表三个子声在每个拍周期固定相位重复 → 正确 B 的相位分布聚成 3 个尖簇，
   * 零滞后自相关锐度最高；2B 叠入两个真实拍→6 个更窄峰、B/2 使子声跨拍错位→分布摊平，
   * 二者锐度都下降。假阳性相位随机，只贡献平坦本底，不抬高锐度。
   */
  _scorePeriod(list, B) {
    const tol = B * 0.49;
    let anchored = 0;
    const beatsSeen = new Map();
    const NB = 48;
    const hist = new Array(NB).fill(0);
    const valid = list.filter((o) => isFinite(o.t));
    for (const o of valid) {
      const k = Math.round((o.t - valid[0].t) / B);
      const d = o.t - (valid[0].t + k * B);
      if (Math.abs(d) <= tol) {
        anchored++;
        beatsSeen.set(k, (beatsSeen.get(k) || 0) + 1);
        let bin = Math.floor((d / B + 0.5) * NB);
        bin = Math.max(0, Math.min(NB - 1, bin));
        hist[bin]++;
      }
    }
    const loads = [...beatsSeen.values()];
    const load = loads.length ? mean(loads) : 0;
    // 圆形自相关：零滞后峰 vs 非零滞后本底，归一到能量，量度相位集中度
    let acPeak = 0, acBg = 0;
    for (let shift = 0; shift < NB; shift++) {
      let acc = 0;
      for (let i = 0; i < NB; i++) acc += hist[i] * hist[(i + shift) % NB];
      if (shift === 0) acPeak = acc;
      else acBg += acc;
    }
    acBg /= (NB - 1);
    const energy = hist.reduce((s, v) => s + v * v, 0) || 1;
    const sharpness = acBg > 0 ? (acPeak - acBg) / energy : 0;
    // 显著峰数（辅助倍/分频判别）
    const pk = Math.max(1, ...hist);
    let peaks = 0;
    for (let i = 0; i < NB; i++) {
      if (hist[i] >= pk * 0.4 && hist[i] >= hist[(i + NB - 1) % NB] &&
          hist[i] >= hist[(i + 1) % NB]) peaks++;
    }
    const peakScore = peaks === 3 ? 1 : peaks > 3 ? Math.max(0, 1 - (peaks - 3) * 0.18) : Math.max(0, peaks / 3);
    return { coverage: anchored / valid.length, sharpness, peakScore, peaks, load, anchored };
  }

  /** 对锚定的起振点做稳健线性回归，精修 B。
   *  每拍取最接近网格中心的起振点（冲击声，位于平衡点）作为代表，
   *  避免开锁/落下子声的非对称残差使斜率有偏；再用迭代剔异点稳健化。 */
  _refinePeriod(list, B0) {
    const tol = B0 * 0.49;
    const tBase = list[0].t;
    // 按拍号分组，每拍保留残差绝对值最小的点作为锚点
    const byBeat = new Map();
    for (const o of list) {
      if (!isFinite(o.t)) continue;
      const k = Math.round((o.t - tBase) / B0);
      const d = o.t - (tBase + k * B0);
      if (Math.abs(d) <= tol) {
        const cur = byBeat.get(k);
        if (!cur || Math.abs(d) < Math.abs(cur.d)) byBeat.set(k, { k, t: o.t, d });
      }
    }
    let pts = [...byBeat.values()];
    if (pts.length < 8) return null;
    for (let iter = 0; iter < 3; iter++) {
      // OLS: t = a + B·k
      const n = pts.length;
      let sk = 0, st = 0, skk = 0, skt = 0;
      for (const p of pts) { sk += p.k; st += p.t; skk += p.k * p.k; skt += p.k * p.t; }
      const det = n * skk - sk * sk;
      if (det === 0) return null;
      const B = (n * skt - sk * st) / det;
      const a = (st - B * sk) / n;
      const resid = pts.map((p) => p.t - (a + B * p.k));
      const med = median(resid);
      const m = mad(resid, med);
      const cut = Math.max(tol * 0.5, 4 * Math.max(m, 1e-5));
      const next = pts.filter((p, i) => Math.abs(resid[i] - med) <= cut);
      if (next.length === pts.length || next.length < 8) {
        return { B, anchor: a, k0: 0 };
      }
      pts = next;
    }
    return null;
  }

  /* ---------------- 阶段 2：锁相环跟踪 ---------------- */

  _track(o) {
    this._assignToGrid(o);
    // B 的精修交给 _rate() 对全量冲击锚点做 OLS；这里只做温和的慢跟踪，
    // 用网格间隔（恒等于 B）保持稳定，不引入包络峰值延迟偏差。
    // 漂移由周期性重新捕获（_checkHealth）兜底。
  }

  _assignToGrid(o, bulk = false) {
    const k = Math.round((o.t - this.anchor) / this.B) + this.anchorK;
    const tGrid = this.anchor + (k - this.anchorK) * this.B;
    const d = o.t - tGrid;
    // 窗口覆盖开锁/冲击/落下三子声（理论占 B 的约 ±30%）；窗外才是异声
    const tol = this.B * 0.49;
    // 音色门控：擒纵子声质心高（清脆，实测 >3000Hz），日历/陀飞轮闷响质心低。
    // 低质心起振点即使落在拍窗口内也是异声，不得当作擒纵子声。
    if ((o.centroid || 0) > 0 && o.centroid < this.lowCentroidHz) {
      this.rejected.push({ t: o.t, centroid: o.centroid, strength: o.strength, reason: 'timbre' });
      return;
    }
    let beat = this.beats.all.find((b) => b.k === k);
    if (!beat) {
      beat = { k, t: tGrid, slots: [], residualMs: null };
      this.beats.push(beat);
      // 维持拍号大致连续，更新锚点到最新拍（批量重分配时不更新，避免锚点跳变）
      if (!bulk && k > this.anchorK + 32) { this.anchor = tGrid; this.anchorK = k; }
    }
    if (Math.abs(d) <= tol) {
      beat.slots.push({ t: o.t, onset: o, offMs: d * 1000, centroid: o.centroid });
      beat.residualMs = d * 1000;
    } else {
      // 不在任何拍网格容差内 → 候选异声
      this.rejected.push({ t: o.t, centroid: o.centroid, strength: o.strength, reason: 'off-grid' });
    }
  }

  _pruneOld() {
    const cutoff = this.processedSamples / this.fs - this.historySec;
    while (this.beats.length && this.beats.all[0].t < cutoff) this.beats.all.shift();
    while (this.rejected.length && this.rejected.all[0].t < cutoff) this.rejected.all.shift();
  }

  _checkHealth() {
    const beats = this.beats.all;
    if (beats.length < 16) return;
    const recent = beats.slice(-40);
    const covered = recent.filter((b) => b.slots.length > 0).length;
    const coverage = covered / recent.length;
    this.lockStats.coverage = coverage;
    if (coverage < 0.5) {
      // 网格跟丢 → 回到捕获态，用最近的起振点重新锁定
      this.state = 'acquiring';
      this.B = null; this.anchor = null; this.clusters = null;
      const recentOnsets = this.onsets.all.filter((o) =>
        o.t > this.processedSamples / this.fs - this.acquireSec - 1);
      this.onsets = new RingBuffer(this.onsets.cap);
      for (const o of recentOnsets) this.onsets.push(o);
      this.lockStats.lastReacquire = this.processedSamples / this.fs;
    }
  }

  /* ---------------- 阶段 3：三子声聚类与异声识别 ---------------- */

  _learnClusters() {
    const beats = this.beats.all;
    if (beats.length < 10) return;
    const recent = beats.slice(-120);
    // 收集每个槽位（拍内偏移 ms），保留强度用于子声物理判别
    const slots = [];
    for (const b of recent) for (const s of b.slots) slots.push(s);
    if (slots.length < 12) return;
    const sortedSlots = slots.slice().sort((a, b) => a.offMs - b.offMs);
    const gap = this.clusterGapMs;
    // 1D 有序聚类：相邻间隙 > gap 即切分（按槽位对象切，不丢强度）
    const groups = [[sortedSlots[0]]];
    for (let i = 1; i < sortedSlots.length; i++) {
      if (sortedSlots[i].offMs - sortedSlots[i - 1].offMs > gap) groups.push([sortedSlots[i]]);
      else groups[groups.length - 1].push(sortedSlots[i]);
    }
    let clusters = groups
      .map((g) => ({
        offMed: median(g.map((s) => s.offMs)),
        offMad: mad(g.map((s) => s.offMs)),
        strength: median(g.map((s) => s.onset.strength || 0)),
        n: g.length,
      }))
      .filter((c) => c.n / slots.length >= this.minClusterSupport)
      .sort((a, b) => a.offMed - b.offMed);
    if (clusters.length < 2) return;
    if (clusters.length > 3) {
      // 合并最接近的两个簇直到 3 个
      while (clusters.length > 3) {
        let mi = 0;
        for (let i = 1; i < clusters.length - 1; i++) {
          if (clusters[i + 1].offMed - clusters[i].offMed <
            clusters[mi + 1].offMed - clusters[mi].offMed) mi = i;
        }
        const merged = {
          offMed: (clusters[mi].offMed * clusters[mi].n + clusters[mi + 1].offMed * clusters[mi + 1].n)
            / (clusters[mi].n + clusters[mi + 1].n),
          offMad: clusters[mi].offMad + clusters[mi + 1].offMad,
          strength: Math.max(clusters[mi].strength, clusters[mi + 1].strength),
          n: clusters[mi].n + clusters[mi + 1].n,
        };
        clusters.splice(mi, 2, merged);
      }
    }
    this._labelClusters(clusters);
    // 每簇的典型音色
    for (const c of clusters) {
      const cents = [];
      for (const s of slots) if (Math.abs(s.offMs - c.offMed) <= gap) cents.push(s.centroid || 0);
      c.centroid = cents.length ? median(cents) : 0;
      c.support = c.n / slots.length;
    }
    this.clusters = clusters;

    // 异声定性：被拒事件按音色/规律分类（日历=低频闷响串，陀飞轮=准周期轻响，磕碰=随机）
    this._classifyRejected();
  }

  /**
   * 子声物理标签。擒纵三子声中冲击声（impulse）能量最强且位于平衡点附近；
   * 开锁/落下分居平衡点两侧且时间近似对称。
   *  - 3 簇：最强簇 → impulse；其左 → unlock，其右 → drop。
   *  - 2 簇：开锁与冲击常合并，按强度/位置标 unlock、drop（平衡点取两簇中点）。
   */
  _labelClusters(clusters) {
    if (clusters.length === 3) {
      // 冲击声能量最强；强度与最强簇接近（>85%）时改取居中簇（位置先验）
      let impIdx = 0;
      for (let i = 1; i < 3; i++) if (clusters[i].strength > clusters[impIdx].strength) impIdx = i;
      if (impIdx !== 1 && clusters[1].strength / clusters[impIdx].strength > 0.85) impIdx = 1;
      for (let i = 0; i < 3; i++) {
        if (i === impIdx) clusters[i].type = 'impulse';
        else clusters[i].type = i < impIdx ? 'unlock' : 'drop';
      }
    } else {
      // 两簇：开锁（含冲击）与落下
      clusters[0].type = 'unlock'; clusters[1].type = 'drop';
    }
  }

  _classifyRejected() {
    const rej = this.rejected.all;
    if (rej.length < 2) return;
    const recent = rej.slice(-60);
    // 陀飞轮：间隔变异系数小的准周期序列
    const ts = recent.map((r) => r.t).sort((a, b) => a - b);
    const ints = [];
    for (let i = 1; i < ts.length; i++) ints.push(ts[i] - ts[i - 1]);
    for (const r of recent) {
      if (r.label) continue;
      const lowCentroid = (r.centroid || 9999) < this.lowCentroidHz;
      if (lowCentroid) r.label = 'calendar';
      else if (ints.length >= 4 && mad(ints) / median(ints) < 0.18) r.label = 'tourbillon';
      else r.label = 'external';
    }
  }

  /* ---------------- 指标计算 ---------------- */

  /**
   * 偏振（ms）：偶数拍与奇数拍冲击声相对公共网格的偏移之差。
   * 无偏振时左右摆动对称、两类拍冲击都落在平衡点；偏振使奇数拍整体平移。
   * 两簇表（冲击并入开锁簇）时，用每拍最接近网格中心的槽代替冲击槽。
   */
  _beatError() {
    if (!this.clusters) return { ms: null, polarity: null };
    const imp = this.clusters.find((c) => c.type === 'impulse');
    const refOff = imp ? imp.offMed : median(this.clusters.map((c) => c.offMed));
    const even = [], odd = [];
    for (const b of this.beats.all) {
      let s = null;
      if (imp) {
        s = b.slots.find((x) => Math.abs(x.offMs - refOff) <= this.clusterGapMs);
      } else if (b.slots.length) {
        // 两簇表：取最接近参考点的槽
        s = b.slots.reduce((p, c) => (Math.abs(c.offMs - refOff) < Math.abs(p.offMs - refOff) ? c : p));
      }
      if (!s) continue;
      (b.k % 2 === 0 ? even : odd).push(s.offMs);
    }
    if (even.length < 5 || odd.length < 5) return { ms: null, polarity: null };
    const dEven = median(even), dOdd = median(odd);
    const be = dOdd - dEven;
    return {
      ms: Math.abs(be),
      signedMs: be,
      polarity: be >= 0 ? '奇数拍偏晚（右摆）' : '偶数拍偏晚（左摆）',
      n: even.length + odd.length,
    }
  }

  /** 取一个拍的冲击锚点槽：优先匹配冲击簇，否则取最接近网格中心的槽 */
  _impulseSlot(b) {
    if (this.clusters) {
      const imp = this.clusters.find((c) => c.type === 'impulse');
      if (imp) {
        const m = b.slots.find((s) => Math.abs(s.offMs - imp.offMed) <= this.clusterGapMs);
        if (m) return m;
      }
    }
    return b.slots.reduce((p, c) => (Math.abs(c.offMs) < Math.abs(p.offMs) ? c : p));
  }

  /**
   * 摆幅（度）：升角模型。擒纵一轮含两个半周期（两次反向摆动）。
   * 一次摆动的升角经历"入摆开锁 → 平衡点冲击 → 出摆落下"，故每个方向的摆幅
   * 由它自己那一侧的开锁与落下决定，不能把相邻两次摆动的子声混在同一拍号里。
   * 约定（与合成器 amplitudeDeg=[偶,奇] 对应）：
   *   偶方向 = 偶拍落下(正偏移) 与 奇拍开锁(负偏移) 的时间量；
   *   奇方向 = 奇拍落下(正偏移) 与 偶拍开锁(负偏移) 的时间量。
   */
  _amplitude() {
    if (!this.clusters) return { deg: null, left: null, right: null, confidence: 0 };
    const imp = this.clusters.find((c) => c.type === 'impulse');
    const unlock = this.clusters.find((c) => c.type === 'unlock');
    const drop = this.clusters.find((c) => c.type === 'drop');
    if (!unlock || !drop) return { deg: null, left: null, right: null, confidence: 0 };
    const impOff = imp ? imp.offMed : (unlock.offMed + drop.offMed) / 2;
    // 按奇偶拍分别收集开锁(负)与落下(正)相对平衡点的时间量
    const u = { 0: [], 1: [] }, d = { 0: [], 1: [] };
    for (const b of this.beats.all) {
      const parity = Math.abs(b.k % 2);
      for (const s of b.slots) {
        if (s.offMs < impOff - 2) u[parity].push(Math.abs(impOff - s.offMs) / 1000);
        else if (s.offMs > impOff + 2) d[parity].push(Math.abs(s.offMs - impOff) / 1000);
      }
    }
    // 偶方向：偶拍落下 d[0] + 奇拍开锁 u[1]；奇方向：奇拍落下 d[1] + 偶拍开锁 u[0]
    const side = (a, c) => {
      const have = [...a, ...c].filter((v) => v != null && isFinite(v));
      if (have.length < 5) return null;
      return this._amplitudeFromDelta(median(have));
    };
    const left = side(d[0], u[1]);    // 偶方向（合成器 amplitudeDeg[0]）
    const right = side(d[1], u[0]);   // 奇方向（合成器 amplitudeDeg[1]）
    const vals = [left, right].filter((v) => v != null && isFinite(v));
    return {
      left, right,
      deg: vals.length ? mean(vals) : null,
      confidence: vals.length / 2,
      twoCluster: !imp,
    };
  }

  _amplitudeFromDelta(dtSec) {
    const beta = this.liftAngleDeg * Math.PI / 180;
    // 与合成器同一几何：sin(ωδ)=sinβ/|sinA|，ωδ=π·dt/B → |sinA|=sinβ/sin(ωδ)
    const sinWd = Math.sin(Math.PI * clamp(dtSec / this.B, 0.02, 0.499));
    const sinA = Math.sin(beta) / sinWd;
    // 高摆幅分支（机械表常见 270–330°）：|sinA|=sin(360°−A)
    const A = 360 - Math.asin(clamp(sinA, 0, 1)) * 180 / Math.PI;
    return clamp(A, this.liftAngleDeg + 1, 359.9);
  }

  /** 对冲击锚点 (k, t) 做 OLS 求斜率 B：t = a + B·k。比首末跨度抗端点抖动。 */
  _olsBeatPeriod(pts) {
    const n = pts.length;
    if (n < 2) return null;
    let sk = 0, st = 0, skk = 0, skt = 0;
    for (const p of pts) { sk += p.k; st += p.t; skk += p.k * p.k; skt += p.k * p.t; }
    const det = n * skk - sk * sk;
    if (det === 0) return null;
    return (n * skt - sk * st) / det;
  }

  /**
   * 在标称摆频对应的 B0 附近做细网格搜索，最小化起振点到网格的圆形相位残差。
   * 残差用 wrap 到 [-B/2, B/2) 的相位，故不会因 B 变小而天然偏好分频。
   * 供摆幅调制（陀飞轮）等簇位置涂抹、PLL 初始 B 有偏的场景独立校正。
   */
  _refineBByGridSearch(nominalBph, times = null) {
    const ts = times ?? this.onsets.all.map((o) => o.t).filter(isFinite);
    if (ts.length < 16) return null;
    const B0 = 3600 / nominalBph;
    const wrap = (d, B) => {
      let w = d - Math.round(d / B) * B;
      if (w > B / 2) w -= B;
      if (w < -B / 2) w += B;
      return w;
    };
    const cost = (B) => {
      let ss = 0;
      for (const t of ts) {
        const w = wrap(t, B);
        ss += w * w;
      }
      return ss / ts.length;
    };
    let bestB = B0, bestC = cost(B0);
    // ±2% 范围、相对步长 2e-5（对应日差分辨率约 2 s/day 以内）
    for (let r = -0.02; r <= 0.0201; r += 0.0004) {
      const B = B0 * (1 + r);
      const c = cost(B);
      if (c < bestC) { bestC = c; bestB = B; }
    }
    return bestB;
  }

  /**
   * 取一个拍的平衡点时刻估计：把该拍所有子声时刻减去各自簇的标称偏移，
   * 对齐到平衡点后取中位。多子声平均显著降低单瞬态抖动，比单用冲击声更稳。
   */
  _equilibriumTime(b) {
    if (!this.clusters || b.slots.length === 0) return this._impulseSlot(b).t;
    const est = [];
    for (const s of b.slots) {
      // 最近簇即归属（拍内容差已保证槽属于本拍的某个子声簇）
      let nearest = null, nd = Infinity;
      for (const c of this.clusters) {
        const d = Math.abs(s.offMs - c.offMed);
        if (d < nd) { nd = d; nearest = c; }
      }
      if (nearest) est.push(s.t - nearest.offMed / 1000);
    }
    return est.length ? median(est) : this._impulseSlot(b).t;
  }

  /**
   * 日差（s/day）。对有效锚点做 OLS 求 B，但先按实际相邻间隔剔除缺拍：
   * 缺擒纵会使名义拍号 k 跳号，直接回归会高估 B。这里把间隔 >1.5B 的断点切开，
   * 只用最长连续段（或加权合并各连续段）做回归。
   * 两簇表（陀飞轮等摆幅调制使子声位置涂抹）改用每拍全部子声时刻的中位数，
   * 中位时刻对周期性 δ 调制一阶抵消，B 不被带偏。
   */
  _rate() {
    const beats = this.beats.all.filter((b) => b.slots.length > 0);
    if (beats.length < 8) return { perDay: null, livePerDay: null, bph: null, n: 0 };
    const nominalBph = this._nominalBphHint();
    // 调制分支仅在确有 2 个簇（无独立冲击簇）时启用；
    // 高密度表可能每拍只检出 1 个槽、聚不出簇，此时直接用 PLL 的 B（已足够准）
    const modulated = (this.clusters?.length === 2) &&
      !this.clusters.some((c) => c.type === 'impulse');
    let Bfit;
    if (!this.clusters || this.clusters.length === 0) {
      Bfit = this.B;
    } else if (modulated) {
      // 调制表：用每拍全部子声的中位时刻（一阶抵消 δ 调制）做独立网格搜索
      const medTimes = beats.map((b) => median(b.slots.map((s) => s.t)));
      Bfit = this._refineBByGridSearch(nominalBph, medTimes) ?? this.B;
    } else {
      const eq = beats.map((b) => ({ k: b.k, t: this._equilibriumTime(b) }));
      // 找最长连续段（相邻 k 差 1 且时间间隔 <1.5B）
      let bestSeg = [], cur = [eq[0]];
      for (let i = 1; i < eq.length; i++) {
        const gapOk = eq[i].k - eq[i - 1].k === 1 && (eq[i].t - eq[i - 1].t) < this.B * 1.5;
        if (gapOk) cur.push(eq[i]);
        else { if (cur.length > bestSeg.length) bestSeg = cur; cur = [eq[i]]; }
      }
      if (cur.length > bestSeg.length) bestSeg = cur;
      const seg = bestSeg.length >= 8 ? bestSeg : eq;
      // 连续段内重新编号 0..n-1，彻底消除缺拍拍号污染
      const pts = seg.map((p, i) => ({ k: i, t: p.t }));
      Bfit = this._olsBeatPeriod(pts) ?? this.B;
    }
    const bphInst = 3600 / Bfit;
    const perDay = (bphInst / nominalBph - 1) * 86400;
    const bphGrid = 3600 / this.B;
    // 最近 8 秒的快变读数（师傅拨快慢针时看这个）
    const now = this.processedSamples / this.fs;
    const liveBeats = beats.filter((b) => b.t > now - 8);
    let livePerDay = null;
    if (liveBeats.length >= 6) {
      const Blive = modulated
        ? this._refineBByGridSearch(nominalBph, liveBeats.map((b) => median(b.slots.map((s) => s.t))))
        : this._olsBeatPeriod(liveBeats.map((b) => ({ k: b.k, t: this._equilibriumTime(b) })));
      if (Blive) livePerDay = (3600 / Blive / nominalBph - 1) * 86400;
    }
    return {
      perDay, livePerDay,
      bph: bphGrid,
      bphMeasured: bphInst,
      nominalBph,
      n: beats.length,
      gridVsInstDiff: ((bphGrid / bphInst) - 1) * 86400,
    };
  }

  /** 由测得 B 反推最接近的标准摆频（18000/28800…），作为日差换算的标称基准 */
  _nominalBphHint() {
    const measured = 3600 / this.B;
    let best = BPH_CANDIDATES[0], bd = Infinity;
    for (const c of BPH_CANDIDATES) {
      const d = Math.abs(c - measured);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  /** 时序图数据：最近窗口内每拍的相对偏差（ms）与子声位置 */
  timingStrip(windowSec = 12) {
    const now = this.processedSamples / this.fs;
    const out = [];
    for (const b of this.beats.all) {
      if (b.t < now - windowSec) continue;
      out.push({
        k: b.k, t: b.t,
        parity: b.k % 2,
        slots: b.slots.map((s) => ({ offMs: s.offMs, centroid: s.centroid, strength: s.onset.strength })),
      });
    }
    return out;
  }

  /** 综合读数 */
  getMetrics() {
    const locked = this.state === 'locked' && this.beats.length >= 8;
    const rate = locked ? this._rate() : { perDay: null, livePerDay: null, bph: null, n: 0 };
    const be = locked ? this._beatError() : { ms: null };
    const amp = locked ? this._amplitude() : { deg: null, left: null, right: null, confidence: 0 };
    const beats = this.beats.all;
    const recent = beats.slice(-40);
    const coverage = recent.length
      ? recent.filter((b) => b.slots.length > 0).length / recent.length : 0;
    return {
      state: this.state,
      locked,
      elapsedSec: this.processedSamples / this.fs,
      bph: rate.bph,
      nominalBph: rate.nominalBph ?? null,
      ratePerDay: rate.perDay,
      liveRatePerDay: rate.livePerDay,
      beatErrorMs: be.ms,
      beatErrorPolarity: be.polarity ?? null,
      amplitudeDeg: amp.deg,
      amplitudeLeft: amp.left,
      amplitudeRight: amp.right,
      amplitudeConfidence: amp.confidence,
      twoClusterMode: amp.twoCluster ?? false,
      coverage,
      beatCount: beats.length,
      clusters: this.clusters ? this.clusters.map((c) => ({
        type: c.type, offMs: c.offMed, madMs: c.offMad, support: c.support, centroid: c.centroid,
      })) : [],
      rejected: this.rejected.all.slice(-24).map((r) => ({
        t: r.t, label: r.label || 'external', centroid: r.centroid,
      })),
      timingStrip: locked ? this.timingStrip() : [],
      diagnostics: this.diagnostics,
    };
  }
}
