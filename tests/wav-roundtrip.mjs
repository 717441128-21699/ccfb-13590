// WAV 编解码往返 + 合成信号导出一致性测试。
import { synthWatch } from '../src/core/synth.js';
import { encodeWav, decodeWav } from '../src/core/wav.js';
import { analyzeBuffer } from '../src/core/detector.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`✔ ${name}`);
  else { failures++; console.log(`✘ ${name} ${detail}`); }
}

// 1. 合成 → 编码 16-bit WAV → 解码 → 检测，指标应与直接分析一致
const { samples, truth } = synthWatch({
  bph: 28800, rateSd: 6, beatErrorMs: 0.5, amplitudeDeg: 275,
  seconds: 40, snrDb: 30, seed: 99,
});
const wav = encodeWav(samples, 48000);
check('WAV 含 RIFF 头', wav[0] === 0x52 && wav[1] === 0x49 && wav[2] === 0x46);
check('WAV 字节长度正确', wav.length === 44 + samples.length * 2, `got ${wav.length}`);

const decoded = decodeWav(wav.buffer);
check('解码采样率 48000', decoded.fs === 48000);
check('解码样本数一致', decoded.samples.length === samples.length);
// 16-bit 量化 + 编码器峰值归一化，误差只应来自量化（< 1/32767 加增益容差）
let peak = 1e-12;
for (const v of samples) peak = Math.max(peak, Math.abs(v));
const gain = 0.9 / peak;
let maxErr = 0;
for (let i = 0; i < samples.length; i++) {
  maxErr = Math.max(maxErr, Math.abs(decoded.samples[i] - samples[i] * gain));
}
check('归一化后量化误差 < 2/32768', maxErr <= 2 / 32768, `maxErr=${maxErr}`);

// 解码后检测结果
const direct = analyzeBuffer(samples, 48000).snapshot;
const fromWav = analyzeBuffer(decoded.samples, 48000).snapshot;
check('WAV 分析同样锁定', fromWav.locked && fromWav.bph === 28800);
check('WAV 日差与直测一致', Math.abs(fromWav.rateSd - direct.rateSd) < 0.3,
  `${fromWav.rateSd} vs ${direct.rateSd}`);
check('WAV 摆幅与直测一致', Math.abs(fromWav.amplitudeDeg - direct.amplitudeDeg) < 3,
  `${fromWav.amplitudeDeg} vs ${direct.amplitudeDeg}`);

// 2. 多声道 WAV（立体声 → 取平均为单声道）
function makeStereoWav() {
  const fs = 8000, n = 1000;
  const buf = new ArrayBuffer(44 + n * 4);
  const v = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); ws(8, 'WAVE'); ws(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, fs, true); v.setUint32(28, fs * 4, true);
  v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    v.setInt16(44 + i * 4, 1000, true);
    v.setInt16(46 + i * 4, 2000, true);
  }
  return new Uint8Array(buf);
}
const stereo = decodeWav(makeStereoWav().buffer);
check('立体声 WAV 正确取平均', stereo.channels === 2 && Math.abs(stereo.samples[10] - (1000 + 2000) / 2 / 32768) < 1e-6);

// 3. 坏文件抛错
let threw = false;
try { decodeWav(new Uint8Array([1, 2, 3, 4]).buffer); } catch { threw = true; }
check('非 WAV 数据正确抛错', threw);

console.log(failures === 0 ? '\nWAV 测试全部通过 ✔' : `\n${failures} 项失败 ✘`);
process.exit(failures ? 1 : 0);
