// 主应用控制器：三种数据来源（麦克风实时 / 合成信号回路 / WAV 文件），
// 驱动指标卡、时序图、子声图、实时曲线和六方位位差测量。

import { WatchDetector } from '../core/detector.js';
import { synthWatch } from '../core/synth.js';
import { decodeWav, encodeWav } from '../core/wav.js';
import { MicCapture } from './capture.js';
import { TimingChart, SubSoundChart, TrendChart } from './charts.js';
import { PositionSession } from './positions.js';
import { POSITIONS, formatBeatErrorMs, DEFAULT_LIFT_ANGLE_DEG } from '../core/geometry.js';

const $ = (sel) => document.querySelector(sel);
const fmt = (v, digits = 1, unit = '') =>
  Number.isFinite(v) ? `${v.toFixed(digits)}${unit}` : '—';

export class App {
  constructor() {
    this.detector = null;
    this.capture = null;
    this.mode = 'idle';
    this.positionSession = new PositionSession();
    this.history = { rate: [], amplitude: [], beat: [] };
    this.startTime = 0;
    this.trendMaxPoints = 240;
    this._initCharts();
    this._bindUI();
    this._renderPositions();
    this._setLiftAngle(DEFAULT_LIFT_ANGLE_DEG);
  }

  _initCharts() {
    this.timingChart = new TimingChart($('#timingChart'));
    this.subChart = new SubSoundChart($('#subChart'));
    this.rateTrend = new TrendChart($('#rateTrend'));
    this.ampTrend = new TrendChart($('#ampTrend'));
  }

  _bindUI() {
    $('#btnMic').addEventListener('click', () => this._toggleMic());
    $('#btnSynth').addEventListener('click', () => this._runSynthLoopback());
    $('#btnWav').addEventListener('click', () => $('#wavFile').click());
    $('#wavFile').addEventListener('change', (e) => this._loadWav(e));
    $('#btnStop').addEventListener('click', () => this.stop());
    $('#liftAngle').addEventListener('change', (e) => this._setLiftAngle(+e.target.value));
    $('#btnSaveWav').addEventListener('click', () => this._exportSynthWav());

    // 方位测量
    $('#posGrid').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-pos]');
      if (btn) this._commitPosition(btn.dataset.pos);
    });
    $('#btnPosClear').addEventListener('click', () => {
      this.positionSession.clear();
      this._renderPositions();
      this._renderPosSummary();
    });

    window.addEventListener('resize', () => this._redrawCharts());
  }

  _setLiftAngle(deg) {
    this.liftAngle = deg;
    $('#liftAngleValue').textContent = `${deg}°`;
    if (this.detector) this.detector.liftAngleDeg = deg;
  }

  _newDetector(fs) {
    this.detector = new WatchDetector({ fs, liftAngleDeg: this.liftAngle });
    this.history = { rate: [], amplitude: [], beat: [] };
    this.startTime = performance.now();
  }

  // ---------- 麦克风实时 ----------
  async _toggleMic() {
    if (this.mode === 'mic') { this.stop(); return; }
    this._setStatus('正在请求麦克风…', 'warn');
    try {
      this._newDetector(48000);
      this.capture = new MicCapture((pcm, fs) => this._onChunk(pcm, fs));
      const fs = await this.capture.start();
      this.detector = new WatchDetector({ fs, liftAngleDeg: this.liftAngle });
      this.mode = 'mic';
      this.startTime = performance.now();
      $('#btnMic').classList.add('active');
      this._setStatus('麦克风采集中——请把表紧贴麦克风', 'ok');
      this._startUiTimer();
    } catch (err) {
      this._setStatus(`麦克风启动失败：${err.message}`, 'err');
      this.stop();
    }
  }

  // ---------- 合成信号回路（不经过扬声器，纯算法回放）----------
  _runSynthLoopback() {
    this.stop();
    const cfg = this._readSynthConfig();
    this._setStatus('合成信号分析中…', 'warn');
    // 让 UI 先刷新状态，再做重型计算
    setTimeout(() => {
      const { samples, truth } = synthWatch(cfg);
      this._newDetector(cfg.fs);
      this.detector._synthTruth = truth;
      this.mode = 'synth';
      // 分块喂入，模拟真实流
      const chunk = Math.round(cfg.fs * 0.5);
      for (let off = 0; off < samples.length; off += chunk) {
        this.detector.process(samples.subarray(off, off + chunk));
      }
      this.lastSynth = { samples, cfg };
      this._renderSnapshot(this.detector.snapshot());
      this._setStatus(`合成分析完成（${cfg.seconds}s，${cfg.bph} 摆频）`, 'ok');
    }, 30);
  }

  _readSynthConfig() {
    const num = (id, d) => {
      const el = $(id);
      const v = parseFloat(el.value);
      return Number.isFinite(v) ? v : d;
    };
    return {
      bph: num('#sBph', 28800),
      rateSd: num('#sRate', 5),
      beatErrorMs: num('#sBeat', 0.4),
      amplitudeDeg: num('#sAmp', 280),
      liftAngleDeg: this.liftAngle,
      fs: 48000,
      seconds: num('#sDur', 120),
      snrDb: num('#sSnr', 28),
      jitterUs: num('#sJitter', 50),
      p1Gain: num('#sP1', 1),
      missProb: num('#sMiss', 0) / 100,
      mainsHz: $('#sMains').checked ? 50 : null,
      dateChangeAtSec: $('#sDate').checked ? Math.max(5, num('#sDur', 120) * 0.4) : null,
      dateClicks: 12,
      tourbillon: $('#sTourb').checked,
      cagePeriodSec: 60,
      impactHz: num('#sImpact', 0),
      noiseColor: $('#sNoiseColor').value,
      seed: (Math.floor(num('#sSeed', 1)) || 1),
    };
  }

  async _exportSynthWav() {
    if (!this.lastSynth) { this._setStatus('请先运行一次合成分析', 'warn'); return; }
    const wav = encodeWav(this.lastSynth.samples, this.lastSynth.cfg.fs);
    const blob = new Blob([wav], { type: 'audio/wav' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `watch_${this.lastSynth.cfg.bph}vph_synth.wav`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---------- WAV 文件分析 ----------
  async _loadWav(event) {
    const file = event.target.files[0];
    if (!file) return;
    this.stop();
    this._setStatus(`读取 ${file.name}…`, 'warn');
    try {
      const buf = await file.arrayBuffer();
      const { samples, fs } = decodeWav(buf);
      this._newDetector(fs);
      this.mode = 'wav';
      const chunk = Math.round(fs * 0.5);
      for (let off = 0; off < samples.length; off += chunk) {
        this.detector.process(samples.subarray(off, off + chunk));
      }
      this._renderSnapshot(this.detector.snapshot());
      this._setStatus(`文件分析完成（${(samples.length / fs).toFixed(1)}s @ ${fs}Hz）`, 'ok');
    } catch (err) {
      this._setStatus(`WAV 解析失败：${err.message}`, 'err');
    } finally {
      event.target.value = '';
    }
  }

  // ---------- 实时数据流 ----------
  _onChunk(pcm, fs) {
    if (!this.detector || this.detector.fs !== fs) {
      this._newDetector(fs);
    }
    this.detector.process(pcm);
  }

  _startUiTimer() {
    this._uiTimer = setInterval(() => {
      if (!this.detector) return;
      this._renderSnapshot(this.detector.snapshot());
    }, 250);
  }

  _renderSnapshot(snap) {
    // 指标卡
    $('#mBph').textContent = snap.locked ? `${snap.bph}${snap.nonStandard ? ' (非标)' : ''}` : '识别中…';
    $('#mRate').textContent = snap.locked ? `${snap.rateSd >= 0 ? '+' : ''}${fmt(snap.rateSd, 1, ' s/d')}` : '—';
    $('#mBeat').textContent = snap.locked ? formatBeatErrorMs(snap.beatErrorMs) : '—';
    $('#mAmp').textContent = snap.locked ? fmt(snap.amplitudeDeg, 0, '°') : '—';
    $('#mLift').textContent = snap.locked ? fmt(snap.tLiftMs, 2, ' ms') : '—';
    $('#mElapsed').textContent = `${Math.floor(snap.analyzedSec)}s`;

    // 状态与质量
    const q = snap.quality;
    $('#qFill').textContent = Number.isFinite(q.fillRate) ? `${(q.fillRate * 100).toFixed(0)}%` : '—';
    $('#qSnr').textContent = Number.isFinite(q.snrDb) ? `${q.snrDb.toFixed(1)} dB` : '—';
    $('#qJitter').textContent = Number.isFinite(q.jitterMs) ? `${q.jitterMs.toFixed(2)} ms` : '—';
    $('#qOffgrid').textContent = q.offGridCount ?? 0;
    this._setStatus(
      snap.locked ? `已锁定 ${snap.bph} 摆频 · 离格机构声 ${q.offGridCount} 次已拦截` : '正在识别摆频（约需 6–10 秒）…',
      snap.locked ? 'ok' : 'warn',
    );

    // 历史曲线
    const t = (snap.analyzedSec);
    this._pushHistory(this.history.rate, { t, value: snap.rateSd });
    this._pushHistory(this.history.amplitude, { t, value: snap.amplitudeDeg });
    this._pushHistory(this.history.beat, { t, value: snap.beatErrorMs });

    this._redrawCharts(snap);
  }

  _pushHistory(arr, point) {
    if (!Number.isFinite(point.value)) return;
    arr.push(point);
    if (arr.length > this.trendMaxPoints) arr.shift();
  }

  _redrawCharts(snap) {
    const s = snap || this.detector?.snapshot();
    if (!s) return;
    this.timingChart.draw(s.ticks);
    const last = s.ticks[s.ticks.length - 1];
    this.subChart.draw(last || null, s.tLiftMs);
    this.rateTrend.draw(this.history.rate, { color: '#4ea1ff' });
    this.ampTrend.draw(this.history.amplitude, { color: '#7ee08a' });
  }

  // ---------- 六方位 ----------
  _commitPosition(id) {
    if (!this.detector) { this._setStatus('请先开始采集再记录方位', 'warn'); return; }
    const snap = this.detector.snapshot();
    try {
      this.positionSession.commit(id, snap);
      this._renderPositions();
      this._renderPosSummary();
      if (this.positionSession.allDone) {
        this._setStatus('六方位测量完成，位差已汇总', 'ok');
      }
    } catch (err) {
      this._setStatus(err.message, 'warn');
    }
  }

  _renderPositions() {
    const grid = $('#posGrid');
    grid.innerHTML = POSITIONS.map((p) => {
      const rec = this.positionSession.get(p.id);
      return `
        <button class="pos-card ${rec ? 'done' : ''}" data-pos="${p.id}">
          <div class="pos-name">${p.zh}</div>
          <div class="pos-tag">${p.tag}</div>
          <div class="pos-rate">${rec ? `${rec.rateSd >= 0 ? '+' : ''}${rec.rateSd.toFixed(1)}` : '—'} <span>s/d</span></div>
          <div class="pos-sub">${rec ? `摆幅 ${rec.amplitudeDeg.toFixed(0)}° · 偏振 ${formatBeatErrorMs(rec.beatErrorMs)}` : '点击记录'}</div>
        </button>`;
    }).join('');
  }

  _renderPosSummary() {
    const sum = this.positionSession.summary();
    $('#posVariation').textContent = Number.isFinite(sum.rateVariationSd) ? `${sum.rateVariationSd.toFixed(1)} s/d` : '—';
    $('#posMeanRate').textContent = Number.isFinite(sum.meanRateSd) ? `${sum.meanRateSd >= 0 ? '+' : ''}${sum.meanRateSd.toFixed(1)} s/d` : '—';
    $('#posMinAmp').textContent = Number.isFinite(sum.minAmplitudeDeg) ? `${sum.minAmplitudeDeg.toFixed(0)}°` : '—';
    $('#posMaxBeat').textContent = Number.isFinite(sum.maxBeatErrorMs) ? formatBeatErrorMs(sum.maxBeatErrorMs) : '—';
  }

  _setStatus(text, level) {
    const el = $('#statusBar');
    el.textContent = text;
    el.className = `status ${level || ''}`;
  }

  stop() {
    if (this.capture) { this.capture.stop(); this.capture = null; }
    if (this._uiTimer) { clearInterval(this._uiTimer); this._uiTimer = null; }
    this.mode = 'idle';
    $('#btnMic').classList.remove('active');
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
