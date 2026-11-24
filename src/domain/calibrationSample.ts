// 口径复算的虚构可回放样例（无随机数、内容固定）。
//
// 风险分数 = 淤积百分比 + 模型偏置；达到 30 为高风险。
// 规程甲/乙各有经校验的配对样本（内径 100mm）：等级 2 -> 26%~28%，等级 3 -> 34%~36%。
// 统一表把等级 2 合并为 26%~36%（跨 30 风险线），分规程表把等级 2 收窄为 26%~28%（低风险）。
import {
  DEFAULT_BIAS,
  SCORE_THRESHOLD,
  buildCalibration,
  buildCoverage,
  convertGrade,
  decomposeContribution,
  formCalibrationPairs,
  freezePublishedLayer,
  linkCrossPeriod,
  replayPublishedLayer,
  revokeBatch,
  runRuleTrial,
  selectContract,
  type BackfillOptions,
  type CalibrationBatch,
  type CalibrationData,
  type CalibrationSample,
  type Contract,
  type DesiltingRecord,
  type GradeObservation,
  type InspectionRecord,
  type MeasurementObservation,
  type Procedure,
  type PublishedLayer,
} from './calibration';

// ---------------------------------------------------------------------------
// 契约：市测绘院巡检表在 2026-06-30 由「等级」改为「百分比」口径
// ---------------------------------------------------------------------------
export const SURVEY_SOURCE = '市测绘院 / 管网中心巡检表';

export function sampleContracts(): Contract[] {
  return [
    {
      contractId: 'CTR-SURVEY-V1',
      source: SURVEY_SOURCE,
      version: 'v1-grade',
      effectiveFrom: '2026-01-01T00:00:00Z',
      effectiveTo: '2026-06-30T23:59:59Z',
      metric: 'grade',
      note: '旧口径：巡检表只记录淤积等级（等级 2 / 等级 3）',
    },
    {
      contractId: 'CTR-SURVEY-V2',
      source: SURVEY_SOURCE,
      version: 'v2-percent',
      effectiveFrom: '2026-07-01T00:00:00Z',
      effectiveTo: null,
      metric: 'percent',
      note: '新口径：巡检表淤积深度改为百分比（同次断面深度 / 当次内径）',
    },
  ];
}

// ---------------------------------------------------------------------------
// 配对样本：等级观测与量测观测分开给出，再按同断面同次巡检配对
// 管路内径统一 100mm，因此等级 2 量测 26/28mm、等级 3 量测 34/36mm 即对应 26%~28% 与 34%~36%。
// ---------------------------------------------------------------------------
const DIA = 100;

function pairedObservations(): {
  grades: GradeObservation[];
  measurements: MeasurementObservation[];
} {
  const grades: GradeObservation[] = [];
  const measurements: MeasurementObservation[] = [];
  const mk = (seq: string, procedure: Procedure, grade: 'G2' | 'G3', depthMm: number, collectedAt: string) => {
    const sectionId = `SEC-${procedure}-${grade}`;
    const inspectionId = `INS-${procedure}-${grade}-${seq}`;
    grades.push({
      obsId: `GO-${procedure}-${grade}-${seq}`,
      sectionId,
      inspectionId,
      procedure,
      grade,
      collectedAt,
    });
    measurements.push({
      obsId: `MO-${procedure}-${grade}-${seq}`,
      sectionId,
      inspectionId,
      depth: depthMm,
      unit: 'mm',
      diameterMm: DIA,
      collectedAt,
    });
  };
  // 规程甲：等级 2 -> 26/28mm，等级 3 -> 44/46mm（甲有两类等级的校准批次）
  mk('a1', 'P_A', 'G2', 26, '2026-05-10T09:00:00Z');
  mk('a2', 'P_A', 'G2', 28, '2026-05-11T09:00:00Z');
  mk('a3', 'P_A', 'G3', 44, '2026-05-12T09:00:00Z');
  mk('a4', 'P_A', 'G3', 46, '2026-05-13T09:00:00Z');
  // 规程乙：仅一条等级 2 校准批次 -> 34/36mm（同一旧等级在乙下覆盖 34%~36%，用于演示「撤销唯一有效批次」）
  mk('b1', 'P_B', 'G2', 34, '2026-05-14T09:00:00Z');
  mk('b2', 'P_B', 'G2', 36, '2026-05-15T09:00:00Z');
  return { grades, measurements };
}

function calibrationSamples(): { samples: CalibrationSample[]; dropped: { gradeObsId: string; reason: string }[] } {
  const { grades, measurements } = pairedObservations();
  const paired = formCalibrationPairs(grades, measurements);
  return { samples: paired.pairs, dropped: paired.dropped };
}

function calibrationBatches(samples: CalibrationSample[]): CalibrationBatch[] {
  const idsFor = (procedure: Procedure, grade: 'G2' | 'G3') =>
    samples.filter((s) => s.procedure === procedure && s.grade === grade).map((s) => s.sampleId);
  return [
    {
      batchId: 'CAL-A-G2',
      procedure: 'P_A',
      grade: 'G2',
      sampleIds: idsFor('P_A', 'G2'),
      applicableMinPercent: 26,
      applicableMaxPercent: 28,
      status: 'valid',
      calibratedAt: '2026-05-20T00:00:00Z',
      note: '规程甲等级 2：经校验的配对样本，适用 26%~28%',
    },
    {
      batchId: 'CAL-A-G3',
      procedure: 'P_A',
      grade: 'G3',
      sampleIds: idsFor('P_A', 'G3'),
      applicableMinPercent: 44,
      applicableMaxPercent: 46,
      status: 'valid',
      calibratedAt: '2026-05-20T00:00:00Z',
      note: '规程甲等级 3：经校验的配对样本，适用 44%~46%',
    },
    {
      batchId: 'CAL-B-G2',
      procedure: 'P_B',
      grade: 'G2',
      sampleIds: idsFor('P_B', 'G2'),
      applicableMinPercent: 34,
      applicableMaxPercent: 36,
      status: 'valid',
      calibratedAt: '2026-05-21T00:00:00Z',
      note: '规程乙等级 2：经校验的配对样本，适用 34%~36%；这是乙唯一有效的校准批次',
    },
  ];
}

export function sampleCalibrationData(): CalibrationData {
  const { samples } = calibrationSamples();
  return { samples, batches: calibrationBatches(samples) };
}

/** 演示「不同断面拼不成分配对」的负例：等级来自巡检 A，量测来自巡检 B */
export function mispairedDemo(): { grades: GradeObservation[]; measurements: MeasurementObservation[] } {
  return {
    grades: [
      { obsId: 'GO-X', sectionId: 'SEC-X', inspectionId: 'INS-X-1', procedure: 'P_A', grade: 'G3', collectedAt: '2026-05-01T00:00:00Z' },
    ],
    measurements: [
      { obsId: 'MO-Y', sectionId: 'SEC-Y', inspectionId: 'INS-Y-1', depth: 35, unit: 'mm', diameterMm: DIA, collectedAt: '2026-05-02T00:00:00Z' },
    ],
  };
}

// ---------------------------------------------------------------------------
// 待发布覆盖记录的 8 条管段（每段一条记录，另有冲突巡检与迟到记录作副记录）
// ---------------------------------------------------------------------------
export function sampleRecords(): InspectionRecord[] {
  const base = {
    source: SURVEY_SOURCE,
    arrivedAt: '2026-08-01T08:00:00Z',
    segmentVersion: 'network-v3',
    measurement: null as InspectionRecord['measurement'],
    participatesInCalibration: true,
  };
  return [
    // S1：统一表 26~36 跨线待复核；分规程甲 26~28 低风险可比
    {
      ...base, recordId: 'REC-S1', segmentId: 'S1', tileId: 'TILE_A', sectionId: 'SEC-S1', inspectionId: 'INS-S1',
      procedure: 'P_A', collectedAt: '2026-05-02T09:00:00Z', grade: 'G2',
    },
    // S2：规程乙、等级 2；乙批次撤销后变为缺证
    {
      ...base, recordId: 'REC-S2', segmentId: 'S2', tileId: 'TILE_A', sectionId: 'SEC-S2', inspectionId: 'INS-S2',
      procedure: 'P_B', collectedAt: '2026-05-03T09:00:00Z', grade: 'G2',
    },
    // S3：规程缺失、等级 2；保留全部可能规程范围（仍跨线），且乙撤销后缺证
    {
      ...base, recordId: 'REC-S3', segmentId: 'S3', tileId: 'TILE_A', sectionId: 'SEC-S3', inspectionId: 'INS-S3',
      procedure: null, collectedAt: '2026-05-04T09:00:00Z', grade: 'G2',
    },
    // S4A：等级 2（甲）低风险可比；同时是迟到的六月契约记录
    {
      ...base, recordId: 'REC-S4A', segmentId: 'S4A', tileId: 'TILE_A', sectionId: 'SEC-S4A', inspectionId: 'INS-S4A',
      procedure: 'P_A', collectedAt: '2026-06-20T09:00:00Z', grade: 'G2', arrivedAt: '2026-08-12T10:00:00Z',
    },
    // S4B：新口径直接量测（非校准记录）
    {
      ...base, recordId: 'REC-S4B', segmentId: 'S4B', tileId: 'TILE_B', sectionId: 'SEC-S4B', inspectionId: 'INS-S4B',
      procedure: 'P_A', collectedAt: '2026-07-15T09:00:00Z', grade: null,
      measurement: { depth: 3, unit: 'cm', diameterMm: 400 }, participatesInCalibration: false,
    },
    // S5：规程甲、等级 2，同次实测 35%（与换算低风险异带）=> 阻止自动回填
    {
      ...base, recordId: 'REC-S5', segmentId: 'S5', tileId: 'TILE_B', sectionId: 'SEC-S5', inspectionId: 'INS-S5',
      procedure: 'P_A', collectedAt: '2026-07-02T09:00:00Z', grade: 'G2',
      measurement: { depth: 35, unit: 'mm', diameterMm: 100 }, participatesInCalibration: false,
    },
    // S6：直接量测 28%（低风险可比）
    {
      ...base, recordId: 'REC-S6', segmentId: 'S6', tileId: 'TILE_B', sectionId: 'SEC-S6', inspectionId: 'INS-S6',
      procedure: 'P_B', collectedAt: '2026-07-03T09:00:00Z', grade: null,
      measurement: { depth: 28, unit: 'mm', diameterMm: 100 }, participatesInCalibration: false,
    },
    // S7：同段两条记录——迟到的旧等级（规程乙等级 2，乙部批次撤销后缺证）与较新的直接量测（可比）
    // 覆盖图按每段只计一次取最严重状态 => 撤销后整段记为缺证
    {
      ...base, recordId: 'REC-S7-old', segmentId: 'S7', tileId: 'TILE_B', sectionId: 'SEC-S7', inspectionId: 'INS-S7-old',
      procedure: 'P_B', collectedAt: '2026-06-01T09:00:00Z', grade: 'G2', arrivedAt: '2026-09-10T12:00:00Z',
    },
    {
      ...base, recordId: 'REC-S7-new', segmentId: 'S7', tileId: 'TILE_B', sectionId: 'SEC-S7', inspectionId: 'INS-S7-new',
      procedure: null, collectedAt: '2026-08-15T09:00:00Z', grade: null,
      measurement: { depth: 32, unit: 'mm', diameterMm: 100 }, participatesInCalibration: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// 清淤与跨期复测：同一断面「清淤前 40mm、清淤后 20mm、内径 100mm」
// ---------------------------------------------------------------------------
export const DESILTING_SECTION = 'SEC-S10';

export function sampleDesilting(): DesiltingRecord {
  return {
    desiltingId: 'DES-S10',
    sectionId: DESILTING_SECTION,
    beforeDepth: 40,
    afterDepth: 20,
    unit: 'mm',
    diameterMm: 100,
    clearedAt: '2026-06-15T00:00:00Z',
  };
}

export function sampleDesiltingInspections(): InspectionRecord[] {
  return [
    {
      recordId: 'REC-S10-before', segmentId: 'S10', tileId: 'TILE_A', sectionId: DESILTING_SECTION, inspectionId: 'INS-S10-before',
      procedure: 'P_A', source: SURVEY_SOURCE, collectedAt: '2026-06-01T09:00:00Z', arrivedAt: '2026-06-02T09:00:00Z',
      segmentVersion: 'network-v3', grade: null,
      measurement: { depth: 40, unit: 'mm', diameterMm: 100 }, participatesInCalibration: false,
    },
    {
      recordId: 'REC-S10-after', segmentId: 'S10', tileId: 'TILE_A', sectionId: DESILTING_SECTION, inspectionId: 'INS-S10-after',
      procedure: 'P_A', source: SURVEY_SOURCE, collectedAt: '2026-07-01T09:00:00Z', arrivedAt: '2026-07-02T09:00:00Z',
      segmentVersion: 'network-v3', grade: null,
      measurement: { depth: 20, unit: 'mm', diameterMm: 100 }, participatesInCalibration: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// 场景编排：把上面所有样例串成可一键运行、可断言的结果
// ---------------------------------------------------------------------------
export interface ScenarioOptions extends BackfillOptions {
  /** 进行规则对照试验的目标记录 */
  trialRecordId: string;
}

export const DEFAULT_SCENARIO_OPTIONS: ScenarioOptions = {
  mode: 'per_procedure',
  threshold: SCORE_THRESHOLD,
  bias: DEFAULT_BIAS,
  trialRecordId: 'REC-S1',
};

export interface LateContractCheck {
  recordId: string;
  collectedAt: string;
  arrivedAt: string;
  selectedContractId: string | null;
  selectedVersion: string | null;
  /** 若按到达时间会误选的契约 */
  contractIfArrivalTime: string | null;
}

export function checkLateContract(records: InspectionRecord[], contracts: Contract[]): LateContractCheck {
  const late = records.find((r) => r.recordId === 'REC-S4A')!;
  const byCollection = selectContract(contracts, late.source, late.collectedAt);
  const byArrival = selectContract(contracts, late.source, late.arrivedAt);
  return {
    recordId: late.recordId,
    collectedAt: late.collectedAt,
    arrivedAt: late.arrivedAt,
    selectedContractId: byCollection?.contractId ?? null,
    selectedVersion: byCollection?.version ?? null,
    contractIfArrivalTime: byArrival?.contractId ?? null,
  };
}

export interface DesiltingContribution {
  beforePercent: number;
  afterPercent: number;
  /** 观测（清淤）贡献，预期 -20 */
  observationContribution: { min: number; max: number } | null;
  linkSectionId: string | null;
  inspectionBefore: string | null;
  inspectionAfter: string | null;
}

export interface ParamContribution {
  /** 偏置 0 -> 4 的参数贡献，预期 +4 */
  paramContribution: { min: number; max: number } | null;
  before: { min: number; max: number } | null;
  after: { min: number; max: number } | null;
}

export interface RevocationOutcome {
  before: { affectedSegmentIds: string[]; tiles: { tileId: string; missing: number; denominator: number }[] };
  after: { affectedSegmentIds: string[]; tiles: { tileId: string; missing: number; denominator: number }[] };
  /** 撤销后由可比/待复核转为缺证的管段 */
  newlyMissing: string[];
  /** 撤销所影响的批次 */
  revokedBatchId: string;
  /** 已发布图层仍可按旧证据复现 */
  publishedReplay: { ok: boolean; divergesFromCurrent: boolean | null; fingerprint: string };
}

export interface CalibrationScenario {
  data: CalibrationData;
  contracts: Contract[];
  records: InspectionRecord[];
  table: ReturnType<typeof buildCalibration>;
  unifiedGrade2: ReturnType<typeof convertGrade>;
  perProcedureGrade2: ReturnType<typeof convertGrade>;
  coverage: ReturnType<typeof buildCoverage>;
  lateContract: LateContractCheck;
  trial: ReturnType<typeof runRuleTrial>;
  desilting: DesiltingContribution;
  param: ParamContribution;
  revocation: RevocationOutcome;
  publishedLayer: PublishedLayer;
  pairing: { sampleCount: number; dropped: { gradeObsId: string; reason: string }[] };
}

export function runCalibrationScenario(options: ScenarioOptions = DEFAULT_SCENARIO_OPTIONS): CalibrationScenario {
  const data = sampleCalibrationData();
  const contracts = sampleContracts();
  const records = sampleRecords();
  const table = buildCalibration(data);
  const opts: BackfillOptions = { mode: options.mode, threshold: options.threshold, bias: options.bias };

  const unifiedGrade2 = convertGrade('G2', null, 'unified', table);
  const perProcedureGrade2 = convertGrade('G2', 'P_A', 'per_procedure', table);

  const coverage = buildCoverage(records, table, opts);
  const lateContract = checkLateContract(records, contracts);

  const trialRecord = records.find((r) => r.recordId === options.trialRecordId) ?? records[0];
  const trial = runRuleTrial(trialRecord, table, opts);

  // 清淤：固定换算与偏置，验证观测贡献为减 20 分
  const desilting = sampleDesilting();
  const desiltingInspections = sampleDesiltingInspections();
  const links = linkCrossPeriod(desiltingInspections, [desilting]);
  const before = desiltingInspections.find((r) => r.inspectionId === links[0]?.beforeInspectionId);
  const after = desiltingInspections.find((r) => r.inspectionId === links[0]?.afterInspectionId);
  const beforePct = before?.measurement
    ? (before.measurement.depth / before.measurement.diameterMm) * 100
    : 0;
  const afterPct = after?.measurement ? (after.measurement.depth / after.measurement.diameterMm) * 100 : 0;
  const desiltingReport = decomposeContribution({
    table,
    prevObservation: before?.measurement ? { kind: 'percent', percent: beforePct } : null,
    nextObservation: after?.measurement ? { kind: 'percent', percent: afterPct } : { kind: 'percent', percent: 0 },
    prevMode: 'per_procedure',
    nextMode: 'per_procedure',
    prevBias: options.bias,
    nextBias: options.bias,
    topologyVersion: 'network-v3',
  });

  // 参数：固定观测（清淤后 20%）与换算，偏置 0 -> 4
  const paramReport = decomposeContribution({
    table,
    prevObservation: { kind: 'percent', percent: afterPct },
    nextObservation: { kind: 'percent', percent: afterPct },
    prevMode: 'per_procedure',
    nextMode: 'per_procedure',
    prevBias: 0,
    nextBias: 4,
    topologyVersion: 'network-v3',
  });

  // 撤销规程乙唯一有效的校准批次（等级 2 的 CAL-B-G2）
  const revokedBatchId = 'CAL-B-G2';
  const released = freezePublishedLayer('LAYER-RISK-2026-06', data, records, opts, '2026-06-30T00:00:00Z');
  const revokedData = revokeBatch(data, revokedBatchId);
  const coverageBefore = coverage;
  const coverageAfterRevoke = buildCoverage(records, buildCalibration(revokedData), opts);
  const missingBefore = new Set(coverageBefore.rows.filter((r) => r.status === 'missing_evidence').map((r) => r.segmentId));
  const newlyMissing = coverageAfterRevoke.rows
    .filter((r) => r.status === 'missing_evidence' && !missingBefore.has(r.segmentId))
    .map((r) => r.segmentId)
    .sort();
  const tileStat = (cov: typeof coverageBefore) =>
    cov.tiles.map((t) => ({ tileId: t.tileId, missing: t.counts.missing_evidence, denominator: t.denominator }));
  const replay = replayPublishedLayer(released, revokedData);

  const pairing = calibrationSamples();

  return {
    data,
    contracts,
    records,
    table,
    unifiedGrade2,
    perProcedureGrade2,
    coverage,
    lateContract,
    trial,
    desilting: {
      beforePercent: beforePct,
      afterPercent: afterPct,
      observationContribution: desiltingReport.desiltingContribution,
      linkSectionId: links[0]?.sectionId ?? null,
      inspectionBefore: links[0]?.beforeInspectionId ?? null,
      inspectionAfter: links[0]?.afterInspectionId ?? null,
    },
    param: {
      paramContribution: paramReport.paramContribution,
      before: paramReport.steps[2]?.before ?? null,
      after: paramReport.steps[2]?.after ?? null,
    },
    revocation: {
      before: {
        affectedSegmentIds: coverageBefore.rows
          .filter((r) => r.status !== 'comparable')
          .map((r) => r.segmentId)
          .sort(),
        tiles: tileStat(coverageBefore),
      },
      after: {
        affectedSegmentIds: coverageAfterRevoke.rows
          .filter((r) => r.status !== 'comparable')
          .map((r) => r.segmentId)
          .sort(),
        tiles: tileStat(coverageAfterRevoke),
      },
      newlyMissing,
      revokedBatchId,
      publishedReplay: { ok: replay.ok, divergesFromCurrent: replay.divergesFromCurrent, fingerprint: replay.fingerprint },
    },
    publishedLayer: released,
    pairing: { sampleCount: pairing.samples.length, dropped: pairing.dropped },
  };
}

/** 便捷：返回已撤销规程乙唯一有效批次后的校准数据 */
export function revokedCalibrationData(): CalibrationData {
  return revokeBatch(sampleCalibrationData(), 'CAL-B-G2');
}
