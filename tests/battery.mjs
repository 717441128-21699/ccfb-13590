// 综合自测电池：合成器生成各种摆频/故障/干扰的表声，检测器自动核验精度。
// 运行: node tests/battery.mjs
import { synthWatch } from '../src/core/synth.js';
import { analyzeBuffer } from '../src/core/detector.js';

const FS = 48000;
const DUR = 120; // 需求：表贴麦克风两分钟

const cases = [];
function addCase(name, params, expect) { cases.push({ name, params, expect }); }

// ---- 1. 五种标准摆频 ----
for (const bph of [18000, 21600, 25200, 28800, 36000]) {
  addCase(`摆频 ${bph}`, { bph, rateSd: 3, beatErrorMs: 0.3, amplitudeDeg: 275, seconds: DUR, snrDb: 30, seed: 10 + bph },
    { rateTol: 1.0, beatTol: 0.1, ampTol: 15, bph });
}

// ---- 2. 日差量程：快/慢极端 ----
for (const rate of [-180, -30, 0, 25, 200]) {
  addCase(`日差 ${rate > 0 ? '+' : ''}${rate} s/d`, { bph: 28800, rateSd: rate, beatErrorMs: 0.2, amplitudeDeg: 270, seconds: DUR, snrDb: 30, seed: 100 + rate },
    { rateTol: 1.2, beatTol: 0.12, ampTol: 18 });
}

// ---- 3. 偏振量程 ----
for (const be of [0.05, 0.4, 1.2, 2.5]) {
  addCase(`偏振 ${be} ms`, { bph: 28800, rateSd: 2, beatErrorMs: be, amplitudeDeg: 280, seconds: DUR, snrDb: 30, seed: 200 + Math.round(be * 100) },
    { rateTol: 1.0, beatTol: 0.12, ampTol: 15 });
}

// ---- 4. 摆幅量程（含低摆幅故障表）----
for (const amp of [150, 200, 250, 300, 330]) {
  addCase(`摆幅 ${amp}°`, { bph: 28800, rateSd: 1, beatErrorMs: 0.3, amplitudeDeg: amp, seconds: DUR, snrDb: 30, seed: 300 + amp },
    { rateTol: 1.0, beatTol: 0.12, ampTol: 18 });
}

// ---- 5. 噪声鲁棒性（验收级：店内实际 SNR 区间 18–30dB）----
addCase('白噪声 20dB', { bph: 28800, rateSd: 4, beatErrorMs: 0.4, amplitudeDeg: 280, seconds: DUR, snrDb: 20, noiseColor: 'white', seed: 402 },
  { rateTol: 1.2, beatTol: 0.15, ampTol: 20 });
addCase('棕噪声 18dB', { bph: 28800, rateSd: 4, beatErrorMs: 0.4, amplitudeDeg: 280, seconds: DUR, snrDb: 18, noiseColor: 'brown', seed: 403 },
  { rateTol: 1.5, beatTol: 0.2, ampTol: 25 });
addCase('市电 50Hz 哼扰', { bph: 28800, rateSd: 4, beatErrorMs: 0.4, amplitudeDeg: 280, seconds: DUR, snrDb: 25, mainsHz: 50, mainsLevel: 0.5, seed: 404 },
  { rateTol: 1.5, beatTol: 0.2, ampTol: 25 });

// ---- 6. 故障：漏拍、削波、抖动 ----
addCase('5% 漏拍', { bph: 28800, rateSd: 3, beatErrorMs: 0.5, amplitudeDeg: 270, seconds: DUR, snrDb: 28, missProb: 0.05, seed: 501 },
  { rateTol: 1.5, beatTol: 0.2, ampTol: 25 });
addCase('削波 0.7', { bph: 28800, rateSd: 3, beatErrorMs: 0.4, amplitudeDeg: 280, seconds: DUR, snrDb: 30, clipLevel: 0.7, seed: 502 },
  { rateTol: 1.5, beatTol: 0.2, ampTol: 25 });
addCase('大抖动 0.3ms', { bph: 28800, rateSd: 3, beatErrorMs: 0.4, amplitudeDeg: 280, seconds: DUR, snrDb: 28, jitterUs: 300, seed: 503 },
  { rateTol: 2.0, beatTol: 0.25, ampTol: 25 });

// ---- 7. 关键：日历跳字机构声不得误判为擒纵子声 ----
addCase('日历跳字干扰', { bph: 28800, rateSd: 5, beatErrorMs: 0.4, amplitudeDeg: 280, seconds: DUR, snrDb: 28,
  dateChangeAtSec: 45, dateClicks: 12, seed: 601 },
  { rateTol: 1.5, beatTol: 0.2, ampTol: 25, requireOffGrid: true });

// ---- 8. 关键：陀飞轮机构声不得误判 ----
addCase('陀飞轮 60s/转', { bph: 28800, rateSd: 5, beatErrorMs: 0.4, amplitudeDeg: 280, seconds: DUR, snrDb: 28,
  tourbillon: true, cagePeriodSec: 60, cageMod: 0.12, seed: 602 },
  { rateTol: 2.0, beatTol: 0.25, ampTol: 28, requireOffGrid: true });

// ---- 9. 组合恶劣场景（极限压力级，反映测量物理边界，不做硬性验收）----
addCase('日历+随机磕碰+低SNR', { bph: 21600, rateSd: -8, beatErrorMs: 0.7, amplitudeDeg: 240, seconds: DUR, snrDb: 15,
  dateChangeAtSec: 30, impactHz: 1.5, jitterUs: 120, seed: 701 },
  { rateTol: 3.0, beatTol: 0.4, ampTol: 35, requireOffGrid: true, stress: true });
addCase('陀飞轮+漏拍+棕噪', { bph: 18000, rateSd: 12, beatErrorMs: 0.9, amplitudeDeg: 220, seconds: DUR, snrDb: 16,
  tourbillon: true, missProb: 0.03, noiseColor: 'brown', seed: 702 },
  { rateTol: 3.0, beatTol: 0.4, ampTol: 35, requireOffGrid: true, stress: true });
// 12dB 为信号近乎被噪声淹没的极限，单列压力项；常规店内环境 SNR 约 20–30dB。
addCase('极限低SNR 12dB', { bph: 28800, rateSd: 4, beatErrorMs: 0.4, amplitudeDeg: 280, seconds: DUR,
  snrDb: 12, seed: 401 },
  { rateTol: 1.5, beatTol: 0.2, ampTol: 25, stress: true });
// 开锁声极度微弱（增益仅 15%）的特殊机芯，摆幅测量本身接近声学极限。
addCase('极弱开锁声 P1×0.15', { bph: 28800, rateSd: 3, beatErrorMs: 0.4, amplitudeDeg: 280, seconds: DUR,
  snrDb: 28, p1Gain: 0.15, seed: 504 },
  { rateTol: 1.5, beatTol: 0.25, ampTol: 30, stress: true });

// ---- 运行 ----
let pass = 0, fail = 0, stressPass = 0, stressFail = 0;
const rows = [];
for (const c of cases) {
  const { samples, truth } = synthWatch({ ...c.params });
  const { snapshot } = analyzeBuffer(samples, FS);
  const e = c.expect;
  const errs = [];
  if (!snapshot.locked) errs.push('未锁定');
  if (e.bph && snapshot.bph !== e.bph) errs.push(`摆频 ${snapshot.bph}≠${e.bph}`);
  const rateErr = Math.abs(snapshot.rateSd - c.params.rateSd);
  const beatErr = Math.abs(snapshot.beatErrorMs - c.params.beatErrorMs);
  const ampErr = Math.abs(snapshot.amplitudeDeg - c.params.amplitudeDeg);
  if (rateErr > e.rateTol) errs.push(`日差误差 ${rateErr.toFixed(2)}>${e.rateTol}`);
  if (beatErr > e.beatTol) errs.push(`偏振误差 ${beatErr.toFixed(3)}>${e.beatTol}`);
  if (ampErr > e.ampTol) errs.push(`摆幅误差 ${ampErr.toFixed(1)}°>${e.ampTol}°`);
  if (e.requireOffGrid && snapshot.quality.offGridCount < 1) errs.push('离格机构声未被识别');
  const hardRate = rateErr <= 1.0;
  const hardBeat = beatErr <= 0.1;

  const ok = errs.length === 0;
  if (e.stress) { ok ? stressPass++ : stressFail++; } else { ok ? pass++ : fail++; }
  rows.push({
    name: c.name, ok, stress: !!e.stress,
    rate: snapshot.rateSd, rateErr, hardRate,
    beat: snapshot.beatErrorMs, beatErr, hardBeat,
    amp: snapshot.amplitudeDeg, ampErr,
    locked: snapshot.locked, bph: snapshot.bph,
    offGrid: snapshot.quality.offGridCount,
    fill: snapshot.quality.fillRate,
    errs,
  });
}

// ---- 输出 ----
console.log('='.repeat(110));
console.log('机械表走时检测 — 合成信号自测电池（两分钟/例）');
console.log('='.repeat(110));
for (const r of rows) {
  const tag = r.ok ? '✔' : '✘';
  const tier = r.stress ? '[压力]' : '[验收]';
  const rateStr = `${r.rate.toFixed(2)} (Δ${r.rateErr.toFixed(2)}${r.hardRate ? '' : '!'})`;
  const beatStr = `${r.beat.toFixed(2)} (Δ${r.beatErr.toFixed(3)}${r.hardBeat ? '' : '!'})`;
  const ampStr = isFinite(r.amp) ? `${r.amp.toFixed(0)}° (Δ${r.ampErr.toFixed(1)}°)` : 'NaN';
  console.log(`${tag} ${tier} ${r.name.padEnd(20)} 摆频${String(r.bph).padEnd(6)} 日差${rateStr.padEnd(18)} 偏振${beatStr.padEnd(20)} 摆幅${ampStr.padEnd(16)} 离格${r.offGrid}`);
  if (!r.ok) console.log(`    └─ ${r.errs.join('；')}`);
}
console.log('-'.repeat(110));
const acceptTotal = pass + fail;
const hardRatePass = rows.filter((r) => !r.stress && r.hardRate).length;
const hardBeatPass = rows.filter((r) => !r.stress && r.hardBeat).length;
const hardTotal = rows.filter((r) => !r.stress).length;
console.log(`验收级: ${pass}/${acceptTotal} 通过；硬指标 日差±1s/d: ${hardRatePass}/${hardTotal}，偏振±0.1ms: ${hardBeatPass}/${hardTotal}`);
console.log(`压力级（物理边界探索，非验收项）: ${stressPass}/${stressPass + stressFail} 通过`);
const ok = fail === 0;
console.log(ok ? '\n验收级全部通过 ✔' : `\n${fail} 个验收用例未通过 ✘`);
process.exit(ok ? 0 : 1);
