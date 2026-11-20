// 冒烟测试：合成一块"已知真值"的 28800 表声，验证检测链路能锁定并给出合理指标。
// 运行: node tests/smoke.mjs
import { synthWatch } from '../src/core/synth.js';
import { analyzeBuffer } from '../src/core/detector.js';

const { samples, truth } = synthWatch({
  bph: 28800, rateSd: 5, beatErrorMs: 0.4, amplitudeDeg: 280,
  liftAngleDeg: 52, seconds: 30, snrDb: 28, jitterUs: 50, seed: 7,
});

const { snapshot, ticks } = analyzeBuffer(samples, 48000);

console.log('真值:', {
  bph: truth.bph, rateSd: truth.rateSd, beatErrorMs: truth.beatErrorMs,
  amplitudeDeg: truth.amplitudeDeg, tLiftMs: truth.tLiftSec * 1000,
  beats: truth.k.length,
});
console.log('检测:', {
  locked: snapshot.locked,
  bph: snapshot.bph,
  rateSd: snapshot.rateSd?.toFixed(3),
  beatErrorMs: snapshot.beatErrorMs?.toFixed(3),
  amplitudeDeg: snapshot.amplitudeDeg?.toFixed(2),
  tLiftMs: snapshot.tLiftMs?.toFixed(3),
  ticks: ticks.length,
  fillRate: snapshot.quality.fillRate?.toFixed(3),
  snrDb: snapshot.quality.snrDb?.toFixed(1),
  p1Rate: snapshot.quality.p1DetectedRate?.toFixed(2),
});

const ok =
  snapshot.locked &&
  snapshot.bph === 28800 &&
  Math.abs(snapshot.rateSd - 5) < 1 &&
  Math.abs(snapshot.beatErrorMs - 0.4) < 0.15 &&
  Math.abs(snapshot.amplitudeDeg - 280) < 12 &&
  snapshot.quality.fillRate > 0.9;

console.log(ok ? '\nPASS ✔ 冒烟测试通过' : '\nFAIL ✘ 冒烟测试未达标');
process.exit(ok ? 0 : 1);
