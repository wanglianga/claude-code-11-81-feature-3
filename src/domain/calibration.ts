// 淤积口径复算领域逻辑：百分比换算、校准确认、对照表、旧记录回填资格、贡献分解、
// 覆盖图与已发布图层回放。全部为纯函数，可在测试与 Worker 内复用，不依赖 DOM。
//
// 关键约束（与题目叙事一一对应）：
// 1) 百分比 = 同一断面淤积深度 / 当次管内径，先统一单位（厘米 -> 毫米）；
// 2) 契约按「来源 + 采集时间」选择当时有效版本，迟到记录仍按采集时间解释；
// 3) 只有同一断面、同次巡检的等级与量测可配成校准对；跨期复测经同断面与清淤记录关联；
// 4) 统一表取同等级各规程校准范围的最小下界与最大上界（可能横跨风险线）；
//    分规程表按规程收窄区间，但需分别追踪校准证据，规程缺失时保留全部可能规程的范围；
// 5) 换算区间横跨风险线 / 适用证据不足 / 同次实测与换算异带 => 阻止自动回填；
// 6) 贡献分解锁定拓扑与其他特征，按「观测 -> 换算规则 -> 模型参数」逐项替换求差。
import { round3 } from './geometry';
import { fnv1a } from './hash';

/** 风险线：风险分数（= 淤积百分比 + 模型偏置）达到该值即为高风险 */
export const SCORE_THRESHOLD = 30;
/** 默认模型偏置 */
export const DEFAULT_BIAS = 0;

export type Procedure = 'P_A' | 'P_B';
export const ALL_PROCEDURES: readonly Procedure[] = ['P_A', 'P_B'] as const;
export const PROCEDURE_LABEL: Record<Procedure, string> = { P_A: '规程甲', P_B: '规程乙' };

export type Grade = 'G2' | 'G3';
export const GRADES: readonly Grade[] = ['G2', 'G3'] as const;
export const GRADE_LABEL: Record<Grade, string> = { G2: '等级 2', G3: '等级 3' };

export type DepthUnit = 'mm' | 'cm';
export type ConversionMode = 'unified' | 'per_procedure';
export type Band = 'low' | 'high' | 'uncertain';
export type CoverageStatus = 'comparable' | 'review' | 'missing_evidence';

export interface Interval {
  min: number;
  max: number;
}

/** 厘米 -> 毫米（先统一单位，再做百分比换算） */
export function toMillimeter(value: number, unit: DepthUnit): number {
  return unit === 'cm' ? value * 10 : value;
}

/** 淤积百分比 = 统一单位为毫米后的深度 / 当次管内径（毫米） * 100 */
export function siltPercent(depth: number, unit: DepthUnit, diameterMm: number): number {
  if (!(diameterMm > 0)) return 0;
  return round3((toMillimeter(depth, unit) / diameterMm) * 100);
}

// ---------------------------------------------------------------------------
// 契约：按来源 + 采集时间选择当时有效版本
// ---------------------------------------------------------------------------
export interface Contract {
  contractId: string;
  source: string;
  version: string;
  /** 采集时间有效区间（按采集时间判定，而非到达时间） */
  effectiveFrom: string;
  effectiveTo: string | null;
  metric: 'grade' | 'percent';
  note: string;
}

/** 选择来源在给定采集时间当时有效的契约；迟到记录仍以采集时间解释 */
export function selectContract(contracts: Contract[], source: string, collectedAt: string): Contract | null {
  const t = Date.parse(collectedAt);
  const candidates = contracts.filter((c) => {
    if (c.source !== source) return false;
    const from = Date.parse(c.effectiveFrom);
    const to = c.effectiveTo ? Date.parse(c.effectiveTo) : Infinity;
    return from <= t && t <= to;
  });
  if (candidates.length === 0) return null;
  // 多个命中时取生效最晚的一个，保证迟到记录落到采集日当天的版本
  return candidates.sort((a, b) => Date.parse(b.effectiveFrom) - Date.parse(a.effectiveFrom))[0];
}

// ---------------------------------------------------------------------------
// 校准样本 / 批次：同断面同次巡检的「等级 + 量测」配对
// ---------------------------------------------------------------------------
export interface CalibrationSample {
  sampleId: string;
  sectionId: string;
  inspectionId: string;
  procedure: Procedure;
  grade: Grade;
  depth: number;
  unit: DepthUnit;
  diameterMm: number;
  collectedAt: string;
}

/** 巡检中的等级观测（只含定性等级，不含量测） */
export interface GradeObservation {
  obsId: string;
  sectionId: string;
  inspectionId: string;
  procedure: Procedure;
  grade: Grade;
  collectedAt: string;
}

/** 巡检中的量测观测（只含淤积深度与当次内径，不含等级） */
export interface MeasurementObservation {
  obsId: string;
  sectionId: string;
  inspectionId: string;
  depth: number;
  unit: DepthUnit;
  diameterMm: number;
  collectedAt: string;
}

export interface PairingResult {
  pairs: CalibrationSample[];
  dropped: { gradeObsId: string; reason: string }[];
}

/**
 * 只有「同一断面、同次巡检」的等级与量测可以配成校准对；
 * 断面或巡检不一致的等级观测一律不配对（不得跨次巡检拼凑校准证据）。
 */
export function formCalibrationPairs(
  grades: GradeObservation[],
  measurements: MeasurementObservation[],
): PairingResult {
  const byKey = new Map<string, MeasurementObservation[]>();
  for (const m of measurements) {
    const key = `${m.sectionId}#${m.inspectionId}`;
    const arr = byKey.get(key) ?? [];
    arr.push(m);
    byKey.set(key, arr);
  }
  const pairs: CalibrationSample[] = [];
  const dropped: { gradeObsId: string; reason: string }[] = [];
  for (const g of grades) {
    const matches = byKey.get(`${g.sectionId}#${g.inspectionId}`) ?? [];
    if (matches.length === 0) {
      dropped.push({ gradeObsId: g.obsId, reason: '无同断面同次巡检的量测，不能配成校准对' });
      continue;
    }
    if (matches.length > 1) {
      dropped.push({ gradeObsId: g.obsId, reason: '同次巡检存在多条量测，无法唯一配对' });
      continue;
    }
    const m = matches[0];
    pairs.push({
      sampleId: `CAL-${g.obsId}`,
      sectionId: g.sectionId,
      inspectionId: g.inspectionId,
      procedure: g.procedure,
      grade: g.grade,
      depth: m.depth,
      unit: m.unit,
      diameterMm: m.diameterMm,
      collectedAt: g.collectedAt,
    });
  }
  return { pairs, dropped };
}

/** 清淤记录：用于把跨期复测按「同一断面」关联起来，计算清淤（观测）贡献 */
export interface DesiltingRecord {
  desiltingId: string;
  sectionId: string;
  beforeDepth: number;
  afterDepth: number;
  unit: DepthUnit;
  diameterMm: number;
  clearedAt: string;
}

export interface CrossPeriodLink {
  sectionId: string;
  beforeInspectionId: string;
  afterInspectionId: string;
  desiltingId: string;
}

/**
 * 跨期复测关联：同一断面、清淤前后各一次复测，经清淤记录关联。
 * 返回可用作贡献分解「上一期观测」与「本期观测」的配对。
 */
export function linkCrossPeriod(
  inspections: InspectionRecord[],
  desilting: DesiltingRecord[],
): CrossPeriodLink[] {
  const links: CrossPeriodLink[] = [];
  for (const d of desilting) {
    const sameSection = inspections
      .filter((r) => r.sectionId === d.sectionId)
      .sort((a, b) => a.collectedAt.localeCompare(b.collectedAt));
    if (sameSection.length < 2) continue;
    links.push({
      sectionId: d.sectionId,
      beforeInspectionId: sameSection[0].inspectionId,
      afterInspectionId: sameSection[sameSection.length - 1].inspectionId,
      desiltingId: d.desiltingId,
    });
  }
  return links;
}

export function samplePercent(s: CalibrationSample): number {
  return siltPercent(s.depth, s.unit, s.diameterMm);
}

export interface CalibrationBatch {
  batchId: string;
  procedure: Procedure;
  grade: Grade;
  /** 引用的配对样本；仅同断面同次巡检的样本可入批 */
  sampleIds: string[];
  /** 注明的适用范围（百分比） */
  applicableMinPercent: number;
  applicableMaxPercent: number;
  status: 'valid' | 'revoked';
  calibratedAt: string;
  note: string;
}

export interface CalibrationData {
  samples: CalibrationSample[];
  batches: CalibrationBatch[];
}

/** 撤销某校准批次（重新判定有效性，不动原始样本与已发布证据） */
export function revokeBatch(data: CalibrationData, batchId: string): CalibrationData {
  return {
    ...data,
    batches: data.batches.map((b) => (b.batchId === batchId ? { ...b, status: 'revoked' } : b)),
  };
}

// ---------------------------------------------------------------------------
// 从校准批次构建对照表
// ---------------------------------------------------------------------------
export interface ProcedureRange {
  procedure: Procedure;
  grade: Grade;
  interval: Interval;
  batchIds: string[];
  sampleCount: number;
}

export interface GradeRange {
  grade: Grade;
  /** 统一表：同等级各规程校准范围的最小下界与最大上界 */
  interval: Interval;
  byProcedure: Partial<Record<Procedure, Interval>>;
  proceduresWithCalibration: Procedure[];
  /** 适用但缺少有效校准的规程 */
  missingProcedures: Procedure[];
}

export interface CalibrationTable {
  builtFromBatchIds: string[];
  procedureRanges: ProcedureRange[];
  grades: GradeRange[];
  version: string;
}

function unionInterval(a: Interval | null, b: Interval): Interval {
  return a ? { min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) } : { ...b };
}

/**
 * 构建对照表。
 * - 分规程区间：同 (规程, 等级) 若存在多个有效批次则取并集；
 * - 统一区间：同等级跨全部规程取 [最小下界, 最大上界]。
 */
export function buildCalibration(data: CalibrationData): CalibrationTable {
  const sampleById = new Map(data.samples.map((s) => [s.sampleId, s]));
  const valid = data.batches.filter((b) => b.status === 'valid');

  // 按 (规程, 等级) 聚合有效批次
  const byProcGrade = new Map<string, ProcedureRange>();
  for (const batch of valid) {
    const samples = batch.sampleIds
      .map((id) => sampleById.get(id))
      .filter((s): s is CalibrationSample => Boolean(s))
      // 校准对必须是同断面同次巡检
      .filter((s) => s.procedure === batch.procedure && s.grade === batch.grade);
    if (samples.length === 0) continue;
    const pcts = samples.map(samplePercent);
    const sampleLo = Math.min(...pcts);
    const sampleHi = Math.max(...pcts);
    // 换算区间由配对样本计算，并受批次注明的适用范围约束（交集；无交集时退回样本区间）
    const lo = Math.max(sampleLo, batch.applicableMinPercent);
    const hi = Math.min(sampleHi, batch.applicableMaxPercent);
    const interval: Interval = lo <= hi ? { min: lo, max: hi } : { min: sampleLo, max: sampleHi };
    const key = `${batch.procedure}|${batch.grade}`;
    const existing = byProcGrade.get(key);
    if (existing) {
      existing.interval = unionInterval(existing.interval, interval);
      existing.batchIds = [...new Set([...existing.batchIds, batch.batchId])];
      existing.sampleCount += samples.length;
    } else {
      byProcGrade.set(key, {
        procedure: batch.procedure,
        grade: batch.grade,
        interval,
        batchIds: [batch.batchId],
        sampleCount: samples.length,
      });
    }
  }

  const procedureRanges = [...byProcGrade.values()].sort(
    (a, b) => a.grade.localeCompare(b.grade) || a.procedure.localeCompare(b.procedure),
  );

  const grades: GradeRange[] = [];
  for (const grade of GRADES) {
    const ranges = procedureRanges.filter((r) => r.grade === grade);
    if (ranges.length === 0) continue;
    let interval: Interval | null = null;
    const byProcedure: Partial<Record<Procedure, Interval>> = {};
    const proceduresWithCalibration: Procedure[] = [];
    for (const r of ranges) {
      interval = unionInterval(interval, r.interval);
      byProcedure[r.procedure] = { ...r.interval };
      proceduresWithCalibration.push(r.procedure);
    }
    const missingProcedures = ALL_PROCEDURES.filter((p) => !proceduresWithCalibration.includes(p));
    grades.push({
      grade,
      interval: interval!,
      byProcedure,
      proceduresWithCalibration,
      missingProcedures,
    });
  }

  const version = fnv1a(
    valid
      .map((b) => `${b.batchId}:${b.status}`)
      .sort()
      .join('|') +
      '#' +
      procedureRanges.map((r) => `${r.procedure}/${r.grade}:${r.interval.min}-${r.interval.max}`).join(';'),
  );

  return {
    builtFromBatchIds: valid.map((b) => b.batchId).sort(),
    procedureRanges,
    grades,
    version,
  };
}

// ---------------------------------------------------------------------------
// 等级 -> 百分比区间（换算）与百分比 -> 等级（反查）
// ---------------------------------------------------------------------------
export interface ConvertedGrade {
  grade: Grade;
  mode: ConversionMode;
  procedure: Procedure | null;
  /** 换算得到的百分比区间；无可用校准为 null */
  interval: Interval | null;
  usedProcedures: Procedure[];
  /** 适用但缺少有效校准的规程 */
  missingProcedures: Procedure[];
  evidenceInsufficient: boolean;
  version: string;
}

function gradeRangeOf(table: CalibrationTable, grade: Grade): GradeRange | null {
  return table.grades.find((g) => g.grade === grade) ?? null;
}

/**
 * 等级 -> 换算百分比区间。
 * - unified：忽略规程，取同等级各规程范围并集（可能横跨风险线）；
 * - per_procedure：记录规程时用该规程范围收窄；缺失规程时退回全部可能规程的并集。
 * 适用规程中任一缺少有效校准时标记为证据不足（缺证）。
 */
export function convertGrade(
  grade: Grade,
  procedure: Procedure | null,
  mode: ConversionMode,
  table: CalibrationTable,
): ConvertedGrade {
  const gr = gradeRangeOf(table, grade);
  const applicable: Procedure[] = procedure ? [procedure] : [...ALL_PROCEDURES];
  const missingProcedures = applicable.filter((p) => !gr || gr.byProcedure[p] === undefined);

  let interval: Interval | null = null;
  let usedProcedures: Procedure[] = [];

  if (gr) {
    if (mode === 'unified') {
      interval = { ...gr.interval };
      usedProcedures = [...gr.proceduresWithCalibration];
    } else if (procedure) {
      const r = gr.byProcedure[procedure];
      if (r) {
        interval = { ...r };
        usedProcedures = [procedure];
      }
    } else {
      // 规程缺失：保留全部可能规程的范围
      interval = { ...gr.interval };
      usedProcedures = [...gr.proceduresWithCalibration];
    }
  }

  const evidenceInsufficient = missingProcedures.length > 0 || interval === null;
  const version = fnv1a(
    `${mode}|${grade}|${procedure ?? '*'}|${interval ? `${interval.min}-${interval.max}` : 'none'}|${missingProcedures.join(',')}`,
  );
  return { grade, mode, procedure, interval, usedProcedures, missingProcedures, evidenceInsufficient, version };
}

/** 一个等级的「适用」百分比区间（按规程；规程缺失或统一表时用并集） */
export function applicableInterval(
  grade: Grade,
  procedure: Procedure | null,
  table: CalibrationTable,
  mode: ConversionMode = 'per_procedure',
): Interval | null {
  return convertGrade(grade, procedure, mode, table).interval;
}

/**
 * 百分比反查所有可能等级：落在某等级适用区间内即保留为候选，
 * 落在多个等级区间时全部保留（例如 27.5% 同时落入等级 2 与等级 3 的规程甲范围）。
 */
export function lookupGradesByPercent(
  percent: number,
  procedure: Procedure | null,
  table: CalibrationTable,
  mode: ConversionMode = 'per_procedure',
): Grade[] {
  const out: Grade[] = [];
  for (const grade of GRADES) {
    const interval = applicableInterval(grade, procedure, table, mode);
    if (!interval) continue;
    if (percent >= interval.min && percent <= interval.max) out.push(grade);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 风险带与旧记录回填判定
// ---------------------------------------------------------------------------
export function classifyBand(interval: Interval, threshold = SCORE_THRESHOLD): Band {
  if (interval.max < threshold) return 'low';
  if (interval.min >= threshold) return 'high';
  return 'uncertain';
}

export interface InspectionRecord {
  recordId: string;
  segmentId: string;
  tileId: string;
  sectionId: string;
  inspectionId: string;
  /** 测量规程；null 表示规程缺失 */
  procedure: Procedure | null;
  source: string;
  /** 采集时间（用于选择契约） */
  collectedAt: string;
  /** 到达时间（迟到记录仍按采集时间解释） */
  arrivedAt: string;
  /** 管段版本 */
  segmentVersion: string;
  /** 旧等级（历史图层可能只有等级） */
  grade: Grade | null;
  /** 同次巡检的量测（深度 + 当次内径） */
  measurement: { depth: number; unit: DepthUnit; diameterMm: number } | null;
  /** 是否参与校准；false 表示留作验证、不进入校准批次 */
  participatesInCalibration: boolean;
}

export type BackfillReason =
  | 'risk_band_uncertain'
  | 'evidence_insufficient'
  | 'measured_conflict'
  | 'no_conversion';

export interface BackfillDecision {
  recordId: string;
  segmentId: string;
  tileId: string;
  status: CoverageStatus;
  eligible: boolean;
  converted: ConvertedGrade | null;
  scoreInterval: Interval | null;
  band: Band | null;
  measuredPercent: number | null;
  measuredBand: Band | null;
  reasons: BackfillReason[];
  /** 原始记录与换算版本均保留 */
  originalKept: true;
  conversionVersion: string;
}

export interface BackfillOptions {
  mode: ConversionMode;
  threshold: number;
  bias: number;
}

function shiftInterval(interval: Interval, bias: number): Interval {
  return { min: round3(interval.min + bias), max: round3(interval.max + bias) };
}

function pointInterval(v: number): Interval {
  return { min: round3(v), max: round3(v) };
}

/**
 * 评估一条旧记录能否回填到新风险图层。
 * 阻止自动回填的三类情形：
 * 1) 换算区间横跨风险线（风险带不确定）；
 * 2) 适用证据不足（任一适用规程缺少有效校准）；
 * 3) 同次实测与换算结果处于不同风险带。
 */
export function evaluateBackfill(
  record: InspectionRecord,
  table: CalibrationTable,
  options: BackfillOptions,
): BackfillDecision {
  const { mode, threshold, bias } = options;
  const reasons: BackfillReason[] = [];

  const measuredPercent = record.measurement
    ? siltPercent(record.measurement.depth, record.measurement.unit, record.measurement.diameterMm)
    : null;
  const measuredBand = measuredPercent !== null ? classifyBand(pointInterval(measuredPercent + bias), threshold) : null;

  // 纯量测记录（新口径）：直接可比，无需换算
  if (!record.grade) {
    if (measuredPercent === null) {
      return {
        recordId: record.recordId, segmentId: record.segmentId, tileId: record.tileId,
        status: 'missing_evidence', eligible: false, converted: null, scoreInterval: null,
        band: null, measuredPercent: null, measuredBand: null,
        reasons: ['no_conversion'], originalKept: true, conversionVersion: 'none',
      };
    }
    const scoreInterval = pointInterval(measuredPercent + bias);
    return {
      recordId: record.recordId, segmentId: record.segmentId, tileId: record.tileId,
      status: 'comparable', eligible: true, converted: null, scoreInterval,
      band: classifyBand(scoreInterval, threshold), measuredPercent, measuredBand,
      reasons: [], originalKept: true, conversionVersion: `direct:${measuredPercent}`,
    };
  }

  const converted = convertGrade(record.grade, record.procedure, mode, table);
  const scoreInterval = converted.interval ? shiftInterval(converted.interval, bias) : null;
  const band = scoreInterval ? classifyBand(scoreInterval, threshold) : null;

  let status: CoverageStatus;
  if (converted.evidenceInsufficient || scoreInterval === null) {
    reasons.push('evidence_insufficient');
    status = 'missing_evidence';
  } else if (band === 'uncertain') {
    reasons.push('risk_band_uncertain');
    status = 'review';
  } else if (measuredBand !== null && measuredBand !== 'uncertain' && measuredBand !== band) {
    reasons.push('measured_conflict');
    status = 'review';
  } else {
    status = 'comparable';
  }

  return {
    recordId: record.recordId,
    segmentId: record.segmentId,
    tileId: record.tileId,
    status,
    eligible: status === 'comparable',
    converted,
    scoreInterval,
    band,
    measuredPercent,
    measuredBand,
    reasons,
    originalKept: true,
    conversionVersion: converted.version,
  };
}

// ---------------------------------------------------------------------------
// 覆盖图：以各瓦片纳入复算的管段为分母，每段只计一次
// ---------------------------------------------------------------------------
const SEVERITY: Record<CoverageStatus, number> = {
  comparable: 1,
  review: 2,
  missing_evidence: 3,
};

export interface CoverageRow {
  segmentId: string;
  tileId: string;
  recordId: string;
  status: CoverageStatus;
  decision: BackfillDecision;
}

export interface TileCoverage {
  tileId: string;
  denominator: number;
  counts: Record<CoverageStatus, number>;
}

export interface CoverageResult {
  rows: CoverageRow[];
  tiles: TileCoverage[];
  totals: Record<CoverageStatus, number>;
  denominator: number;
  batchIdsUsed: string[];
  version: string;
}

function emptyCounts(): Record<CoverageStatus, number> {
  return { comparable: 0, review: 0, missing_evidence: 0 };
}

/**
 * 构建覆盖图。同一管段若有多条记录，只计一次并取最严重状态
 * （缺证 > 待复核 > 可比），副记录以其采集时间较晚者为准。
 */
export function buildCoverage(
  records: InspectionRecord[],
  table: CalibrationTable,
  options: BackfillOptions,
): CoverageResult {
  const bySegment = new Map<string, InspectionRecord[]>();
  for (const r of records) {
    const arr = bySegment.get(r.segmentId) ?? [];
    arr.push(r);
    bySegment.set(r.segmentId, arr);
  }

  const rows: CoverageRow[] = [];
  for (const [segmentId, recs] of bySegment) {
    const decisions = recs.map((r) => ({ record: r, decision: evaluateBackfill(r, table, options) }));
    decisions.sort((a, b) => {
      const d = SEVERITY[b.decision.status] - SEVERITY[a.decision.status];
      if (d !== 0) return d;
      return b.record.collectedAt.localeCompare(a.record.collectedAt);
    });
    const chosen = decisions[0];
    rows.push({
      segmentId,
      tileId: chosen.record.tileId,
      recordId: chosen.record.recordId,
      status: chosen.decision.status,
      decision: chosen.decision,
    });
  }
  rows.sort((a, b) => a.tileId.localeCompare(b.tileId) || a.segmentId.localeCompare(b.segmentId));

  const tileMap = new Map<string, CoverageRow[]>();
  for (const row of rows) {
    const arr = tileMap.get(row.tileId) ?? [];
    arr.push(row);
    tileMap.set(row.tileId, arr);
  }
  const tiles: TileCoverage[] = [...tileMap.entries()]
    .map(([tileId, rs]) => {
      const counts = emptyCounts();
      for (const r of rs) counts[r.status] += 1;
      return { tileId, denominator: rs.length, counts };
    })
    .sort((a, b) => a.tileId.localeCompare(b.tileId));

  const totals = emptyCounts();
  for (const row of rows) totals[row.status] += 1;

  const version = fnv1a(
    `${table.version}#${rows.map((r) => `${r.segmentId}:${r.status}`).join(';')}`,
  );

  return { rows, tiles, totals, denominator: rows.length, batchIdsUsed: table.builtFromBatchIds, version };
}

// ---------------------------------------------------------------------------
// 规则对照试验：统一表 vs 分规程表，须有共同适用证据，结果单独留存
// ---------------------------------------------------------------------------
export interface RuleTrialSide {
  scoreInterval: Interval | null;
  band: Band | null;
  status: CoverageStatus;
  eligible: boolean;
  batchIds: string[];
}

export interface RuleTrialResult {
  trialId: string;
  recordId: string;
  mode: ConversionMode;
  sharedEvidence: { batchIds: string[]; ok: boolean; reason: string };
  unified: RuleTrialSide;
  perProcedure: RuleTrialSide;
  /** 分规程 - 统一 的得分区间变化（有证据支持的贡献范围） */
  scoreRangeShift: Interval | null;
  eligibilityChanged: boolean;
  retainedSeparately: true;
}

function trialSide(record: InspectionRecord, table: CalibrationTable, mode: ConversionMode, options: BackfillOptions): RuleTrialSide {
  const decision = evaluateBackfill(record, table, { ...options, mode });
  return {
    scoreInterval: decision.scoreInterval,
    band: decision.band,
    status: decision.status,
    eligible: decision.eligible,
    batchIds: decision.converted?.usedProcedures.flatMap(
      (p) => table.procedureRanges.find((r) => r.grade === record.grade && r.procedure === p)?.batchIds ?? [],
    ) ?? [],
  };
}

/**
 * 规则对照试验：对同一巡检（等级 + 规程固定）分别套用统一表与分规程表，
 * 检查得分区间与回填资格如何变化。要求两种表共享至少一个有效校准批次（共同适用证据）。
 */
export function runRuleTrial(
  record: InspectionRecord,
  table: CalibrationTable,
  options: BackfillOptions = { mode: 'per_procedure', threshold: SCORE_THRESHOLD, bias: DEFAULT_BIAS },
): RuleTrialResult {
  const unified = trialSide(record, table, 'unified', options);
  const perProcedure = trialSide(record, table, 'per_procedure', options);
  const common = unified.batchIds.filter((b) => perProcedure.batchIds.includes(b));
  const ok = common.length > 0;
  const shift = unified.scoreInterval && perProcedure.scoreInterval
    ? { min: round3(perProcedure.scoreInterval.min - unified.scoreInterval.max), max: round3(perProcedure.scoreInterval.max - unified.scoreInterval.min) }
    : null;
  return {
    trialId: `TRIAL-${record.recordId}`,
    recordId: record.recordId,
    mode: 'per_procedure',
    sharedEvidence: {
      batchIds: [...new Set(common)].sort(),
      ok,
      reason: ok
        ? `统一表与分规程表共享校准批次 ${[...new Set(common)].sort().join('、')}，可做对照试验`
        : '两种表无共同适用证据，禁止对照试验',
    },
    unified,
    perProcedure,
    scoreRangeShift: shift,
    eligibilityChanged: unified.eligible !== perProcedure.eligible,
    retainedSeparately: true,
  };
}

// ---------------------------------------------------------------------------
// 贡献分解：锁定拓扑与其他特征，按「观测 -> 换算规则 -> 模型参数」逐项替换
// ---------------------------------------------------------------------------
export type ObservationInput =
  | { kind: 'grade'; grade: Grade; procedure: Procedure | null }
  | { kind: 'percent'; percent: number };

export type ContributionKey = 'observation' | 'conversion_rule' | 'model_params';
export const CONTRIBUTION_ORDER: readonly ContributionKey[] = ['observation', 'conversion_rule', 'model_params'] as const;

export interface ScoreVersions {
  observation: string;
  rule: string;
  params: string;
  topology: string;
}

export interface ContributionStep {
  order: number;
  replaced: ContributionKey;
  /** 该步之前 / 之后的得分区间 */
  before: Interval | null;
  after: Interval | null;
  /** 连续两次可比得分之差（after - before） */
  contribution: Interval | null;
  unknown: boolean;
  /** 该步之后所处的输入版本 */
  inputs: ScoreVersions;
  note: string;
}

export interface ContributionReport {
  order: readonly ContributionKey[];
  baseline: Interval | null;
  final: Interval | null;
  steps: ContributionStep[];
  desiltingContribution: Interval | null;
  ruleContribution: Interval | null;
  paramContribution: Interval | null;
  desiltingUnknown: boolean;
  summary: string;
}

function observationInterval(
  obs: ObservationInput,
  mode: ConversionMode,
  bias: number,
  table: CalibrationTable,
): Interval | null {
  if (obs.kind === 'percent') return pointInterval(obs.percent + bias);
  const conv = convertGrade(obs.grade, obs.procedure, mode, table);
  return conv.interval ? shiftInterval(conv.interval, bias) : null;
}

function observationVersion(obs: ObservationInput): string {
  return obs.kind === 'percent' ? `pct:${obs.percent}` : `grade:${obs.grade}@${obs.procedure ?? '*'}`;
}

function ruleVersion(mode: ConversionMode, table: CalibrationTable): string {
  return `rule:${mode}:${table.version}`;
}

function paramsVersion(bias: number): string {
  return `bias:${bias}`;
}

/**
 * 连续两次可比得分之差（after - before）。这里前后描述的是同一物理量在两种配置下的得分，
 * 因此下限对下限、上限对上限逐端点计算并规整为 [min,max]：均匀偏置位移得到退化区间（如 +4），
 * 区间整体下移得到退化区间（如 -20），区间收窄（统一表 -> 分规程表）得到有证据支持的贡献范围。
 */
function delta(before: Interval | null, after: Interval | null): Interval | null {
  if (!before || !after) return null;
  const lo = round3(after.min - before.min);
  const hi = round3(after.max - before.max);
  return { min: Math.min(lo, hi), max: Math.max(lo, hi) };
}

function fmt(interval: Interval | null): string {
  if (!interval) return '未知';
  if (interval.min === interval.max) return `${interval.min}`;
  return `${interval.min}~${interval.max}`;
}

export interface DecomposeInput {
  table: CalibrationTable;
  /** 上一期观测；null 表示缺少同断面复测或清淤记录 */
  prevObservation: ObservationInput | null;
  nextObservation: ObservationInput;
  prevMode: ConversionMode;
  nextMode: ConversionMode;
  prevBias: number;
  nextBias: number;
  /** 锁定的拓扑版本（复算期间不变） */
  topologyVersion: string;
}

/**
 * 贡献分解。锁定拓扑及其他特征，按观测、换算规则、模型参数顺序各替换一项，
 * 用连续两次可比得分之差计算贡献并记录输入版本；得分只能确定区间时给出贡献范围；
 * 缺少同断面复测或清淤记录时清淤（观测）贡献列为未知。
 */
export function decomposeContribution(input: DecomposeInput): ContributionReport {
  const { table, prevObservation, nextObservation, prevMode, nextMode, prevBias, nextBias, topologyVersion } = input;
  const steps: ContributionStep[] = [];

  const nextObsVersion = observationVersion(nextObservation);
  const topology = topologyVersion;

  // s1：替换观测后的状态（若无可比上期，则以上期配置直接作为基线）
  let baseline: Interval | null;
  let s1: Interval | null;
  let obsContribution: Interval | null;
  let desiltingUnknown: boolean;

  if (prevObservation) {
    const s0 = observationInterval(prevObservation, prevMode, prevBias, table);
    s1 = observationInterval(nextObservation, prevMode, prevBias, table);
    baseline = s0;
    obsContribution = delta(s0, s1);
    desiltingUnknown = false;
    steps.push({
      order: 1,
      replaced: 'observation',
      before: s0,
      after: s1,
      contribution: obsContribution,
      unknown: false,
      inputs: { observation: nextObsVersion, rule: ruleVersion(prevMode, table), params: paramsVersion(prevBias), topology },
      note: `观测替换：${observationVersion(prevObservation)} -> ${nextObsVersion}，换算 ${prevMode === 'unified' ? '统一表' : '分规程表'}、偏置 ${prevBias} 固定；得分 ${fmt(s0)} -> ${fmt(s1)}`,
    });
  } else {
    baseline = observationInterval(nextObservation, prevMode, prevBias, table);
    s1 = baseline;
    obsContribution = null;
    desiltingUnknown = true;
    steps.push({
      order: 1,
      replaced: 'observation',
      before: null,
      after: s1,
      contribution: null,
      unknown: true,
      inputs: { observation: nextObsVersion, rule: ruleVersion(prevMode, table), params: paramsVersion(prevBias), topology },
      note: '缺少同断面复测或清淤记录，清淤（观测）贡献列为未知',
    });
  }

  // s2：替换换算规则（观测不变）
  const s2 = observationInterval(nextObservation, nextMode, prevBias, table);
  const ruleContribution = delta(s1, s2);
  steps.push({
    order: 2,
    replaced: 'conversion_rule',
    before: s1,
    after: s2,
    contribution: ruleContribution,
    unknown: ruleContribution === null,
    inputs: { observation: nextObsVersion, rule: ruleVersion(nextMode, table), params: paramsVersion(prevBias), topology },
    note: `换算规则替换：${prevMode === 'unified' ? '统一表' : '分规程表'} -> ${nextMode === 'unified' ? '统一表' : '分规程表'}；得分 ${fmt(s1)} -> ${fmt(s2)}`,
  });

  // s3：替换模型参数（观测与换算不变）
  const s3 = observationInterval(nextObservation, nextMode, nextBias, table);
  const paramContribution = delta(s2, s3);
  steps.push({
    order: 3,
    replaced: 'model_params',
    before: s2,
    after: s3,
    contribution: paramContribution,
    unknown: paramContribution === null,
    inputs: { observation: nextObsVersion, rule: ruleVersion(nextMode, table), params: paramsVersion(nextBias), topology },
    note: `模型参数替换：偏置 ${prevBias} -> ${nextBias}；得分 ${fmt(s2)} -> ${fmt(s3)}`,
  });

  const summary = [
    `清淤（观测）贡献：${desiltingUnknown ? '未知' : fmt(obsContribution)}`,
    `换算规则贡献：${fmt(ruleContribution)}`,
    `模型参数贡献：${fmt(paramContribution)}`,
  ].join('；');

  return {
    order: CONTRIBUTION_ORDER,
    baseline,
    final: s3,
    steps,
    desiltingContribution: obsContribution,
    ruleContribution,
    paramContribution,
    desiltingUnknown,
    summary,
  };
}

// ---------------------------------------------------------------------------
// 已发布图层：冻结旧证据，撤销批次后仍可按旧证据复现
// ---------------------------------------------------------------------------
export interface PublishedLayer {
  layerId: string;
  publishedAt: string;
  /** 发布时冻结的校准证据（之后撤销批次不影响） */
  frozen: CalibrationData;
  records: InspectionRecord[];
  options: BackfillOptions;
  coverage: CoverageResult;
  fingerprint: string;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function freezePublishedLayer(
  layerId: string,
  data: CalibrationData,
  records: InspectionRecord[],
  options: BackfillOptions,
  publishedAt: string,
): PublishedLayer {
  const table = buildCalibration(data);
  const coverage = buildCoverage(records, table, options);
  return {
    layerId,
    publishedAt,
    frozen: clone(data),
    records: clone(records),
    options: { ...options },
    coverage,
    fingerprint: coverage.version,
  };
}

export interface ReplayResult {
  ok: boolean;
  coverage: CoverageResult;
  fingerprint: string;
  /** 与当前（可能已撤销乙批次）重新构建的结果是否不同 */
  divergesFromCurrent: boolean | null;
}

/**
 * 按冻结证据回放已发布图层；若同时给出当前校准数据，可比对是否已漂移。
 */
export function replayPublishedLayer(layer: PublishedLayer, current?: CalibrationData): ReplayResult {
  const frozenTable = buildCalibration(layer.frozen);
  const coverage = buildCoverage(layer.records, frozenTable, layer.options);
  const fingerprint = coverage.version;
  let diverges: boolean | null = null;
  if (current) {
    const currentCoverage = buildCoverage(layer.records, buildCalibration(current), layer.options);
    diverges = currentCoverage.version !== fingerprint;
  }
  return { ok: fingerprint === layer.fingerprint, coverage, fingerprint, divergesFromCurrent: diverges };
}
