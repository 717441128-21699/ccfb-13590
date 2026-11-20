// 无依赖 WAV PCM 编解码：支持 16/24/32-bit 整数 PCM 与 32-bit float 单声道/立体声。
// 解码输出 Float64Array（多声道取平均为单声道），编码输出 16-bit 单声道 WAV。

function readStr(view, off, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(off + i));
  return s;
}

function findChunk(view, tag, start, end) {
  let off = start;
  while (off + 8 <= end) {
    const id = readStr(view, off, 4);
    const size = view.getUint32(off + 4, true);
    if (id === tag) return { off: off + 8, size };
    off += 8 + size + (size & 1);
  }
  return null;
}

// 解码 WAV → {samples: Float64Array, fs}
export function decodeWav(buffer) {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readStr(view, 0, 4) !== 'RIFF' || readStr(view, 8, 4) !== 'WAVE') {
    throw new Error('不是 WAV 文件（缺 RIFF/WAVE 头）');
  }
  const fmt = findChunk(view, 'fmt ', 12, bytes.length);
  if (!fmt) throw new Error('WAV 缺 fmt 块');
  const format = view.getUint16(fmt.off, true);
  const channels = view.getUint16(fmt.off + 2, true);
  const fs = view.getUint32(fmt.off + 4, true);
  const bits = view.getUint16(fmt.off + 14, true);
  const data = findChunk(view, 'data', 12, bytes.length);
  if (!data) throw new Error('WAV 缺 data 块');

  const frameBytes = bits / 8;
  const frames = Math.floor(data.size / (frameBytes * channels));
  const samples = new Float64Array(frames);
  const base = data.off;

  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let ch = 0; ch < channels; ch++) {
      const pos = base + (i * channels + ch) * frameBytes;
      acc += readSample(view, pos, format, bits);
    }
    samples[i] = acc / channels;
  }
  return { samples, fs, channels, bits };
}

function readSample(view, pos, format, bits) {
  if (format === 3 && bits === 32) return view.getFloat32(pos, true);
  if (bits === 16) return view.getInt16(pos, true) / 32768;
  if (bits === 24) {
    const lo = view.getUint8(pos);
    const mid = view.getUint8(pos + 1);
    const hi = view.getUint8(pos + 2);
    let v = lo | (mid << 8) | (hi << 16);
    if (v & 0x800000) v |= ~0xffffff; // 符号扩展
    return v / 8388608;
  }
  if (bits === 32) return view.getInt32(pos, true) / 2147483648;
  if (bits === 8) return (view.getUint8(pos) - 128) / 128;
  throw new Error(`不支持的采样格式: format=${format} bits=${bits}`);
}

// 编码 16-bit 单声道 WAV。自动按峰值归一化到 0.9 满量程，避免叠加信号超幅削顶。
export function encodeWav(samples, fs) {
  const n = samples.length;
  let peak = 1e-12;
  for (const v of samples) {
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  const gain = 0.9 / peak;
  const buf = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buf);
  const write = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i) & 255);
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, fs, true);
  view.setUint32(28, fs * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i] * gain));
    view.setInt16(44 + i * 2, Math.round(v * 32767), true);
  }
  return new Uint8Array(buf);
}
