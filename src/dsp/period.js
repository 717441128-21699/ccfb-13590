// 摆频识别与节拍网格跟踪。
// 思路（对标行业实现的分层结构）：
// 1. 用相邻起点间隔(IOI)的直方图找主峰，得到候选节拍周期；
// 2. 与标准摆频表核对，确认 18000/21600/25200/28800/36000 等；
// 3. 用相位网格把起点序列对齐到 t = t0 + k·P，漏拍补号、网格外冲击剔除。

export const STANDARD_BPH = [18000, 21600, 25200, 28800, 36000];

export function nominalBeatPeriodSec(bph) {
  return 3600 / bph; // 半周期（一次 tic 或 tac 的间隔）
}

export function balanceFrequencyHz(bph) {
  return bph / 7200; // 摆轮完整振荡频率
}

// IOI 直方图找周期。onsets 为秒级时间戳数组。
// 低 SNR 下噪声产生大量随机间隔，会稀释主峰；因此对每个 IOI 同时在 P、P/2、P/3
// 的候选 bin 投票（真拍间隔含漏拍导致的 2P、3P 倍频，噪声间隔不相干），
// 再用主峰附近 IOI 的中位数精修。返回 {period, score} 或 null。
export function estimatePeriodFromIOI(onsets, fs) {
  if (onsets.length < 8) return null;
  const ioi = [];
  for (let i = 1; i < onsets.length; i++) {
    const d = onsets[i] - onsets[i - 1];
    ioi.push(d);
  }
  const binMs = 0.5;
  const lo = 0.04, hi = 0.26;
  const nBins = Math.round((hi - lo) * 1000 / binMs);
  const hist = new Float64Array(nBins);
  const binOf = (d) => Math.round((d - lo) / (binMs / 1000));
  for (const d of ioi) {
    if (d < lo || d > hi) continue;
    // 直接间隔
    const b = binOf(d);
    if (b >= 0 && b < nBins) hist[b] += 1;
    // 倍频折叠：若 d≈2P 或 3P，给对应的 P/2、P/3 候选加权投票
    for (const div of [2, 3]) {
      const sub = d / div;
      if (sub >= lo && sub <= hi) {
        const sb = binOf(sub);
        if (sb >= 0 && sb < nBins) hist[sb] += 0.5 / div;
      }
    }
  }
  // 平滑直方图（3 点）
  const sm = new Float64Array(nBins);
  for (let i = 0; i < nBins; i++) {
    sm[i] = (hist[Math.max(0, i - 1)] + hist[i] + hist[Math.min(nBins - 1, i + 1)]) / 3;
  }
  let best = -1, bestV = 0;
  for (let i = 0; i < nBins; i++) {
    if (sm[i] > bestV) { bestV = sm[i]; best = i; }
  }
  if (best < 0 || bestV < 2.5) return null;
  const period = lo + (best + 0.5) * binMs / 1000;

  // 用主峰附近的实际 IOI（含 2P/3P 折叠后的值）中位数精修
  const nearby = [];
  for (const d of ioi) {
    if (Math.abs(d - period) < 2.5 * binMs / 1000) nearby.push(d);
    for (const div of [2, 3]) {
      if (Math.abs(d / div - period) < 2.5 * binMs / 1000) nearby.push(d / div);
    }
  }
  if (nearby.length >= 3) {
    nearby.sort((a, b) => a - b);
    const refined = nearby[nearby.length >> 1];
    return { period: refined, score: bestV / ioi.length };
  }
  return { period, score: bestV / ioi.length };
}

// 包络自相关周期估计（IOI 不可用时的后备，例如连续强干扰）。
export function estimatePeriodFromAutocorr(env, fs) {
  // 降采样到 4kHz 足够分辨节拍，且大幅降低计算量
  const targetFs = 4000;
  const step = Math.max(1, Math.round(fs / targetFs));
  const x = [];
  let mean = 0;
  for (let i = 0; i < env.length; i += step) { x.push(env[i]); mean += env[i]; }
  mean /= x.length;
  const n = x.length;
  if (n < targetFs * 2) return null;
  const lagLo = Math.round(targetFs * 0.04), lagHi = Math.round(targetFs * 0.26);
  let bestLag = -1, bestV = -Infinity;
  // 归一化自相关，逐 lag 计算
  for (let lag = lagLo; lag <= lagHi; lag++) {
    let s = 0, s0 = 0, s1 = 0;
    for (let i = 0; i + lag < n; i++) {
      const a = x[i] - mean, b = x[i + lag] - mean;
      s += a * b; s0 += a * a; s1 += b * b;
    }
    const r = s / Math.max(Math.sqrt(s0 * s1), 1e-12);
    if (r > bestV) { bestV = r; bestLag = lag; }
  }
  if (bestV < 0.12) return null;
  return { period: bestLag / targetFs, score: bestV };
}

// 匹配标准摆频。容差 3%（超出则返回 null，由调用方决定是否按非标频率继续）。
export function matchStandardBph(periodSec) {
  let best = null, bestErr = Infinity;
  for (const bph of STANDARD_BPH) {
    const nominal = nominalBeatPeriodSec(bph);
    const err = Math.abs(periodSec - nominal) / nominal;
    if (err < bestErr) { bestErr = err; best = bph; }
  }
  if (bestErr <= 0.03) return { bph: best, error: bestErr };
  return { bph: Math.round(3600 / periodSec), error: bestErr, nonStandard: true };
}

// 把起点序列对齐到节拍网格。
// 输入: onsets(秒)、估计周期 P(秒)、容差 tolSec
// 输出: [{t, k, residual}]，网格外的点标记 offGrid=true 但仍返回（供质量统计）。
export function fitBeatGrid(onsets, period, tolSec) {
  if (!onsets.length) return { t0: 0, period, beats: [], offGrid: [] };
  // t0：对每个候选起点尝试作为 k=0，取残差中位数最小者
  let bestT0 = onsets[0], bestMed = Infinity;
  const trialCount = Math.min(onsets.length, 24);
  for (let tr = 0; tr < trialCount; tr++) {
    const t0cand = onsets[tr];
    const res = [];
    for (const t of onsets) {
      const k = Math.round((t - t0cand) / period);
      res.push(Math.abs(t - (t0cand + k * period)));
    }
    res.sort((a, b) => a - b);
    const med = res[res.length >> 1];
    if (med < bestMed) { bestMed = med; bestT0 = t0cand; }
  }
  const beats = [];
  const offGrid = [];
  for (const t of onsets) {
    const k = Math.round((t - bestT0) / period);
    const expected = bestT0 + k * period;
    const residual = t - expected;
    const rec = { t, k, residual };
    if (Math.abs(residual) <= tolSec) beats.push(rec);
    else offGrid.push(rec);
  }
  beats.sort((a, b) => a.k - b.k);
  return { t0: bestT0, period, beats, offGrid };
}

// 稳健线性回归 t = a + P·k + c·(-1)^k（含奇偶不对称项，即偏振来源）。
// 输入 beats: [{t, k}]。返回 {intercept, period, parityMs, sigmaSec, n}。
export function fitParityLine(beats) {
  const n = beats.length;
  if (n < 6) return null;
  // 迭代加权：先普通最小二乘，再按残差 MAD 剔除 >3σ 的点，最多迭代 4 次
  let keep = beats.map((_, i) => i);
  let result = null;
  for (let iter = 0; iter < 4; iter++) {
    const m = keep.length;
    if (m < 6) break;
    // 正规方程 X'X，列: 1, k, (-1)^k
    let Sxx = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    let Xty = [0, 0, 0];
    for (const idx of keep) {
      const { t, k } = beats[idx];
      const p = (k & 1) ? -1 : 1;
      const row = [1, k, p];
      for (let i = 0; i < 3; i++) {
        Xty[i] += row[i] * t;
        for (let j = 0; j < 3; j++) Sxx[i][j] += row[i] * row[j];
      }
    }
    const coef = solve3(Sxx, Xty);
    if (!coef) break;
    const resid = keep.map((idx) => {
      const { t, k } = beats[idx];
      const p = (k & 1) ? -1 : 1;
      return t - (coef[0] + coef[1] * k + coef[2] * p);
    });
    const sorted = Float64Array.from(resid.map(Math.abs)).sort();
    const med = sorted[sorted.length >> 1];
    const sigma = 1.4826 * med;
    result = { intercept: coef[0], period: coef[1], paritySec: coef[2], sigmaSec: sigma, n: m };
    if (sigma < 1e-7) break;
    const next = [];
    for (let i = 0; i < keep.length; i++) {
      if (Math.abs(resid[i]) <= 3 * sigma) next.push(keep[i]);
    }
    if (next.length === keep.length) break;
    keep = next;
  }
  return result;
}

// 3x3 高斯消元（带部分主元）
function solve3(A, b) {
  const M = [
    [A[0][0], A[0][1], A[0][2], b[0]],
    [A[1][0], A[1][1], A[1][2], b[1]],
    [A[2][0], A[2][1], A[2][2], b[2]],
  ];
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-15) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c < 4; c++) M[r][c] -= f * M[col][c];
    }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}
