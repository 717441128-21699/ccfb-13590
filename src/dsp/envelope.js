// 包络提取、自适应噪声底与峰值/起点检测。
// 全部支持逐块流式调用，内部维护状态。

// 整流 + 一阶低通得到包络。攻击快、释放慢，适合短促冲击声。
export class EnvelopeFollower {
  constructor(fs, attackMs = 0.35, releaseMs = 6) {
    this.atk = Math.exp(-1 / (fs * attackMs / 1000));
    this.rel = Math.exp(-1 / (fs * releaseMs / 1000));
    this.e = 0;
  }

  reset() { this.e = 0; }

  step(x) {
    const v = x < 0 ? -x : x;
    const k = v > this.e ? this.atk : this.rel;
    this.e = (1 - k) * v + k * this.e;
    return this.e;
  }

  process(buf) {
    const out = new Float64Array(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = this.step(buf[i]);
    return out;
  }
}

// 滑动低分位噪声底估计（咔嗒占空比低，包络的 ~15% 分位贴近底噪）。
// 两级结构：20ms 桶内取最小值，再在约 400ms 的桶序列上取分位数，O(n) 无外部依赖。
export class RunningFloor {
  constructor(fs, windowMs = 400, quantile = 0.15) {
    this.bucketLen = Math.max(8, Math.round(fs * 0.02)); // 20ms 桶
    this.nbuckets = Math.max(8, Math.round(windowMs / 20));
    this.quantile = quantile;
    this.buckets = [];
    this.cur = [];
    this.curMin = Infinity;
    this.floor = 0;
  }

  reset() {
    this.buckets = []; this.cur = []; this.curMin = Infinity; this.floor = 0;
  }

  _pushBucket(minVal) {
    this.buckets.push(minVal);
    if (this.buckets.length > this.nbuckets) this.buckets.shift();
    const sorted = Float64Array.from(this.buckets).sort();
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * this.quantile));
    this.floor = sorted[idx];
  }

  step(v) {
    this.cur.push(v);
    if (v < this.curMin) this.curMin = v;
    if (this.cur.length >= this.bucketLen) {
      this._pushBucket(this.curMin);
      this.cur = []; this.curMin = Infinity;
    }
    return this.floor;
  }

  process(env) {
    const out = new Float64Array(env.length);
    for (let i = 0; i < env.length; i++) out[i] = this.step(env[i]);
    return out;
  }
}

// 局部峰值检测：高于阈值、大于左右邻域、两次峰值间隔不小于 refractory。
// 返回 [{index, height}]，index 为整数样本。
export function findPeaks(env, threshold, refractorySamples, from = 0) {
  const peaks = [];
  let lastPeak = -Infinity;
  for (let i = Math.max(1, from); i < env.length - 1; i++) {
    if (env[i] < threshold) continue;
    if (env[i] <= env[i - 1] || env[i] < env[i + 1]) continue;
    if (i - lastPeak < refractorySamples) {
      // 保留更强的那个
      if (peaks.length && env[i] > peaks[peaks.length - 1].height) {
        peaks[peaks.length - 1] = { index: i, height: env[i] };
        lastPeak = i;
      }
      continue;
    }
    peaks.push({ index: i, height: env[i] });
    lastPeak = i;
  }
  return peaks;
}

// 亚样本起点：从峰值沿包络回退到首次低于 floor + fraction*(peak-floor) 的位置，
// 再在相邻两点间线性插值。对应行业实现里的 "onset = 阈值穿越点而非峰值点"。
export function onsetFromPeak(env, peakIndex, floor, fraction = 0.12) {
  const peak = env[peakIndex];
  const level = floor + fraction * (peak - floor);
  let j = peakIndex;
  while (j > 0 && env[j] > level) j--;
  if (j <= 0 || j >= env.length - 1) return peakIndex;
  const v0 = env[j], v1 = env[j + 1];
  const frac = (level - v0) / Math.max(v1 - v0, 1e-12);
  return j + Math.min(1, Math.max(0, frac));
}

// 滑动中位数（用于稳健的周期/间隔估计）。窗口为奇数；简单排序实现，数据量小够用。
export function median(values) {
  if (!values.length) return NaN;
  const a = Float64Array.from(values).sort();
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// 中位数绝对偏差 → 稳健标准差
export function madSigma(values) {
  const med = median(values);
  const dev = Array.from(values, (v) => Math.abs(v - med));
  return 1.4826 * median(dev);
}

// 均值
export function mean(values) {
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}
