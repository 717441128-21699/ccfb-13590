// RBJ 双二阶滤波器（Audio EQ Cookbook），流式逐样本处理，浏览器与 Node 通用。
// 级联多个 Biquad 可构成较陡的带通/高通，全部为零依赖实现。

export class Biquad {
  constructor(b, a) {
    this.b0 = b[0]; this.b1 = b[1]; this.b2 = b[2];
    this.a1 = a[1]; this.a2 = a[2];
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
  }

  reset() {
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
  }

  // 单个样本
  step(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2
      - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }

  // 整段处理（原地）
  process(buf) {
    for (let i = 0; i < buf.length; i++) {
      const x = buf[i];
      const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2
        - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1; this.x1 = x;
      this.y2 = this.y1; this.y1 = y;
      buf[i] = y;
    }
    return buf;
  }
}

// 高通
export function highpass(fs, f0, q = 0.70710678) {
  const w0 = 2 * Math.PI * f0 / fs;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * q);
  const b0 = (1 + cw) / 2, b1 = -(1 + cw), b2 = (1 + cw) / 2;
  const a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
  return new Biquad([b0 / a0, b1 / a0, b2 / a0], [1, a1 / a0, a2 / a0]);
}

// 低通
export function lowpass(fs, f0, q = 0.70710678) {
  const w0 = 2 * Math.PI * f0 / fs;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * q);
  const b0 = (1 - cw) / 2, b1 = 1 - cw, b2 = (1 - cw) / 2;
  const a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
  return new Biquad([b0 / a0, b1 / a0, b2 / a0], [1, a1 / a0, a2 / a0]);
}

// 恒定 0dB 增益的带通峰（RBJ bandpass, BW_Q 形式）
export function bandpass(fs, f0, q = 1) {
  const w0 = 2 * Math.PI * f0 / fs;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * q);
  const b0 = alpha, b1 = 0, b2 = -alpha;
  const a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
  return new Biquad([b0 / a0, b1 / a0, b2 / a0], [1, a1 / a0, a2 / a0]);
}

// 陷波（市电 50Hz 等稳态干扰）
export function notch(fs, f0, q = 30) {
  const w0 = 2 * Math.PI * f0 / fs;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * q);
  const b0 = 1, b1 = -2 * cw, b2 = 1;
  const a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
  return new Biquad([b0 / a0, b1 / a0, b2 / a0], [1, a1 / a0, a2 / a0]);
}

// 级联滤波器组：同一输入依次通过，保留全部滤波器状态（流式可用）
export class FilterChain {
  constructor(filters) {
    this.filters = filters;
  }

  reset() {
    for (const f of this.filters) f.reset();
  }

  step(x) {
    for (const f of this.filters) x = f.step(x);
    return x;
  }

  process(buf) {
    for (const f of this.filters) f.process(buf);
    return buf;
  }
}

// 机械表咔嗒声的能量主要落在 1.5k–12kHz；用高通去桌面隆隆声/棕噪 + 带通峰群选频。
// 高通取 1.4kHz：擒纵子声的主共振在 2.6kHz 以上，1.4kHz 以下基本是环境低频噪声。
export function makeWatchBandpass(fs) {
  const chain = [highpass(fs, 1400, 0.707)];
  // 三个带通峰覆盖主要共振区，Q 适中避免把瞬态拖尾拉太长
  for (const [fc, q] of [[2600, 1.6], [5200, 2.0], [8500, 2.4]]) {
    if (fc < fs / 2 - 200) chain.push(bandpass(fs, fc, q));
  }
  return new FilterChain(chain);
}
