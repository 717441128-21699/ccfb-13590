// worklet.js — AudioWorklet 处理器：把麦克风流切成固定块送主线程
// 累积到约 0.5 秒（或至少 4096 样本）后 postMessage，避免消息过频。
class FloatChunkProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(0);
    this.target = Math.round(sampleRate * 0.5);
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    const ch = input[0];
    if (!ch || !ch.length) return true;
    const merged = new Float32Array(this.buf.length + ch.length);
    merged.set(this.buf, 0);
    merged.set(ch, this.buf.length);
    this.buf = merged;
    if (this.buf.length >= this.target) {
      // 转 Float64 与分析器内部精度一致
      const out = new Float64Array(this.buf.length);
      for (let i = 0; i < this.buf.length; i++) out[i] = this.buf[i];
      this.port.postMessage(out.buffer, [out.buffer]);
      this.buf = new Float32Array(0);
    }
    return true;
  }
}
registerProcessor('float-chunk', FloatChunkProcessor);
