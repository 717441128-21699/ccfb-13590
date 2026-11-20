// app.js — 网页应用主控：麦克风/合成数据源 → 分析器 → 实时 UI
import { WatchAnalyzer } from './analyzer.js';
import { WatchSynth, SCENARIOS } from './synth.js';

const $ = (id) => document.getElementById(id);
const FS_PREF = 96000;

let analyzer = null;
let audioCtx = null, micStream = null, micNode = null, processor = null;
let synth = null, synthTimer = null, synthRunning = false;
let mode = 'mic';
let rafId = null;
const positions = loadPositions();

/* ---------------- 场景下拉 ---------------- */
const scenarioNames = {
  clean28800: '28800 干净表（+3s/d）',
  clean18000: '18000 慢摆表（−8s/d）',
  calendar: '带日历跳字',
  tourbillon: '陀飞轮',
  sick: '故障表（缺擒纵/磕碰/漂移）',
  noisy36000: '36000 高频快摆',
};
for (const [key, name] of Object.entries(scenarioNames)) {
  const opt = document.createElement('option');
  opt.value = key; opt.textContent = name;
  $('scenario').appendChild(opt);
}

/* ---------------- 模式切换 ---------------- */
$('micBtn').onclick = () => switchMode('mic');
$('synthBtn').onclick = () => switchMode('synth');
function switchMode(m) {
  mode = m;
  $('micBtn').classList.toggle('active', m === 'mic');
  $('synthBtn').classList.toggle('active', m === 'synth');
  $('micControls').hidden = m !== 'mic';
  $('synthControls').hidden = m !== 'synth';
  stopAll();
  resetAnalyzer();
}

function resetAnalyzer() {
  const lift = parseFloat($('liftAngle').value) || 52;
  const fs = audioCtx?.sampleRate || FS_PREF;
  analyzer = new WatchAnalyzer({ sampleRate: fs, liftAngleDeg: lift });
}
$('liftAngle').onchange = resetAnalyzer;

/* ---------------- 麦克风采集 ---------------- */
$('startMic').onclick = startMic;
$('stopMic').onclick = stopAll;

async function startMic() {
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: parseInt($('sampleRate').value, 10),
    });
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const source = audioCtx.createMediaStreamSource(micStream);
    resetAnalyzer();
    try {
      await ensureProcessor(audioCtx);
      processor = new AudioWorkletNode(audioCtx, 'float-chunk', {
        numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1,
      });
      processor.port.onmessage = (e) => feed(new Float64Array(e.data));
      source.connect(processor);
    } catch (e) {
      // 回退：ScriptProcessor（file:// 或老浏览器）
      processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (ev) => {
        const ch = ev.inputBuffer.getChannelData(0);
        feed(Float64Array.from(ch));
      };
      source.connect(processor);
      processor.connect(audioCtx.destination);
    }
    setRunningUI(true, 'mic');
  } catch (err) {
    alert('无法访问麦克风：' + err.message + '\n可改用「合成演示」体验完整功能。');
  }
}

async function ensureProcessor(ctx) {
  try {
    await ctx.audioWorklet.addModule('js/worklet.js');
  } catch (e) {
    // Worklet 加载失败（如 file:// 限制）→ 动态注入 ScriptProcessor 回退
    throw new Error('AudioWorklet 不可用：' + e.message);
  }
}

/* ---------------- 合成演示 ---------------- */
$('startSynth').onclick = startSynth;
$('stopSynth').onclick = stopAll;
$('rateSlider').oninput = (e) => {
  $('rateLbl').textContent = e.target.value;
  if (synth) synth.o.ratePerDay = parseFloat(e.target.value);
};

function startSynth() {
  const fs = FS_PREF;
  audioCtx = null;
  const sc = SCENARIOS[$('scenario').value];
  const lift = parseFloat($('liftAngle').value) || 52;
  synth = new WatchSynth({ sampleRate: fs, ...sc, liftAngleDeg: lift });
  synth.o.ratePerDay = parseFloat($('rateSlider').value);
  analyzer = new WatchAnalyzer({ sampleRate: fs, liftAngleDeg: lift });
  synthRunning = true;
  // 每 0.5 秒推送一块（与实时流式一致）
  const chunk = Math.round(fs * 0.5);
  synthTimer = setInterval(() => {
    if (!synthRunning) return;
    feed(synth.nextChunk(chunk));
  }, 500);
  setRunningUI(true, 'synth');
}

/* ---------------- 数据投喂与渲染循环 ---------------- */
let lastWave = null;
function feed(samples) {
  if (!analyzer) return;
  const m = analyzer.process(samples);
  lastWave = analyzer.diagnostics.filtered || samples;
  if (!rafId) rafId = requestAnimationFrame(render);
  return m;
}

function render() {
  rafId = null;
  if (!analyzer) return;
  const m = analyzer.getMetrics();
  updateMetrics(m);
  drawStrip(m);
  drawWave();
  $('elapsed').textContent = fmtTime(m.elapsedSec);
  $('beatCount').textContent = m.beatCount + ' 拍';
}

function updateMetrics(m) {
  const pill = $('lockPill');
  if (m.locked) { pill.className = 'status-pill locked'; $('lockText').textContent = '已锁定 ' + (m.nominalBph || ''); }
  else { pill.className = 'status-pill warn'; $('lockText').textContent = m.state === 'acquiring' ? '捕获拍网格中…' : '未锁定'; }

  setCard('rate', m.ratePerDay, v => v.toFixed(1), m.ratePerDay == null ? null : Math.abs(m.ratePerDay) <= 1 ? 'good' : Math.abs(m.ratePerDay) <= 10 ? 'warn' : 'bad');
  $('liveRate').textContent = '实时 ' + (m.liveRatePerDay == null ? '–' : m.liveRatePerDay.toFixed(1));
  setCard('amplitude', m.amplitudeDeg, v => v.toFixed(0));
  $('ampLR').textContent = `左 ${m.amplitudeLeft?.toFixed(0) ?? '–'}° / 右 ${m.amplitudeRight?.toFixed(0) ?? '–'}°`;
  setCard('beatError', m.beatErrorMs, v => v.toFixed(1));
  $('bePolarity').textContent = m.beatErrorPolarity ?? '–';
  $('bph').textContent = m.nominalBph ?? '–';
  $('coverage').textContent = '覆盖率 ' + (m.coverage * 100).toFixed(0) + '%';

  // 子声簇
  if (m.clusters.length) {
    $('clusterInfo').innerHTML = m.clusters.map(c => `
      <div class="cluster-row">
        <span class="cluster-tag ${c.type}"></span>
        <span>${clusterName(c.type)}</span>
        <span class="spacer"></span>
        <span class="muted">${c.offMs.toFixed(1)} ms · 占比 ${(c.support * 100).toFixed(0)}%</span>
      </div>`).join('');
  } else {
    $('clusterInfo').textContent = m.locked ? '子声聚类中…' : '等待数据…';
  }
  // 异声
  const rej = m.rejected;
  const counts = rej.reduce((h, r) => { h[r.label] = (h[r.label] || 0) + 1; return h; }, {});
  $('rejectInfo').innerHTML = Object.entries(counts).map(([k, v]) =>
    `<span class="reject-chip">${rejectName(k)} ×${v}</span>`).join('');
}

function setCard(id, val, fmt, cls) {
  const el = $(id);
  if (val == null || !isFinite(val)) { el.textContent = '–'; el.closest('.card').className = 'card'; return; }
  el.textContent = fmt(val);
  el.closest('.card').className = 'card' + (cls ? ' ' + cls : '');
}
const clusterName = (t) => ({ unlock: '开锁', impulse: '冲击', drop: '落下' }[t] || t);
const rejectName = (t) => ({ calendar: '日历跳字', tourbillon: '陀飞轮', external: '外部磕碰' }[t] || t);
function fmtTime(s) { const m = Math.floor(s / 60), ss = Math.floor(s % 60); return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`; }

/* ---------------- 时序图 ---------------- */
function drawStrip(m) {
  const cv = $('stripCanvas'), dpr = window.devicePixelRatio || 1;
  fitCanvas(cv, dpr);
  const ctx = cv.getContext('2d');
  const W = cv.width / dpr, H = cv.height / dpr;
  ctx.clearRect(0, 0, W, H);
  if (!m.locked || !m.clusters.length) {
    ctx.fillStyle = '#8b98a5'; ctx.font = '13px sans-serif';
    ctx.fillText('锁定后显示逐拍子声时序', 16, H / 2);
    return;
  }
  const color = { unlock: '#b07dff', impulse: '#4da3ff', drop: '#3fd07a' };
  const data = m.timingStrip;
  if (!data.length) return;
  const B = 3600 / m.bph * 1000; // ms
  const rowH = Math.min(26, H / Math.max(8, data.length));
  const centerX = W * 0.5;
  const scale = (W * 0.42) / (B * 0.5); // ±0.5B 映射到 42% 宽
  // 中心线
  ctx.strokeStyle = '#2d3a47'; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(centerX, 0); ctx.lineTo(centerX, H); ctx.stroke(); ctx.setLineDash([]);
  const n = Math.min(data.length, Math.floor(H / rowH));
  const start = data.length - n;
  for (let i = 0; i < n; i++) {
    const beat = data[start + i];
    const y = (i + 0.5) * rowH;
    ctx.fillStyle = beat.parity ? '#3a4653' : '#2a3540';
    ctx.fillRect(0, y - rowH / 2 + 1, W, rowH - 2);
    for (const s of beat.slots) {
      const x = centerX + s.offMs * scale;
      const type = slotType(s, m.clusters);
      ctx.fillStyle = color[type] || '#8b98a5';
      ctx.beginPath(); ctx.arc(x, y, 4.5, 0, 7); ctx.fill();
    }
  }
  // 横轴刻度
  ctx.fillStyle = '#8b98a5'; ctx.font = '10px sans-serif';
  ctx.fillText('−' + (B / 2).toFixed(0) + 'ms', 4, H - 4);
  ctx.fillText('0', centerX - 4, H - 4);
  ctx.fillText('+' + (B / 2).toFixed(0) + 'ms', W - 42, H - 4);
}
function slotType(slot, clusters) {
  let best = null, bd = Infinity;
  for (const c of clusters) {
    const d = Math.abs(slot.offMs - c.offMs);
    if (d < bd) { bd = d; best = c; }
  }
  return best ? best.type : null;
}

function drawWave() {
  const cv = $('waveCanvas'), dpr = window.devicePixelRatio || 1;
  fitCanvas(cv, dpr);
  const ctx = cv.getContext('2d');
  const W = cv.width / dpr, H = cv.height / dpr;
  ctx.clearRect(0, 0, W, H);
  if (!lastWave) return;
  const view = lastWave.subarray(Math.max(0, lastWave.length - 4096));
  let peak = 1e-9;
  for (const v of view) peak = Math.max(peak, Math.abs(v));
  ctx.strokeStyle = '#4da3ff'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < view.length; i++) {
    const x = (i / view.length) * W;
    const y = H / 2 - (view[i] / peak) * (H / 2 - 6);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.stroke();
}
function fitCanvas(cv, dpr) {
  const rect = cv.getBoundingClientRect();
  const w = Math.round(rect.width * dpr), h = Math.round(rect.height * dpr);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
}

/* ---------------- 六方位 ---------------- */
const POSITIONS = ['表盘上', '表盘下', '表把上', '表把下', '表把左', '表把右'];
function buildPosGrid() {
  const grid = $('posGrid');
  grid.innerHTML = '';
  POSITIONS.forEach((name, i) => {
    const cell = document.createElement('div');
    cell.className = 'pos-cell';
    cell.dataset.idx = i;
    cell.innerHTML = `
      <div class="pos-name">${name}</div>
      <div class="pos-rate" data-role="rate">–</div>
      <div class="pos-amp" data-role="amp">摆幅 –</div>`;
    cell.onclick = () => savePosition(i, cell);
    grid.appendChild(cell);
  });
  renderPositions();
}
function savePosition(i, cell) {
  const m = analyzer?.getMetrics();
  if (!m || !m.locked) { alert('请等信号锁定后再记录该方位'); return; }
  positions[i] = { rate: m.ratePerDay, amp: m.amplitudeDeg, be: m.beatErrorMs };
  savePositions();
  renderPositions();
  cell.classList.add('active');
  setTimeout(() => cell.classList.remove('active'), 600);
}
function renderPositions() {
  document.querySelectorAll('.pos-cell').forEach((cell, i) => {
    const p = positions[i];
    cell.querySelector('[data-role=rate]').innerHTML = p
      ? `${p.rate.toFixed(1)} <small>s/d</small>` : '–';
    cell.querySelector('[data-role=amp]').textContent = p ? `摆幅 ${p.amp?.toFixed(0) ?? '–'}°` : '点击记录';
  });
}
$('clearPos').onclick = () => { positions.length = 0; savePositions(); renderPositions(); };
function savePositions() { try { localStorage.setItem('wt-positions', JSON.stringify(positions)); } catch {} }
function loadPositions() { try { return JSON.parse(localStorage.getItem('wt-positions') || '[]'); } catch { return []; } }

/* ---------------- 停止/清理 ---------------- */
function setRunningUI(running, src) {
  if (src === 'mic') { $('startMic').disabled = running; $('stopMic').disabled = !running; }
  else { $('startSynth').disabled = running; $('stopSynth').disabled = !running; }
}
function stopAll() {
  synthRunning = false;
  if (synthTimer) { clearInterval(synthTimer); synthTimer = null; }
  if (processor) { try { processor.disconnect(); } catch {} processor = null; }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
  setRunningUI(false, 'mic'); setRunningUI(false, 'synth');
}

buildPosGrid();
resetAnalyzer();
