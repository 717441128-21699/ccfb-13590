// 拍内子声（P1/P2/P3）局部扫描。
// 与全局拍起点检测不同：这里在一个拍的物理升角时间窗内，用更低的阈值、
// 更短的不应期扫描包络局部峰，并对每个峰做亚样本起点插值。
// 输入为包络环形缓冲与全局时间轴上的窗边界，输出 [{tSec, height, onsetSec}]。

// envBuf: 慢包络线性视图（用于找峰/聚类）；rectBuf: 快速整流视图（用于亚样本起点）。
// bufBaseSample: 视图[0] 对应的全局样本号。
export function findLocalSubpeaks(envBuf, envFloor, bufBaseSample, fs, tLoSec, tHiSec, opts = {}) {
  const rectBuf = opts.rectBuf || envBuf; // 无整流信号时退回包络
  const iLo = Math.max(1, Math.round(tLoSec * fs) - bufBaseSample);
  const iHi = Math.min(envBuf.length - 2, Math.round(tHiSec * fs) - bufBaseSample);
  if (iHi <= iLo) return [];

  const floorFraction = opts.floorFraction ?? 0.15;
  const refractory = Math.max(2, Math.round(fs * (opts.refractoryMs ?? 0.3) / 1000));
  const relThreshold = opts.relThreshold ?? 0.12; // 弱 P1/P2 也要保住

  // 窗内噪声底取 floor 的中位数
  const floors = [];
  for (let i = iLo; i <= iHi; i++) floors.push(envFloor[i]);
  floors.sort((a, b) => a - b);
  const floorMed = floors[floors.length >> 1];

  // 找峰在"快速整流"上进行（慢包络在噪声下会填平 P1/P3 之间的谷），
  // 整流先做 3 点滑动平均去随机毛刺，再做局部峰检测。
  const sig = new Float64Array(rectBuf.length);
  sig[0] = rectBuf[0];
  for (let i = 1; i < rectBuf.length - 1; i++) {
    sig[i] = (rectBuf[i - 1] + rectBuf[i] + rectBuf[i + 1]) / 3;
  }
  sig[rectBuf.length - 1] = rectBuf[rectBuf.length - 1];

  // 整流基线：窗内 20% 分位（贴近噪声底，不被信号抬高）
  const sigSorted = Float64Array.from(sig.slice(iLo, iHi + 1)).sort();
  const sigBase = sigSorted[Math.floor(sigSorted.length * 0.2)];
  let sigMax = 0;
  for (let i = iLo; i <= iHi; i++) if (sig[i] > sigMax) sigMax = sig[i];
  const sigSpan = Math.max(sigMax - sigBase, 1e-12);

  // 第一遍：整流上的局部峰
  const raw = [];
  for (let i = iLo; i <= iHi; i++) {
    if (sig[i] <= sig[i - 1] || sig[i] < sig[i + 1]) continue;
    raw.push({ index: i, height: sig[i] });
  }
  // prominence 门限：峰须突出于整流动态范围的 15%
  const minProminence = sigBase + Math.max(relThreshold, 0.15) * sigSpan;

  // 第二遍：突出度门限 + 不应期合并
  const accepted = [];
  let lastIdx = -Infinity;
  for (const pk of raw) {
    if (pk.height < minProminence) continue;
    if (pk.index - lastIdx < refractory) {
      if (accepted.length && pk.height > accepted[accepted.length - 1].height) {
        accepted[accepted.length - 1] = pk;
        lastIdx = pk.index;
      }
      continue;
    }
    accepted.push(pk);
    lastIdx = pk.index;
  }

  // 第三遍：基于物理时间的簇合并。
  // 同一子声的振荡瓣间距实测 ~0.1–0.5ms；不同子声 P1→P2→P3 的间距 ≥ 最短升角窗
  // （36000 摆频下约 5.9ms）。取 2.2ms 为界，可干净区分"瓣"与"子声"。
  const splitGap = Math.round(fs * 0.0022);

  const groups = [];
  for (const pk of accepted) {
    const last = groups[groups.length - 1];
    if (last && pk.index - last.lastIndex < splitGap) {
      if (pk.height > last.height) last.height = pk.height;
      last.lastIndex = pk.index;
    } else {
      groups.push({ firstIndex: pk.index, lastIndex: pk.index, height: pk.height });
    }
  }

  // 整流信号的局部基线：取事件窗前 1ms 的整流中位数（避免慢包络 floor 不适用整流）
  const rectBaseIdx = Math.max(0, iLo - Math.round(fs * 0.001));
  const rectBase = medianSlice(rectBuf, rectBaseIdx, Math.min(rectBuf.length, iLo + 1));

  return groups.map((g) => {
    // 事件起点：在快速整流上，从组首峰回退到首次低于 基线+15%·峰高 的位置
    const onset = onsetOnRect(rectBuf, g.firstIndex, rectBase, 0.15);
    return {
      index: g.firstIndex,
      height: g.height,
      tSec: (bufBaseSample + g.firstIndex) / fs,
      onsetSec: (bufBaseSample + onset) / fs,
    };
  });
}

function medianSlice(buf, lo, hi) {
  const vals = [];
  for (let i = lo; i < hi; i++) vals.push(buf[i]);
  if (!vals.length) return 0;
  vals.sort((a, b) => a - b);
  return vals[vals.length >> 1];
}

// 快速整流上的亚样本起点
function onsetOnRect(rect, peakIndex, base, fraction) {
  const peak = rect[peakIndex];
  const level = base + fraction * (peak - base);
  let j = peakIndex;
  while (j > 0 && rect[j] > level) j--;
  if (j <= 0 || j >= rect.length - 1) return peakIndex;
  const frac = (level - rect[j]) / Math.max(rect[j + 1] - rect[j], 1e-12);
  return j + Math.min(1, Math.max(0, frac));
}

function onsetLocal(env, peakIndex, floor, fraction) {
  const peak = env[peakIndex];
  const level = floor + fraction * (peak - floor);
  let j = peakIndex;
  while (j > 0 && env[j] > level) j--;
  if (j <= 0 || j >= env.length - 1) return peakIndex;
  const frac = (level - env[j]) / Math.max(env[j + 1] - env[j], 1e-12);
  return j + Math.min(1, Math.max(0, frac));
}
