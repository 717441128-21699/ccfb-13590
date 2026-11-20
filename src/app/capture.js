// 麦克风采集：优先 AudioWorklet（低延迟、主线程不阻塞），
// 不支持时自动降级到 ScriptProcessorNode（兼容性兜底）。
// 输出统一为 {pcm: Float32Array, fs, timeMs} 块，交给检测器。

export class MicCapture {
  constructor(onChunk, opts = {}) {
    this.onChunk = onChunk;
    this.opts = opts;
    this.audioCtx = null;
    this.stream = null;
    this.source = null;
    this.workletNode = null;
    this.processorNode = null;
    this.running = false;
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('浏览器不支持麦克风采集（需要 HTTPS 或 localhost 环境）');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,   // 关闭语音处理，保留机械表原始瞬态
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const preferredFs = this.opts.preferredFs || 48000;
    this.audioCtx = new Ctx({ sampleRate: preferredFs });
    await this.audioCtx.resume();
    this.source = this.audioCtx.createMediaStreamSource(this.stream);
    this.fs = this.audioCtx.sampleRate;

    if (this.audioCtx.audioWorklet) {
      try {
        await this.audioCtx.audioWorklet.addURL
          ? this.audioCtx.audioWorklet.addURL(this._workletURL())
          : await this.audioCtx.audioWorklet.addModule(this._workletURL());
        this.workletNode = new AudioWorkletNode(this.audioCtx, 'watch-pcm-processor', {
          numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1,
        });
        this.workletNode.port.onmessage = (ev) => {
          if (this.running && ev.data.pcm) this.onChunk(ev.data.pcm, this.fs);
        };
        this.source.connect(this.workletNode);
        this.workletNode.connect(this.audioCtx.destination);
      } catch (e) {
        this._startScriptProcessor();
      }
    } else {
      this._startScriptProcessor();
    }
    this.running = true;
    return this.fs;
  }

  _startScriptProcessor() {
    const bufSize = 4096;
    this.processorNode = this.audioCtx.createScriptProcessor(bufSize, 1, 1);
    this.processorNode.onaudioprocess = (ev) => {
      if (!this.running) return;
      const pcm = ev.inputBuffer.getChannelData(0).slice();
      this.onChunk(pcm, this.fs);
    };
    this.source.connect(this.processorNode);
    this.processorNode.connect(this.audioCtx.destination);
  }

  // Worklet 代码用 Blob 内联，避免额外文件和路径问题。
  _workletURL() {
    if (this._url) return this._url;
    const code = `
      class WatchPcmProcessor extends AudioWorkletProcessor {
        process(inputs) {
          const ch = inputs[0] && inputs[0][0];
          if (ch && ch.length) this.port.postMessage({ pcm: ch.slice() });
          return true;
        }
      }
      registerProcessor('watch-pcm-processor', WatchPcmProcessor);
    `;
    const blob = new Blob([code], { type: 'application/javascript' });
    this._url = URL.createObjectURL(blob);
    return this._url;
  }

  stop() {
    this.running = false;
    try { this.workletNode?.port.close(); } catch { /* ignore */ }
    try { this.workletNode?.disconnect(); } catch { /* ignore */ }
    try { this.processorNode?.disconnect(); } catch { /* ignore */ }
    try { this.source?.disconnect(); } catch { /* ignore */ }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
    }
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.close().catch(() => {});
    }
    this.stream = null;
    this.audioCtx = null;
  }
}
