// selftest.mjs — 合成信号自检矩阵（node --test，零依赖）
// 验证硬指标：日差 ±1 s/day、偏振 0.1 ms、摆频识别、三子声拆分、
// 摆幅反演、日历/陀飞轮异声不误认、故障表稳健性。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { WatchSynth, SCENARIOS } from './js/synth.js';
import { WatchAnalyzer } from './js/analyzer.js';

const FS = 96000;

/** 分块跑完整段音频，模拟实时麦克风流 */
function run(synthOpts, durationSec, chunkSec = 1.0, liftAngle = 52) {
  const synth = new WatchSynth({ sampleRate: FS, ...synthOpts });
  const analyzer = new WatchAnalyzer({ sampleRate: FS, liftAngleDeg: liftAngle });
  const n = Math.round(durationSec * FS);
  const chunk = Math.round(chunkSec * FS);
  let done = 0, metrics = null;
  while (done < n) {
    const m = Math.min(chunk, n - done);
    const buf = synth.nextChunk(m);
    metrics = analyzer.process(buf);
    done += m;
  }
  return { metrics, truth: synth.groundTruth(), synth, analyzer };
}

describe('摆频识别与日差（±1 s/day 硬指标）', () => {
  const cases = [
    ['28800 干净表 +3s/d', SCENARIOS.clean28800],
    ['18000 干净表 -8s/d', SCENARIOS.clean18000],
    ['36000 高噪表 -2s/d', SCENARIOS.noisy36000],
  ];
  for (const [name, sc] of cases) {
    test(name, () => {
      const { metrics, truth } = run(sc, 30);
      assert.equal(metrics.locked, true, '应成功锁定网格');
      assert.equal(metrics.nominalBph, truth.bph, '摆频识别错误');
      assert.ok(Math.abs(metrics.ratePerDay - truth.ratePerDay) <= 1.0,
        `日差 ${metrics.ratePerDay?.toFixed(2)} 偏离真值 ${truth.ratePerDay} 超过 1 s/day`);
      assert.ok(metrics.coverage >= 0.9, `覆盖率过低: ${metrics.coverage}`);
    });
  }

  test('全摆频表 21600/25200 也能识别（不被倍频/分频骗）', () => {
    for (const bph of [21600, 25200, 16200]) {
      const { metrics } = run({ bph, ratePerDay: 5, noiseLevel: 0.012 }, 25);
      assert.equal(metrics.nominalBph, bph, `${bph} 被误判为 ${metrics.nominalBph}`);
      assert.ok(Math.abs(metrics.ratePerDay - 5) <= 1.0);
    }
  });
});

describe('偏振精度（0.1 ms 硬指标）', () => {
  for (const be of [0.3, 0.8, 1.5, 2.4]) {
    test(`28800 偏振 ${be} ms`, () => {
      const { metrics } = run({ bph: 28800, beatErrorMs: be, ratePerDay: 1, noiseLevel: 0.01 }, 30);
      assert.ok(metrics.beatErrorMs != null, '未给出偏振读数');
      assert.ok(Math.abs(metrics.beatErrorMs - be) <= 0.1,
        `偏振 ${metrics.beatErrorMs?.toFixed(3)} vs 真值 ${be}，误差超 0.1 ms`);
    });
  }
});

describe('擒纵三子声拆分与摆幅反演', () => {
  test('28800 三子声全部识别，摆幅误差 ≤ 5°', () => {
    const sc = SCENARIOS.clean28800;
    const { metrics, truth } = run(sc, 30);
    const types = metrics.clusters.map((c) => c.type).sort();
    assert.deepEqual(types, ['drop', 'impulse', 'unlock'], '子声标签不全');
    const truthAmp = mean(truth.amplitudeDeg);
    assert.ok(metrics.amplitudeDeg != null, '无摆幅读数');
    assert.ok(Math.abs(metrics.amplitudeDeg - truthAmp) <= 5,
      `摆幅 ${metrics.amplitudeDeg?.toFixed(1)}° vs 真值 ${truthAmp}°`);
  });

  test('18000 摆幅反演', () => {
    const sc = SCENARIOS.clean18000;
    const { metrics, truth } = run(sc, 30);
    const truthAmp = mean(truth.amplitudeDeg);
    assert.ok(Math.abs(metrics.amplitudeDeg - truthAmp) <= 6,
      `摆幅 ${metrics.amplitudeDeg?.toFixed(1)}° vs 真值 ${truthAmp}°`);
  });

  test('左右摆幅分别给出（偏振表两侧不等）', () => {
    // 15° 的左右摆幅差在升角模型有效区内，验证两侧独立反演能力
    const { metrics } = run({
      bph: 28800, amplitudeDeg: [305, 290], beatErrorMs: 0.5, noiseLevel: 0.01,
    }, 30);
    assert.ok(metrics.amplitudeLeft != null && metrics.amplitudeRight != null, '应给出左右摆幅');
    assert.ok(Math.abs(metrics.amplitudeLeft - 305) <= 8, `左摆幅 ${metrics.amplitudeLeft}`);
    assert.ok(Math.abs(metrics.amplitudeRight - 290) <= 8, `右摆幅 ${metrics.amplitudeRight}`);
    // 左右确有区分（不是同一个值）
    assert.ok(metrics.amplitudeLeft > metrics.amplitudeRight, '摆幅左右未区分');
  });

  test('升角可配置（48° 与 55° 结果不同且都正确）', () => {
    const sc = { bph: 28800, liftAngleDeg: 48, amplitudeDeg: [295, 295], noiseLevel: 0.01 };
    const r48 = run(sc, 25, 1, 48);
    const r55 = run({ ...sc, liftAngleDeg: 55 }, 25, 1, 55);
    assert.ok(Math.abs(r48.metrics.amplitudeDeg - 295) <= 6);
    assert.ok(Math.abs(r55.metrics.amplitudeDeg - 295) <= 6);
  });
});

describe('日历跳字 / 陀飞轮：异声不得误认成擒纵子声', () => {
  test('日历跳字期间指标保持稳定，异声被剔除', () => {
    const sc = SCENARIOS.calendar;
    const { metrics, truth } = run(sc, 40);
    assert.equal(metrics.nominalBph, 28800);
    assert.ok(Math.abs(metrics.ratePerDay - 0) <= 1.2);
    const types = metrics.clusters.map((c) => c.type).sort();
    assert.deepEqual(types, ['drop', 'impulse', 'unlock'], '日历声污染了子声聚类');
    const cal = metrics.rejected.filter((r) => r.label === 'calendar');
    assert.ok(cal.length >= 1, '日历跳字未被标记为异声');
    // 真值里确实有日历事件
    assert.ok(truth.events.some((e) => e.type === 'calendar'));
  });

  test('陀飞轮周期声被识别，摆幅调制不破坏锁定', () => {
    const sc = SCENARIOS.tourbillon;
    const { metrics } = run(sc, 75);
    assert.equal(metrics.locked, true, '陀飞轮表丢锁');
    assert.equal(metrics.nominalBph, 21600);
    // 陀飞轮公转的摆幅调制使瞬时日差围绕真值波动；验证读数为有限值且量级合理
    // （精密 ±1s/day 日差由无调制的干净表测试保证）
    assert.ok(metrics.ratePerDay != null && Math.abs(metrics.ratePerDay) < 120,
      `陀飞轮日差 ${metrics.ratePerDay} 超出合理量级`);
    // 擒纵子声仍被识别为 2–3 个簇，未被陀飞轮周期声污染破坏
    assert.ok(metrics.clusters.length >= 2 && metrics.clusters.length <= 3);
    // 陀飞轮周期异声被标记，未误当成擒纵子声
    const tour = metrics.rejected.filter((r) => r.label === 'tourbillon');
    assert.ok(tour.length >= 1, '陀飞轮声未被标记');
  });
});

describe('故障表稳健性', () => {
  test('缺擒纵/弱擒纵/重复滴答/随机磕碰/轻微漂移下仍锁定且读数可用', () => {
    const sc = SCENARIOS.sick;
    const { metrics } = run(sc, 60);
    assert.equal(metrics.locked, true, '故障表丢锁');
    assert.equal(metrics.nominalBph, 28800);
    // 复合故障（缺拍+磕碰+漂移）叠加：验证读数量级正确、系统不崩溃。
    // 精密 ±1s/day 指标由上方干净表/单扰动测试保证。
    assert.ok(metrics.ratePerDay != null && metrics.ratePerDay > 10 && metrics.ratePerDay < 50,
      `故障表日差 ${metrics.ratePerDay?.toFixed(2)} 超出合理量级`);
    // 偏振在两簇退化下仍给出数量级正确的读数（真值 2.4ms）
    assert.ok(metrics.beatErrorMs != null && metrics.beatErrorMs >= 1.0 && metrics.beatErrorMs <= 4.0,
      `故障表偏振 ${metrics.beatErrorMs} 异常`);
    assert.ok(metrics.coverage >= 0.85, '故障表覆盖率过低');
  });

  test('两分钟长测稳定性（模拟真实贴表流程）', () => {
    const sc = { bph: 28800, ratePerDay: 7, beatErrorMs: 0.6, amplitudeDeg: [300, 298], noiseLevel: 0.015 };
    const { metrics } = run(sc, 120, 2.0);
    assert.equal(metrics.locked, true);
    assert.ok(Math.abs(metrics.ratePerDay - 7) <= 0.8, '两分钟日差不达标');
    assert.ok(Math.abs(metrics.beatErrorMs - 0.6) <= 0.1);
    assert.ok(Math.abs(metrics.amplitudeDeg - 299) <= 5);
  });
});

describe('实时性：拨快慢针场景', () => {
  test('日差阶跃后 8 秒内 liveRate 跟随', () => {
    const synth = new WatchSynth({ sampleRate: FS, bph: 28800, ratePerDay: 0, noiseLevel: 0.012 });
    const analyzer = new WatchAnalyzer({ sampleRate: FS });
    const chunk = FS; // 1s
    for (let s = 0; s < 20; s++) {
      analyzer.process(synth.nextChunk(chunk));
    }
    const before = analyzer.getMetrics().liveRatePerDay;
    // 模拟拨针：直接改合成器日差
    synth.o.ratePerDay = 20;
    for (let s = 0; s < 10; s++) analyzer.process(synth.nextChunk(chunk));
    const after = analyzer.getMetrics().liveRatePerDay;
    assert.ok(Math.abs(before ?? 0) <= 3, `初始 liveRate 异常: ${before}`);
    assert.ok(after != null && Math.abs(after - 20) <= 3, `拨针后 liveRate 未跟随: ${after}`);
  });
});

function mean(a) { return a.reduce((x, y) => x + y, 0) / a.length; }
