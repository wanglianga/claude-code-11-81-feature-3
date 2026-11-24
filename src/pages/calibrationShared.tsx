import type { Band, CoverageStatus } from '../domain/calibration';

export const BAND_LABEL: Record<Band, string> = { low: '低风险', high: '高风险', uncertain: '跨线（不确定）' };
export const BAND_TONE: Record<Band, 'ok' | 'block' | 'warn'> = { low: 'ok', high: 'block', uncertain: 'warn' };
export const STATUS_LABEL: Record<CoverageStatus, string> = {
  comparable: '可比',
  review: '待复核',
  missing_evidence: '缺证',
};
export const STATUS_TONE: Record<CoverageStatus, 'ok' | 'warn' | 'block'> = {
  comparable: 'ok',
  review: 'warn',
  missing_evidence: 'block',
};

export function intervalText(iv: { min: number; max: number } | null): string {
  if (!iv) return '未知';
  return iv.min === iv.max ? `${iv.min}` : `${iv.min} ~ ${iv.max}`;
}
