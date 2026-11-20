// e2e-check.mjs — 模拟网页 app 的流式投喂，逐场景验证输出可渲染
import { WatchSynth, SCENARIOS } from './js/synth.js';
import { WatchAnalyzer } from './js/analyzer.js';

const FS = 96000;
for (const [name, sc] of Object.entries(SCENARIOS)) {
  const synth = new WatchSynth({ sampleRate: FS, ...sc });
  const an = new WatchAnalyzer({ sampleRate: FS, liftAngleDeg: sc.liftAngleDeg ?? 52 });
  const chunk = FS / 2; // 与 app 一致 0.5s/块
  let m;
  for (let i = 0; i < 40; i++) m = an.process(synth.nextChunk(chunk));
  const ok = m && typeof m.ratePerDay === 'number' && Array.isArray(m.clusters) && Array.isArray(m.timingStrip);
  console.log(
    `${ok ? '✔' : '✖'} ${name.padEnd(12)} 锁定=${m.locked} 摆频=${String(m.nominalBph).padEnd(6)} ` +
    `日差=${m.ratePerDay?.toFixed(1).padStart(7)} 摆幅=${m.amplitudeDeg?.toFixed(0) ?? '–'} ` +
    `偏振=${m.beatErrorMs?.toFixed(2) ?? '–'} 簇=${m.clusters.length} 异声=${m.rejected.length} 时序点=${m.timingStrip.length}`
  );
}
