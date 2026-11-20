// 浏览器应用层装配测试：用最小 DOM mock 验证 App 能初始化、
// 合成回路能跑通并把指标渲染到 DOM，六方位流程可提交汇总。
// 不依赖 jsdom：只实现 App 实际用到的 DOM 接口。

function makeEl(tag = 'div') {
  const listeners = {};
  return {
    tag, value: tag === 'input' ? '' : '0', textContent: '', innerHTML: '',
    className: '', files: [], style: {}, clientWidth: 600, clientHeight: 200,
    classList: { add() {}, remove() {} },
    addEventListener(t, fn) { (listeners[t] ||= []).push(fn); },
    click() { (listeners.click || []).forEach((f) => f({ target: el, closest: () => null })); },
    querySelector() { return makeEl(); },
    getContext() {
      return {
        canvas: { width: 0, height: 0 }, setTransform() {}, clearRect() {},
        beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fillRect() {},
        arc() {}, fill() {}, fillText() {}, save() {}, restore() {},
        setLineDash() {},
      };
    },
  };
}

const ids = [
  'btnMic', 'btnSynth', 'btnWav', 'wavFile', 'btnStop', 'liftAngle', 'liftAngleValue',
  'btnSaveWav', 'posGrid', 'btnPosClear', 'statusBar', 'timingChart', 'subChart',
  'rateTrend', 'ampTrend', 'mBph', 'mRate', 'mBeat', 'mAmp', 'mLift', 'mElapsed',
  'qFill', 'qSnr', 'qJitter', 'qOffgrid', 'posVariation', 'posMeanRate', 'posMinAmp', 'posMaxBeat',
  'sBph', 'sRate', 'sBeat', 'sAmp', 'sDur', 'sSnr', 'sJitter', 'sP1', 'sMiss',
  'sImpact', 'sNoiseColor', 'sSeed', 'sMains', 'sDate', 'sTourb',
];
const elMap = Object.fromEntries(ids.map((id) => [id, makeEl()]));
elMap.sBph.value = '28800'; elMap.sNoiseColor.value = 'pink';
elMap.sMains.checked = false; elMap.sDate.checked = false; elMap.sTourb.checked = false;
elMap.liftAngle.value = '52';
for (const [k, v] of Object.entries({
  sRate: '5', sBeat: '0.4', sAmp: '280', sDur: '30', sSnr: '28',
  sJitter: '50', sP1: '1', sMiss: '0', sImpact: '0', sSeed: '1',
})) elMap[k].value = v;

globalThis.document = {
  querySelector: (sel) => elMap[sel.replace('#', '')] || makeEl(),
  createElement: () => makeEl('a'),
};
globalThis.window = {
  devicePixelRatio: 1, addEventListener: () => {}, AudioContext: undefined,
};
globalThis.performance = { now: () => Date.now() };
globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };
globalThis.Blob = class { constructor(parts, opts) { this.parts = parts; this.opts = opts; } };

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`✔ ${name}`);
  else { failures++; console.log(`✘ ${name} ${detail}`); }
};

const { App } = await import('../src/app/main.js');
const app = new App();
check('App 初始化', !!app);
check('初始未锁定', app.detector === null);

// 跑合成回路（30 秒缩短测试时间）
app._runSynthLoopback();
await new Promise((r) => setTimeout(r, 200));
check('合成后创建检测器', !!app.detector);
const snap = app.detector.snapshot();
check('合成回路锁定 28800', snap.locked && snap.bph === 28800, `bph=${snap.bph}`);
check('日差渲染到 DOM', elMap.mRate.textContent.includes('s/d'));
check('摆频渲染到 DOM', elMap.mBph.textContent.includes('28800'));
check('拦截离格计数已渲染', elMap.qOffgrid.textContent == snap.quality.offGridCount,
  `got '${elMap.qOffgrid.textContent}' expected '${snap.quality.offGridCount}'`);

// 六方位：提交两个方位，验证位差汇总
const { PositionSession } = await import('../src/app/positions.js');
const ps = new PositionSession();
ps.commit('DU', { locked: true, rateSd: 4, amplitudeDeg: 280, beatErrorMs: 0.4, bph: 28800, tLiftMs: 7.4, quality: {} });
ps.commit('DD', { locked: true, rateSd: -2, amplitudeDeg: 260, beatErrorMs: 0.6, bph: 28800, tLiftMs: 8.1, quality: {} });
const sum = ps.summary();
check('位差 = 6 s/d', Math.abs(sum.rateVariationSd - 6) < 1e-9, `got ${sum.rateVariationSd}`);
check('平均日差 = 1', Math.abs(sum.meanRateSd - 1) < 1e-9);
check('最低摆幅 = 260', sum.minAmplitudeDeg === 260);
check('未完成全部六方位', !ps.allDone);

// 补满六方位
for (const id of ['CU', 'CR', 'CL', 'CD']) {
  ps.commit(id, { locked: true, rateSd: 3, amplitudeDeg: 270, beatErrorMs: 0.5, bph: 28800, tLiftMs: 7.6, quality: {} });
}
check('六方位全部完成', ps.allDone && ps.doneCount === 6);

// 未锁定时提交应抛错
let threw = false;
try { ps.commit('XX', { locked: false }); } catch { threw = true; }
check('未锁定提交被拒绝', threw);

console.log(failures === 0 ? '\n应用层装配测试全部通过 ✔' : `\n${failures} 项失败 ✘`);
process.exit(failures ? 1 : 0);
