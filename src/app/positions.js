// 六方位位差测量管理：每个方位独立采集一段稳定窗口，记录日差/摆幅/偏振，
// 全部测完汇总位差（最大-最小日差）。方位定义沿用 geometry.POSITIONS。

import { POSITIONS } from '../core/geometry.js';

export class PositionSession {
  constructor() {
    this.records = new Map(); // positionId -> {rateSd, amplitudeDeg, beatErrorMs, bph, samples}
    this.currentId = null;
  }

  begin(id) {
    this.currentId = id;
  }

  // 用当前快照提交一个方位的测量结果。要求已锁定且样本足够。
  commit(id, snap) {
    if (!snap.locked || !Number.isFinite(snap.rateSd)) {
      throw new Error('信号尚未稳定锁定，无法记录该方位');
    }
    this.records.set(id, {
      rateSd: snap.rateSd,
      amplitudeDeg: snap.amplitudeDeg,
      beatErrorMs: snap.beatErrorMs,
      bph: snap.bph,
      tLiftMs: snap.tLiftMs,
      quality: { ...snap.quality },
    });
    if (this.currentId === id) this.currentId = null;
    return this.records.get(id);
  }

  get(id) { return this.records.get(id); }
  get doneCount() { return this.records.size; }
  get allDone() { return this.records.size === POSITIONS.length; }

  // 位差汇总
  summary() {
    const rows = POSITIONS.map((p) => ({ ...p, record: this.records.get(p.id) || null }));
    const rates = rows.map((r) => r.record?.rateSd).filter(Number.isFinite);
    const amps = rows.map((r) => r.record?.amplitudeDeg).filter(Number.isFinite);
    const beats = rows.map((r) => r.record?.beatErrorMs).filter(Number.isFinite);
    return {
      rows,
      rateVariationSd: rates.length >= 2 ? Math.max(...rates) - Math.min(...rates) : NaN,
      meanRateSd: rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : NaN,
      minAmplitudeDeg: amps.length ? Math.min(...amps) : NaN,
      maxBeatErrorMs: beats.length ? Math.max(...beats) : NaN,
    };
  }

  clear() { this.records.clear(); this.currentId = null; }
}
