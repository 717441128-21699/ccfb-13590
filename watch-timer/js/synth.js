// synth.js — 机械表走时声合成器（带 ground truth 标签）
// 物理模型：摆轮简谐振动 angle(t)=A·sin(ωt)，擒纵三子声发生在
//   开锁 unlock  = 过平衡点前 δ 时刻（摆轮到升角边界、擒纵叉释放擒纵轮）
//   冲击 impulse = 过平衡点（摆轮撞叉瓦，能量注入）
//   落下 drop    = 过平衡点后 δ 时刻（叉瓦锁接下一轮齿）
// δ = arcsin(β/A)/ω，β=升角，A=摆幅。分析器的摆幅公式按同一约定反演。
// 每个子声 = 多组分衰减正弦；另支持日差、偏振、左右摆幅差、抖动、
// 背景噪、日历跳字、陀飞轮（周期异声+摆幅调制）、缺擒纵/弱擒纵/重复滴答等故障。

'use strict';

/** 可种子化的 PRNG（mulberry32），保证自检可复现 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller 高斯随机数（确定性，复用同一 PRNG） */
function gaussian(rand) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const DEFAULTS = {
  sampleRate: 96000,
  bph: 28800,                 // 摆频：18000 / 21600 / 25200 / 28800 / 36000
  ratePerDay: 0,              // 日差 s/day，正=快、负=慢
  beatErrorMs: 0,             // 偏振，带符号（奇数拍整体偏移 ms）
  liftAngleDeg: 52,           // 升角
  amplitudeDeg: [300, 296],   // [偶数拍侧, 奇数拍侧] 摆幅；也可传单值
  jitterUs: 12,               // 每个子声的时刻抖动 1σ
  noiseLevel: 0.012,          // 背景白噪幅度（峰值归一化）
  humLevel: 0.004,            // 50/100Hz 工频隆隆声
  subSounds: {                // 每个子声的音色与相对幅度
    unlock:  { freq: 6200, decayMs: 0.55, amp: 0.55, partials: [1.9, 3.05] },
    impulse: { freq: 3400, decayMs: 1.25, amp: 1.00, partials: [2.15] },
    drop:    { freq: 7100, decayMs: 0.80, amp: 0.70, partials: [1.8, 2.9] },
  },
  calendar: null,             // { everyBeats: 28800, pulseCount: 2..3 } 或 { atTimes: [秒...] }
  tourbillon: null,           // { periodSec: 60, ampModDeg: 12, thunkAmp: 0.35 }
  faults: null,               // { missingBeats:[], weakBeats:[], doubleTicks:[], extraRatePerSec:0, rateDriftPerDay:0 }
  seed: 20261121,
};

export class WatchSynth {
  constructor(opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    o.subSounds = { ...DEFAULTS.subSounds, ...(opts.subSounds || {}) };
    o.faults = { ...(opts.faults || {}) };
    this.o = o;
    this.fs = o.sampleRate;
    this.rand = mulberry32(o.seed);
    this.cursor = 0;                       // 已生成的样本数
    this.events = [];                      // ground truth
    this.beatCount = 0;
    this.nextCalendarBeat = o.calendar?.everyBeats ?? Infinity;
    this.calendarQueue = (o.calendar?.atTimes || []).slice().sort((a, b) => a - b);
  }

  /** 标称拍间隔（秒） */
  nominalBeatSec() { return 3600 / this.o.bph; }

  /** 考虑日差后的实际平均拍间隔 */
  effectiveBeatSec() {
    const B0 = this.nominalBeatSec();
    return B0 / (1 + this.o.ratePerDay / 86400);
  }

  /** 第 k 拍平衡点的绝对时间（秒），含日差、漂移、偏振 */
  equilibriumTime(k) {
    const B0 = this.nominalBeatSec();
    let t;
    if (this.o.faults?.rateDriftPerDay) {
      // 线性漂移：t(k)=B_eff·k + 0.5·ΔB·k²，ΔB 由每日漂移量换算
      const dB = -(this.o.faults.rateDriftPerDay / 86400) * B0;
      t = this.effectiveBeatSec() * k + 0.5 * dB * k * k;
    } else {
      t = this.effectiveBeatSec() * k;
    }
    if (k % 2 === 1) t += this.o.beatErrorMs / 1000;
    return t;
  }

  /** 第 k 拍的摆幅（含陀飞轮周期调制） */
  amplitudeForBeat(k) {
    const [a0, a1] = Array.isArray(this.o.amplitudeDeg)
      ? this.o.amplitudeDeg : [this.o.amplitudeDeg, this.o.amplitudeDeg];
    let A = (k % 2 === 0 ? a0 : a1);
    const tb = this.o.tourbillon;
    if (tb) {
      const t = this.equilibriumTime(k);
      A += (tb.ampModDeg ?? 10) * Math.sin(2 * Math.PI * t / tb.periodSec);
    }
    return A;
  }

  /** 升角对应的 δ（平衡点到开锁/落下的时间偏移，秒）
   *  几何：|θ_peak|=A，开锁于 |θ|=β → sin(ωδ)=sinβ/|sinA|（取绝对值，跨 180° 分支通用） */
  deltaForBeat(k) {
    const A = this.amplitudeForBeat(k) * Math.PI / 180;
    const beta = this.o.liftAngleDeg * Math.PI / 180;
    const B = this.effectiveBeatSec();
    const omega = Math.PI / B;                       // 摆轮角频率，T_osc=2B
    const ratio = Math.min(1, Math.sin(beta) / Math.abs(Math.sin(A)));
    return Math.asin(ratio) / omega;
  }

  /** 在缓冲指定位置叠加一个衰减正弦瞬态（含泛音、随机初相） */
  emitTransient(buf, centerSample, spec, gainScale = 1) {
    const fs = this.fs;
    const t0 = centerSample;
    const tau = spec.decayMs / 1000;
    const decaySamples = Math.ceil(fs * tau * 4);
    const phases = [0, this.rand() * 6.283, this.rand() * 6.283];
    const comps = [{ f: spec.freq, a: 1 }, ...(spec.partials || []).map((p, i) => ({ f: spec.freq * p, a: 0.35 / (i + 1) }))];
    for (let i = -Math.round(fs * tau * 0.6); i < decaySamples; i++) {
      const idx = Math.round(t0) + i;
      if (idx < 0 || idx >= buf.length) continue;
      const tt = i / fs;
      if (tt < 0) continue;
      const env = Math.exp(-tt / tau);
      let v = 0;
      comps.forEach((c, ci) => {
        v += c.a * Math.sin(2 * Math.PI * c.f * tt + phases[ci]);
      });
      buf[idx] += spec.amp * gainScale * env * v * 0.32;
    }
  }

  emitCalendar(buf, centerSample, strength = 1) {
    // 低频、多脉冲、宽衰减的"闷响"，主频远低于擒纵声（3–7kHz），质心明显偏低
    const base = { freq: 480 + this.rand() * 160, decayMs: 12 + this.rand() * 6, amp: 1.1 * strength, partials: [1.4] };
    this.emitTransient(buf, centerSample, base, 0.8);
    this.events.push({ t: centerSample / this.fs + this.cursor / this.fs, type: 'calendar' });
  }

  emitTourbillonThunk(buf, centerSample) {
    const spec = { freq: 1400 + this.rand() * 500, decayMs: 4.5, amp: (this.o.tourbillon.thunkAmp ?? 0.3), partials: [1.7] };
    this.emitTransient(buf, centerSample, spec, 0.7);
    this.events.push({ t: (this.cursor + centerSample) / this.fs, type: 'tourbillon' });
  }

  /** 生成下一块音频；返回 Float64Array（长度 numSamples） */
  nextChunk(numSamples) {
    const buf = new Float64Array(numSamples);
    const fs = this.fs;
    const B = this.effectiveBeatSec();
    const tStart = this.cursor / fs;
    const tEnd = (this.cursor + numSamples) / fs;

    // 1) 背景：白噪 + 工频隆隆
    for (let i = 0; i < numSamples; i++) {
      const t = tStart + i / fs;
      buf[i] = (this.rand() * 2 - 1) * this.o.noiseLevel
        + Math.sin(2 * Math.PI * 50 * t) * this.o.humLevel
        + Math.sin(2 * Math.PI * 100 * t + 1.3) * this.o.humLevel * 0.5;
    }

    // 2) 擒纵拍：覆盖本块时间范围的所有拍
    let k = Math.max(0, Math.floor(tStart / B) - 2);
    const faults = this.o.faults;
    while (true) {
      const tEq = this.equilibriumTime(k);
      if (tEq > tEnd + B) break;
      const delta = this.deltaForBeat(k);
      const missing = faults?.missingBeats?.includes(k);
      const weak = faults?.weakBeats?.includes(k);
      const plan = [
        { type: 'unlock', off: -delta },
        { type: 'impulse', off: 0 },
        { type: 'drop', off: delta },
      ];
      if (!missing && tEq > tStart - 0.01 && tEq < tEnd + 0.01) {
        const gain = weak ? 0.22 : 1;
        for (const p of plan) {
          const jitter = gaussian(this.rand) * (this.o.jitterUs / 1e6);
          const tEv = tEq + p.off + jitter;
          const idx = Math.round((tEv - tStart) * fs);
          if (idx >= 0 && idx < numSamples) {
            this.emitTransient(buf, idx, this.o.subSounds[p.type], gain);
            this.events.push({
              t: tEv, type: p.type, beat: k,
              side: k % 2 === 0 ? 'L' : 'R',
              amplitudeDeg: this.amplitudeForBeat(k),
            });
          }
        }
        // 故障：重复滴答（在真实拍附近多一个瞬态）
        if (faults?.doubleTicks?.includes(k)) {
          const idx = Math.round((tEq + B * 0.18 + gaussian(this.rand) * 0.0008 - tStart) * fs);
          if (idx >= 0 && idx < numSamples) {
            this.emitTransient(buf, idx, this.o.subSounds.impulse, 0.5);
            this.events.push({ t: tEq + B * 0.18, type: 'extra', beat: k });
          }
        }
      }
      // 日历跳字：本块拍号达到/越过下一个日历拍即触发（分块边界不会跳过）
      if (this.o.calendar && k >= this.nextCalendarBeat) {
        // 放在拍间隙（约 0.55B 处），避开冲击簇，便于分析器作为独立异声检出
        const calT = this.equilibriumTime(this.nextCalendarBeat) + B * (0.55 + this.rand() * 0.15);
        const idx = Math.round((calT - tStart) * fs);
        if (idx >= 0 && idx < numSamples) {
          const pulses = this.o.calendar.pulseCount ?? 2;
          for (let p = 0; p < pulses; p++) {
            this.emitCalendar(buf, idx + Math.round((p * (2.2 + this.rand())) * fs / 1000));
          }
          // 仅在本块真正发声后才推进，避免跨块时静默跳过
          while (this.nextCalendarBeat <= k) this.nextCalendarBeat += this.o.calendar.everyBeats;
        }
      }
      k++;
      this.beatCount = Math.max(this.beatCount, k);
    }

    // 3) 日历绝对时间队列
    while (this.calendarQueue.length && this.calendarQueue[0] <= tEnd) {
      const tc = this.calendarQueue.shift();
      const idx = Math.round((tc - tStart) * fs);
      if (idx >= 0 && idx < numSamples) this.emitCalendar(buf, idx, 1.1);
    }

    // 4) 陀飞轮：周期性轻"咯"声 + 摆幅已在 amplitudeForBeat 内调制
    if (this.o.tourbillon) {
      const P = this.o.tourbillon.periodSec;
      let m = Math.max(0, Math.floor(tStart / P));
      for (; m * P < tEnd; m++) {
        const tt = m * P + (this.rand() - 0.5) * 0.02;
        const idx = Math.round((tt - tStart) * fs);
        if (idx >= 0 && idx < numSamples) this.emitTourbillonThunk(buf, idx);
      }
    }

    // 5) 泊松随机异声（磕碰等）
    if (faults?.extraRatePerSec > 0) {
      const lambda = faults.extraRatePerSec * numSamples / fs;
      let n = 0;
      // 小概率逐样本代价高，按期望数生成
      const expected = Math.round(lambda + 0.5);
      for (let q = 0; q < expected; q++) {
        if (this.rand() > lambda / Math.max(1, expected)) continue;
        const idx = Math.floor(this.rand() * numSamples);
        const spec = { freq: 700 + this.rand() * 900, decayMs: 3 + this.rand() * 6, amp: 0.6 + this.rand() * 0.5, partials: [1.4] };
        this.emitTransient(buf, idx, spec, 0.8);
        this.events.push({ t: tStart + idx / fs, type: 'extra' });
        n++;
      }
    }

    this.cursor += numSamples;
    return buf;
  }

  /** 一次性生成 durationSec 秒（测试用便捷方法） */
  generate(durationSec) {
    const n = Math.round(durationSec * this.fs);
    const chunks = [];
    const block = Math.min(n, this.fs * 2);
    let done = 0;
    while (done < n) {
      const m = Math.min(block, n - done);
      chunks.push(this.nextChunk(m));
      done += m;
    }
    const all = new Float64Array(n);
    let off = 0;
    for (const c of chunks) { all.set(c, off); off += c.length; }
    return all;
  }

  /** 真值汇总（自检对照用） */
  groundTruth() {
    return {
      bph: this.o.bph,
      ratePerDay: this.o.ratePerDay,
      beatErrorMs: this.o.beatErrorMs,
      liftAngleDeg: this.o.liftAngleDeg,
      amplitudeDeg: this.o.amplitudeDeg,
      events: this.events.slice(),
    };
  }
}

/** 常用测试场景预设（自检与页面演示共用） */
export const SCENARIOS = {
  clean28800: { bph: 28800, ratePerDay: 3, beatErrorMs: 0.4, amplitudeDeg: [305, 300], noiseLevel: 0.01 },
  clean18000: { bph: 18000, ratePerDay: -8, beatErrorMs: 1.2, amplitudeDeg: [285, 278], noiseLevel: 0.012 },
  calendar:  { bph: 28800, ratePerDay: 0, beatErrorMs: 0.2, calendar: { everyBeats: 120, pulseCount: 3 }, noiseLevel: 0.01 },
  tourbillon:{ bph: 21600, ratePerDay: 2, beatErrorMs: 0.3, tourbillon: { periodSec: 60, ampModDeg: 6, thunkAmp: 0.32 }, noiseLevel: 0.011 },
  sick:      { bph: 28800, ratePerDay: 25, beatErrorMs: 2.4, amplitudeDeg: [240, 225], noiseLevel: 0.02,
               faults: { missingBeats: [40, 137], weakBeats: [88], doubleTicks: [70], extraRatePerSec: 0.05, rateDriftPerDay: 1 } },
  noisy36000:{ bph: 36000, ratePerDay: -2, beatErrorMs: 0.15, amplitudeDeg: [310, 308], noiseLevel: 0.018, jitterUs: 20 },
};
