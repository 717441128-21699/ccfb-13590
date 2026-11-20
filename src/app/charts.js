// 零依赖 Canvas 图表：时序条图（校表仪经典纸带）、子声结构图、日差/摆幅曲线。
// 全部支持设备像素比缩放，深色主题，重绘由调用方按需触发。

function setup(ctx, cssW, cssH, dpr) {
  ctx.canvas.width = Math.round(cssW * dpr);
  ctx.canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = '11px system-ui, sans-serif';
}

export class TimingChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;
  }

  // ticks: [{k, rateSd, parity}]，画经典校表仪纸带：每拍一个点，纵向偏差=瞬时日差。
  draw(ticks, opts = {}) {
    const w = this.canvas.clientWidth || 600;
    const h = this.canvas.clientHeight || 200;
    const ctx = this.ctx;
    setup(ctx, w, h, this.dpr);
    ctx.clearRect(0, 0, w, h);

    const padL = 44, padR = 12, padT = 12, padB = 22;
    const plotW = w - padL - padR, plotH = h - padT - padB;

    // 纵轴量程 ±60 s/d（超出裁剪），0 线居中
    const yMax = opts.yMax || 60;
    const yOf = (rate) => padT + plotH / 2 - (rate / yMax) * (plotH / 2);

    // 网格 + 刻度
    ctx.strokeStyle = '#26303f'; ctx.fillStyle = '#7c8aa0'; ctx.lineWidth = 1;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const g of [-60, -30, 0, 30, 60]) {
      const y = yOf(g);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y);
      ctx.strokeStyle = g === 0 ? '#3d4c63' : '#1e2733';
      ctx.stroke();
      ctx.fillText(`${g}`, padL - 6, y);
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText('s/d', padL - 22, padT - 2);

    if (!ticks.length) {
      ctx.fillStyle = '#5b6a82'; ctx.textAlign = 'center';
      ctx.fillText('等待节拍数据…', w / 2, h / 2);
      return;
    }

    // 最近 N 拍横向铺开，奇偶（tic/tac）用不同颜色
    const N = Math.min(ticks.length, opts.maxTicks || 160);
    const view = ticks.slice(-N);
    const xStep = plotW / Math.max(1, N - 1);
    for (let i = 0; i < view.length; i++) {
      const t = view[i];
      const x = padL + i * xStep;
      const rate = Math.max(-yMax, Math.min(yMax, t.rateSd));
      const y = yOf(rate);
      ctx.fillStyle = t.parity > 0 ? '#4ea1ff' : '#ff9d4d';
      ctx.beginPath();
      ctx.arc(x, y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    // 图例
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillStyle = '#4ea1ff'; ctx.fillRect(padL, h - 14, 8, 8);
    ctx.fillStyle = '#9fb2cc'; ctx.fillText('tic(偶)', padL + 12, h - 13);
    ctx.fillStyle = '#ff9d4d'; ctx.fillRect(padL + 70, h - 14, 8, 8);
    ctx.fillStyle = '#9fb2cc'; ctx.fillText('tac(奇)', padL + 82, h - 13);
  }
}

export class SubSoundChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;
  }

  // 画单个拍的三子声 P1/P2/P3 时刻与 tLift 标注。
  // tick: {p1T,p2T,p3T}，相对 P1 归一到 0。
  draw(tick, tLiftMs) {
    const w = this.canvas.clientWidth || 600;
    const h = this.canvas.clientHeight || 120;
    const ctx = this.ctx;
    setup(ctx, w, h, this.dpr);
    ctx.clearRect(0, 0, w, h);
    if (!tick || !isFinite(tick.p1T)) {
      ctx.fillStyle = '#5b6a82'; ctx.textAlign = 'center';
      ctx.fillText('子声数据不足', w / 2, h / 2);
      return;
    }
    const padL = 40, padR = 20, padT = 26, padB = 28;
    const plotW = w - padL - padR;
    const t0 = tick.p1T;
    const events = [
      { t: tick.p1T, label: 'P1 开锁', color: '#4ea1ff' },
      isFinite(tick.p2T) ? { t: tick.p2T, label: 'P2 冲击', color: '#7ee08a' } : null,
      { t: tick.p3T, label: 'P3 落下', color: '#ff6b6b' },
    ].filter(Boolean);
    const span = Math.max(0.008, (tick.p3T - t0) * 1.25);
    const xOf = (t) => padL + ((t - t0) / span) * plotW;

    // 基线
    ctx.strokeStyle = '#2a3543'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(padL, h - padB); ctx.lineTo(w - padR, h - padB); ctx.stroke();

    events.forEach((e, idx) => {
      const x = xOf(e.t);
      const barH = idx === events.length - 1 ? 56 : idx === 0 ? 40 : 48;
      ctx.fillStyle = e.color;
      ctx.fillRect(x - 2, h - padB - barH, 4, barH);
      ctx.fillStyle = e.color; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(e.label, x, h - padB - barH - 4);
      ctx.fillStyle = '#9fb2cc'; ctx.textBaseline = 'top';
      ctx.fillText(`${((e.t - t0) * 1000).toFixed(2)}ms`, x, h - padB + 6);
    });

    // tLift 跨度箭头
    if (isFinite(tLiftMs)) {
      const x1 = xOf(tick.p1T), x3 = xOf(tick.p3T);
      ctx.strokeStyle = '#c9d4e6'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x1, padT); ctx.lineTo(x3, padT);
      ctx.moveTo(x1, padT - 3); ctx.lineTo(x1, padT + 3);
      ctx.moveTo(x3, padT - 3); ctx.lineTo(x3, padT + 3); ctx.stroke();
      ctx.fillStyle = '#c9d4e6'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(`升角时间 tLift = ${tLiftMs.toFixed(2)} ms`, (x1 + x3) / 2, padT - 4);
    }
  }
}

export class TrendChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;
  }

  // 历史曲线：values 为 [{t, value}]，valueLabel 标注单位，ref 参考线。
  draw(values, opts = {}) {
    const w = this.canvas.clientWidth || 300;
    const h = this.canvas.clientHeight || 90;
    const ctx = this.ctx;
    setup(ctx, w, h, this.dpr);
    ctx.clearRect(0, 0, w, h);
    const padL = 8, padR = 8, padT = 8, padB = 8;
    if (!values || values.length < 2) {
      ctx.fillStyle = '#5b6a82'; ctx.textAlign = 'center';
      ctx.fillText('积累数据中…', w / 2, h / 2);
      return;
    }
    const v = values.map((d) => d.value).filter(isFinite);
    if (v.length < 2) return;
    let lo = Math.min(...v), hi = Math.max(...v);
    if (opts.ref !== undefined) { lo = Math.min(lo, opts.ref); hi = Math.max(hi, opts.ref); }
    if (hi - lo < 1e-6) { hi += 1; lo -= 1; }
    const pad = (hi - lo) * 0.15; lo -= pad; hi += pad;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const yOf = (val) => padT + plotH - ((val - lo) / (hi - lo)) * plotH;
    const xStep = plotW / (values.length - 1);

    if (opts.ref !== undefined) {
      ctx.strokeStyle = '#3d4c63'; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(padL, yOf(opts.ref)); ctx.lineTo(w - padR, yOf(opts.ref)); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.strokeStyle = opts.color || '#4ea1ff'; ctx.lineWidth = 1.6;
    ctx.beginPath();
    values.forEach((d, i) => {
      if (!isFinite(d.value)) return;
      const x = padL + i * xStep, y = yOf(d.value);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
}
