// 钟表度量几何：摆幅、日差、偏振、升角时间窗。
// 公式与行业开源校表实现（advanced_timegrapher / Witschi 惯例）核对一致：
//   摆幅 A = LA / (2·sin(π·f·t_lift))，f = BPH/7200，t_lift = P3-P1（秒）
//   反函数 t_lift = asin(LA/(2A)) / (π·f)
//   日差 rate = (T_标称/T_实测 - 1)·86400  秒/天，正=快
//   偏振 beatError = 2|c|，c 为奇偶拟合的不对称项（秒）

import { balanceFrequencyHz, nominalBeatPeriodSec } from '../dsp/period.js';

export const DEFAULT_LIFT_ANGLE_DEG = 52;
export const SECONDS_PER_DAY = 86400;

// 由升角时间（开锁 P1 → 落下 P3）计算摆幅，单位度。
// tLiftSec 超出物理可行域时返回 NaN。
export function amplitudeFromLiftTime(tLiftSec, liftAngleDeg, bph) {
  if (!(tLiftSec > 0)) return NaN;
  const f = balanceFrequencyHz(bph);
  const s = Math.sin(Math.PI * f * tLiftSec);
  if (!(s > 0)) return NaN;
  const amp = liftAngleDeg / (2 * s);
  if (amp <= 0 || amp > 360) return NaN;
  return amp;
}

// 反函数：给定真实摆幅求理论升角时间（合成器用，保证检算闭环）。
export function liftTimeFromAmplitude(amplitudeDeg, liftAngleDeg, bph) {
  const ratio = liftAngleDeg / (2 * amplitudeDeg);
  if (!(ratio > 0 && ratio < 1)) {
    throw new Error(`摆幅 ${amplitudeDeg}° 对升角 ${liftAngleDeg}° 不可行（需 A > LA/2）`);
  }
  const f = balanceFrequencyHz(bph);
  return Math.asin(ratio) / (Math.PI * f);
}

// 升角时间的物理搜索窗：摆幅范围 (aLo, aHi) 度 → (tMin, tMax) 秒。
// 摆幅越大，升角时间越短。
export function liftTimeWindowSec(bph, liftAngleDeg, amplitudeRangeDeg) {
  const [aLo, aHi] = amplitudeRangeDeg;
  const tHi = liftTimeFromAmplitude(aLo, liftAngleDeg, bph); // 小摆幅 → 长时间
  const tLo = liftTimeFromAmplitude(aHi, liftAngleDeg, bph); // 大摆幅 → 短时间
  return [tLo, tHi];
}

// 日差（秒/天）。measuredPeriodSec 为实测节拍半周期，bph 给出标称值。
export function rateFromPeriod(measuredPeriodSec, bph) {
  const nominal = nominalBeatPeriodSec(bph);
  return (nominal / measuredPeriodSec - 1) * SECONDS_PER_DAY;
}

// 偏振（毫秒）= 2|c|，c 为 fitParityLine 返回的奇偶不对称项（秒）。
export function beatErrorMs(paritySec) {
  return 2 * Math.abs(paritySec) * 1000;
}

// 偏振显示：0.1ms 分辨率，<0.05ms 显示 "< 0.1 ms"（行业惯例）。
export function formatBeatErrorMs(valueMs) {
  if (!Number.isFinite(valueMs)) return '—';
  if (valueMs < 0.05) return '< 0.1 ms';
  return `${valueMs.toFixed(1)} ms`;
}

// 单点时序图偏差（毫秒/天量纲用 s/d）：把某一拍相对理想网格的残差换算成日差。
// 残差 ms 与日差 s/d 的换算：rate_i = -residualSec / P_nominal · 86400
export function residualToRateSd(residualSec, bph) {
  const nominal = nominalBeatPeriodSec(bph);
  return -residualSec / nominal * SECONDS_PER_DAY;
}

// 六个测试方位（中文校表仪惯例）。faceUp/faceDown 为字面向上/下，数字为柄头方位。
export const POSITIONS = [
  { id: 'DU', zh: '字面向上', en: 'dial up', tag: 'DU' },
  { id: 'DD', zh: '字面向下', en: 'dial down', tag: 'DD' },
  { id: 'CU', zh: '柄上', en: 'crown up (12H)', tag: 'CU' },
  { id: 'CR', zh: '柄右', en: 'crown right (3H)', tag: 'CR' },
  { id: 'CL', zh: '柄左', en: 'crown left (9H)', tag: 'CL' },
  { id: 'CD', zh: '柄下', en: 'crown down (6H)', tag: 'CD' },
];

// 位差：六方位最大日差与最小日差之差（s/d），以及最大绝对偏振等汇总。
export function positionVariation(rateByPosition) {
  const vals = rateByPosition.filter((v) => Number.isFinite(v));
  if (vals.length < 2) return NaN;
  return Math.max(...vals) - Math.min(...vals);
}
