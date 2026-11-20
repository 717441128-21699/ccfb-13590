// dsp.js — 机械表走时检测核心 DSP 工具库（纯 ES Module，无浏览器依赖）
// 包含：双二阶滤波、包络检波、自适应阈值起振点检测、抛物线亚采样细化、
// Goertzel 频谱特征、稳健统计量。分析器与 Node 自检共用本文件。

'use strict';

/* ---------------- 基础统计 ---------------- */

export function median(arr) {
  if (arr.length === 0) return NaN;
  const a = Array.from(arr).sort((x, y) => x - y);
  const h = (a.length - 1) >> 1;
  return a.length % 2 ? a[h] : (a[h] + a[h + 1]) * 0.5;
}

export function quantile(sortedAsc, q) {
  if (sortedAsc.length === 0) return NaN;
  const p = Math.min(0.999999, Math.max(0, q)) * (sortedAsc.length - 1);
  const i = Math.floor(p);
  const f = p - i;
  return i + 1 < sortedAsc.length ? sortedAsc[i] * (1 - f) + sortedAsc[i + 1] * f : sortedAsc[i];
}

/** 中位数绝对偏差（稳健离散度） */
export function mad(arr, med = median(arr)) {
  const dev = arr.map((v) => Math.abs(v - med));
  return median(dev);
}

export function mean(arr) {
  let s = 0;
  for (const v of arr) s += v;
  return arr.length ? s / arr.length : NaN;
}

/** 循环中位数：把角度/相位类数据绕 center 展开后取中位数，结果卷回 [center-W/2, center+W/2) */
export function circularMedian(arr, width, center = 0) {
  if (arr.length === 0) return NaN;
  const half = width / 2;
  const unwrapped = arr.map((v) => {
    let d = v - center;
    d = ((d + half) % width + width) % width - half;
    return center + d;
  });
  let m = median(unwrapped);
  // 卷回到 center 邻域
  let d = m - center;
  d = ((d + half) % width + width) % width - half;
  return center + d;
}

/* ---------------- RBJ 双二阶滤波器（Direct Form I） ---------------- */

export class Biquad {
  /** RBJ cookbook 带通（constant 0 dB peak gain） */
  static bandpass(fs, f0, q) {
    const w0 = (2 * Math.PI * f0) / fs;
    const cw = Math.cos(w0);
    const sw = Math.sin(w0);
    const alpha = sw / (2 * q);
    const b0 = alpha;
    const b1 = 0;
    const b2 = -alpha;
    const a0 = 1 + alpha;
    const a1 = -2 * cw;
    const a2 = 1 - alpha;
    return new Biquad(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);
  }

  /** 一阶高通（用于去桌面低频隆隆声） */
  static highpass(fs, fc) {
    const w = 2 * Math.PI * fc / fs;
    const a = Math.cos(w) / (1 + Math.cos(w));
    const b0 = (1 + Math.cos(w)) / 2;
    return new Biquad(b0, -b0, 0, -2 * a, 2 * a - 1);
  }

  constructor(b0, b1, b2, a1, a2) {
    this.b0 = b0; this.b1 = b1; this.b2 = b2; this.a1 = a1; this.a2 = a2;
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
  }

  reset() { this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; }

  process(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }

  /** 就地滤波一段信号 */
  filterInPlace(buf) {
    for (let i = 0; i < buf.length; i++) {
      const x = buf[i];
      const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1; this.x1 = x;
      this.y2 = this.y1; this.y1 = y;
      buf[i] = y;
    }
    return buf;
  }
}

/** 级联带通：在 [lowHz, highHz] 内放两个二阶节，兼顾陡度与瞬态响应 */
export function bandpassChain(fs, lowHz, highHz) {
  const f0 = Math.sqrt(lowHz * highHz);
  const q = f0 / (highHz - lowHz);
  return [Biquad.bandpass(fs, f0, Math.max(0.6, q * 0.72)), Biquad.bandpass(fs, f0, Math.max(0.6, q * 0.72))];
}

/* ---------------- 包络与起振点检测 ---------------- */

/**
 * 自适应阈值起振点检测
 * 流程：带通 → 全波整流 → 快时间常数低通得包络 → 滚动低百分位估噪底
 *       → 超阈局部极大值 → 不应期抑制 → 抛物线亚采样峰值细化
 * 返回 { t(秒,绝对时间), idx(亚采样位置), strength(峰值包络), floor(该处噪底) }
 */
export function detectOnsets(samples, fs, opts = {}) {
  const {
    lowHz = 900,
    highHz = 11000,
    envTauMs = 0.7,           // 包络平滑：压住噪声抖动，仍能保留 0.55ms 的弱子声
    refractoryMs = 2.0,       // 过阈段合并间隙（真实子声最近相距 ~25ms，2ms 只合并同一声的阈值线凹陷）
    floorTauMs = 300,         // 噪底慢平滑（只描述稳态噪声；瞬态占空比 <5% 不影响它）
    thresholdK = 2.4,         // 阈值 = 噪底慢均值 × K
    thresholdBias = 4.5e-3,   // 绝对地板（高于噪声包络 p99，压住假阳性；最弱子声峰 ~1.3e-2）
    warmupMs = 60,            // 首块跳过的启动瞬态时长
    timeOffset = 0,           // 本块起始的绝对时间
    filters = null,
    state = null,             // 跨块状态 { env, floor, warmupDone }，流式调用时传入同一对象
  } = opts;

  const n = samples.length;
  // 1) 带通（复制一份，避免污染原波形——UI 还要画原始波形）
  const x = new Float64Array(n);
  const chain = filters || bandpassChain(fs, lowHz, highHz);
  for (let i = 0; i < n; i++) {
    let v = samples[i];
    for (const bq of chain) v = bq.process(v);
    x[i] = v;
  }

  // 2) 整流 + 单极点平滑包络（状态可跨块保持）
  const alpha = 1 - Math.exp(-1 / (fs * envTauMs / 1000));
  const env = new Float64Array(n);
  let e = state ? state.env : 0;
  for (let i = 0; i < n; i++) {
    const r = Math.abs(x[i]);
    e += alpha * (r - e);
    env[i] = e;
  }
  if (state) state.env = e;

  // 3) 噪底慢跟踪：单极点平滑包络。瞬态占空比 <5%，对慢均值抬升有限；
  //    绝对地板保证极静段不产生噪声峰，K 倍数压住瞬态衰减拖尾。
  const aFloor = 1 - Math.exp(-1 / (fs * floorTauMs / 1000));
  const floor = new Float64Array(n);
  const thr = new Float64Array(n);
  let mu = state ? state.floor : thresholdBias;
  for (let i = 0; i < n; i++) {
    mu += aFloor * (env[i] - mu);
    floor[i] = mu;
    thr[i] = Math.max(mu * thresholdK, thresholdBias);
  }
  if (state) state.floor = mu;

  // 4) 过阈段分割（segmentation）：每个连续超阈区间只产生一个起振点，
  //    取区间内包络最大位置。瞬态衰减上的小抖动不会产生伪峰。
  //    段间若小于 refractory，合并为同一声（防止阈值线上的小凹陷切段）。
  const refractory = Math.round((refractoryMs / 1000) * fs);
  const warmup = (state && state.warmupDone) ? 0 : Math.round((warmupMs / 1000) * fs);
  if (state) state.warmupDone = true;
  const segments = [];
  let segStart = -1, segPeakIdx = -1, segPeakVal = 0;
  for (let i = warmup; i < n; i++) {
    if (env[i] > thr[i]) {
      if (segStart < 0) { segStart = i; segPeakIdx = i; segPeakVal = env[i]; }
      if (env[i] > segPeakVal) { segPeakVal = env[i]; segPeakIdx = i; }
    } else if (segStart >= 0) {
      if (segments.length && segStart - segments[segments.length - 1].end <= refractory) {
        const last = segments[segments.length - 1];
        last.end = i;
        if (segPeakVal > last.val) { last.val = segPeakVal; last.peak = segPeakIdx; }
      } else {
        segments.push({ start: segStart, end: i, peak: segPeakIdx, val: segPeakVal });
      }
      segStart = -1;
    }
  }
  if (segStart >= 0) segments.push({ start: segStart, end: n - 1, peak: segPeakIdx, val: segPeakVal });

  const onsets = segments.map((s) => {
    const p = Math.max(1, Math.min(n - 2, s.peak));   // 防块边界越界产生 NaN
    const y0 = env[p - 1], y1 = env[p], y2 = env[p + 1];
    const denom = y0 - 2 * y1 + y2;
    const shift = denom !== 0 ? 0.5 * (y0 - y2) / denom : 0;
    const refined = Math.min(p + 0.999, Math.max(p - 0.999, p + shift));
    // 过阈起点（线性插值到阈值穿越处）：时序测量用，对幅度/信噪比变化不敏感
    const st = Math.max(1, Math.min(n - 2, s.start));
    const frac = thr[st] > env[st - 1]
      ? (thr[st] - env[st - 1]) / Math.max(1e-12, env[st] - env[st - 1]) : 0;
    const onsetIdx = st - 1 + clamp(frac, 0, 1);
    return {
      idx: refined,
      onsetIdx,
      t: timeOffset + onsetIdx / fs,
      peakT: timeOffset + refined / fs,
      strength: s.val, floor: floor[p],
    };
  });
  return { onsets, envelope: env, filtered: x };
}

/* ---------------- Goertzel 单频幅度（起振点音色特征） ---------------- */

/** 对以 onset 为中心的一小段波形计算若干指定频率的幅度，用于子声分类 */
export function goertzelBins(samples, fs, centerIdx, halfWin, freqs) {
  const out = new Map();
  for (const f of freqs) {
    const w = 2 * Math.PI * f / fs;
    const cw = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    const lo = Math.max(1, Math.round(centerIdx - halfWin));
    const hi = Math.min(samples.length - 1, Math.round(centerIdx + halfWin));
    for (let i = lo; i <= hi; i++) {
      const s = samples[i] + cw * s1 - s2;
      s2 = s1; s1 = s;
    }
    out.set(f, Math.sqrt(s1 * s1 + s2 * s2 - cw * s1 * s2));
  }
  return out;
}

/** 谱质心（对数频率轴），区分"闷响"（日历/陀飞轮）与清脆擒纵声 */
export function spectralCentroid(samples, fs, centerIdx, halfWin, freqs) {
  const bins = goertzelBins(samples, fs, centerIdx, halfWin, freqs);
  let num = 0, den = 0;
  for (const [f, mag] of bins) {
    const w = mag * mag;
    num += Math.log(f) * w;
    den += w;
  }
  return den > 0 ? Math.exp(num / den) : 0;
}

/* ---------------- 缓冲工具 ---------------- */

/** 固定容量环形缓冲，保留最近 N 条记录（用数组+shift，N 量级在数千以内足够快） */
export class RingBuffer {
  constructor(capacity) {
    this.cap = capacity;
    this.buf = [];
  }
  push(item) {
    this.buf.push(item);
    if (this.buf.length > this.cap) this.buf.splice(0, this.buf.length - this.cap);
  }
  shift() { return this.buf.shift(); }
  get all() { return this.buf; }
  get length() { return this.buf.length; }
  clear() { this.buf.length = 0; }
}

export function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
