import { describe, expect, it } from 'vitest';
import {
  ALL_PROCEDURES,
  buildCalibration,
  buildCoverage,
  classifyBand,
  convertGrade,
  decomposeContribution,
  evaluateBackfill,
  formCalibrationPairs,
  freezePublishedLayer,
  linkCrossPeriod,
  lookupGradesByPercent,
  replayPublishedLayer,
  runRuleTrial,
  selectContract,
  siltPercent,
  toMillimeter,
} from './calibration';
import {
  DEFAULT_SCENARIO_OPTIONS,
  DESILTING_SECTION,
  checkLateContract,
  mispairedDemo,
  revokedCalibrationData,
  runCalibrationScenario,
  sampleCalibrationData,
  sampleContracts,
  sampleDesilting,
  sampleDesiltingInspections,
  sampleRecords,
} from './calibrationSample';

const scenario = runCalibrationScenario();
const records = sampleRecords();

describe('单位统一与百分比换算', () => {
  it('厘米先换算为毫米，再除以当次内径', () => {
    expect(toMillimeter(3, 'cm')).toBe(30);
    expect(toMillimeter(40, 'mm')).toBe(40);
    // 3cm / 400mm = 7.5%
    expect(siltPercent(3, 'cm', 400)).toBe(7.5);
    // 40mm / 100mm = 40%
    expect(siltPercent(40, 'mm', 100)).toBe(40);
    // 内径为 0 时不产生 NaN
    expect(siltPercent(10, 'mm', 0)).toBe(0);
  });
});

describe('校准对：只有同断面同次巡检可配对', () => {
  it('配对样本产出 26%~28%（甲）、34%~36%（乙）与 44%~46%（等级 3）范围', () => {
    const table = buildCalibration(sampleCalibrationData());
    const a2 = table.procedureRanges.find((r) => r.procedure === 'P_A' && r.grade === 'G2')!;
    const a3 = table.procedureRanges.find((r) => r.procedure === 'P_A' && r.grade === 'G3')!;
    const b2 = table.procedureRanges.find((r) => r.procedure === 'P_B' && r.grade === 'G2')!;
    expect(a2.interval).toEqual({ min: 26, max: 28 });
    expect(a3.interval).toEqual({ min: 44, max: 46 });
    expect(b2.interval).toEqual({ min: 34, max: 36 });
    // 统一表：同等级各规程的最小下界 ~ 最大上界
    expect(table.grades.find((g) => g.grade === 'G2')!.interval).toEqual({ min: 26, max: 36 });
  });

  it('跨断面拼凑的等级与量测不会配对', () => {
    const demo = mispairedDemo();
    const { pairs, dropped } = formCalibrationPairs(demo.grades, demo.measurements);
    expect(pairs).toHaveLength(0);
    expect(dropped[0].reason).toContain('同断面同次巡检');
  });

  it('样例配对无丢弃，校准样本 6 条（甲 4 + 乙 2）', () => {
    expect(scenario.pairing.dropped).toHaveLength(0);
    expect(scenario.pairing.sampleCount).toBe(6);
  });
});

describe('统一表 vs 分规程表', () => {
  it('偏置为 0 时统一表等级 2 得 26~36 分并跨线', () => {
    const g2 = scenario.unifiedGrade2;
    expect(g2.interval).toEqual({ min: 26, max: 36 });
    expect(classifyBand(g2.interval!)).toBe('uncertain');
  });

  it('记录了规程甲的管段按分规程表得 26~28 分，确定为低风险', () => {
    const g2 = scenario.perProcedureGrade2;
    expect(g2.interval).toEqual({ min: 26, max: 28 });
    expect(classifyBand(g2.interval!)).toBe('low');
    expect(g2.evidenceInsufficient).toBe(false);
  });

  it('规程缺失时保留全部可能规程的范围且不误判缺证', () => {
    const table = scenario.table;
    const missingProc = convertGrade('G2', null, 'per_procedure', table);
    expect(missingProc.interval).toEqual({ min: 26, max: 36 });
    expect(missingProc.usedProcedures.sort()).toEqual(['P_A', 'P_B']);
    expect(missingProc.evidenceInsufficient).toBe(false);
  });

  it('任一适用规程缺少校准时标记为缺证', () => {
    const table = buildCalibration(revokedCalibrationData());
    // 规程乙的等级 2 批次已撤销：规程缺失时保留的范围应只剩甲，且标记缺证
    const missingProc = convertGrade('G2', null, 'per_procedure', table);
    expect(missingProc.evidenceInsufficient).toBe(true);
    expect(missingProc.missingProcedures).toContain('P_B');
    // 指定规程甲仍可比
    expect(convertGrade('G2', 'P_A', 'per_procedure', table).evidenceInsufficient).toBe(false);
    // 指定规程乙直接缺证
    expect(convertGrade('G2', 'P_B', 'per_procedure', table).evidenceInsufficient).toBe(true);
  });
});

describe('百分比反查等级', () => {
  it('百分比只命中其所属等级', () => {
    expect(lookupGradesByPercent(27.5, 'P_A', scenario.table)).toEqual(['G2']);
    expect(lookupGradesByPercent(45, 'P_A', scenario.table)).toEqual(['G3']);
    // 统一表下等级 2 为 26~36
    expect(lookupGradesByPercent(35, null, scenario.table, 'unified')).toEqual(['G2']);
  });

  it('落在多个等级的适用范围时保留全部候选', () => {
    // 构造重叠：等级 2 与等级 3 的规程甲范围都在 34~36 附近重叠
    const data = sampleCalibrationData();
    data.batches = data.batches.map((b) =>
      b.batchId === 'CAL-A-G2' ? { ...b, applicableMaxPercent: 35 } : b,
    );
    data.samples = data.samples.map((s) => {
      if (s.sampleId === 'CAL-GO-P_A-G3-a3') return { ...s, depth: 34 };
      if (s.sampleId === 'CAL-GO-P_A-G3-a4') return { ...s, depth: 36 };
      if (s.sampleId === 'CAL-GO-P_A-G2-a2') return { ...s, depth: 35 };
      return s;
    });
    const table = buildCalibration(data);
    // 甲 G2 = 26~35，甲 G3 = 34~36，34.5% 同时落在两者
    const hits = lookupGradesByPercent(34.5, 'P_A', table);
    expect(hits).toContain('G2');
    expect(hits).toContain('G3');
  });
});

describe('契约按采集时间选择', () => {
  it('六月采集、七月换版后才到达的旧等级记录仍选六月契约', () => {
    const check = checkLateContract(records, sampleContracts());
    expect(check.selectedContractId).toBe('CTR-SURVEY-V1');
    expect(check.selectedVersion).toBe('v1-grade');
    // 若误按到达时间（八月）会落到新契约
    expect(check.contractIfArrivalTime).toBe('CTR-SURVEY-V2');
  });

  it('七月采集的记录选择新百分比契约', () => {
    const c = selectContract(sampleContracts(), '市测绘院 / 管网中心巡检表', '2026-07-15T09:00:00Z');
    expect(c?.version).toBe('v2-percent');
  });
});

describe('旧记录回填判定', () => {
  const opts = { mode: 'per_procedure' as const, threshold: 30, bias: 0 };

  it('规程缺失的等级 2 在统一/缺规程口径下待复核', () => {
    const rec = records.find((r) => r.recordId === 'REC-S3')!;
    const d = evaluateBackfill(rec, scenario.table, { ...opts, mode: 'unified' });
    expect(d.status).toBe('review');
    expect(d.reasons).toContain('risk_band_uncertain');
    expect(d.originalKept).toBe(true);
  });

  it('同次实测 35% 与换算低风险异带，阻止自动回填', () => {
    const rec = records.find((r) => r.recordId === 'REC-S5')!;
    const d = evaluateBackfill(rec, scenario.table, opts);
    expect(d.measuredPercent).toBe(35);
    expect(d.band).toBe('low');
    expect(d.measuredBand).toBe('high');
    expect(d.status).toBe('review');
    expect(d.eligible).toBe(false);
    expect(d.reasons).toContain('measured_conflict');
    expect(d.originalKept).toBe(true);
  });

  it('新口径纯量测记录直接可比', () => {
    const rec = records.find((r) => r.recordId === 'REC-S4B')!;
    const d = evaluateBackfill(rec, scenario.table, opts);
    expect(d.measuredPercent).toBe(7.5);
    expect(d.status).toBe('comparable');
    expect(d.eligible).toBe(true);
  });
});

describe('覆盖图计数', () => {
  it('以管段为分母，每段只计一次，状态可下钻', () => {
    const cov = scenario.coverage;
    // S1..S7 + S4A/S4B 共 8 个管段、9 条记录（S7 两条）=> 分母 8
    expect(cov.denominator).toBe(8);
    expect(cov.rows).toHaveLength(8);
    const total = cov.totals.comparable + cov.totals.review + cov.totals.missing_evidence;
    expect(total).toBe(8);
    for (const row of cov.rows) expect(row.decision.originalKept).toBe(true);
  });

  it('撤销规程乙唯一有效批次后，依赖该批次的管段变为缺证，计数更新', () => {
    const before = scenario.coverage;
    const after = buildCalibration(revokedCalibrationData());
    const covAfter = buildCoverage(records, after, DEFAULT_SCENARIO_OPTIONS);
    const missingBefore = new Set(before.rows.filter((r) => r.status === 'missing_evidence').map((r) => r.segmentId));
    const missingAfter = new Set(covAfter.rows.filter((r) => r.status === 'missing_evidence').map((r) => r.segmentId));
    // S2（规程乙等级2）与 S7（迟到的规程乙等级2）应由非缺证转为缺证
    expect(missingAfter.has('S2')).toBe(true);
    expect(missingAfter.has('S7')).toBe(true);
    expect(missingBefore.has('S2')).toBe(false);
    expect(covAfter.totals.missing_evidence).toBeGreaterThan(before.totals.missing_evidence);
    expect(scenario.revocation.newlyMissing.sort()).toEqual(['S2', 'S3', 'S7']);
  });

  it('已发布图层撤销后仍可按旧证据复现', () => {
    expect(scenario.revocation.publishedReplay.ok).toBe(true);
    expect(scenario.revocation.publishedReplay.divergesFromCurrent).toBe(true);
    // 冻结图层指纹与撤销前覆盖一致
    expect(scenario.publishedLayer.fingerprint).toBe(scenario.coverage.version);
  });
});

describe('贡献分解：逐项替换、记录顺序与输入版本', () => {
  it('清淤 40mm->20mm、内径 100mm、偏置与换算固定，观测贡献为 -20', () => {
    expect(scenario.desilting.beforePercent).toBe(40);
    expect(scenario.desilting.afterPercent).toBe(20);
    expect(scenario.desilting.observationContribution).toEqual({ min: -20, max: -20 });
    expect(scenario.desilting.linkSectionId).toBe(DESILTING_SECTION);
  });

  it('固定观测与换算，偏置 0->4，参数贡献为 +4', () => {
    expect(scenario.param.paramContribution).toEqual({ min: 4, max: 4 });
    expect(scenario.param.before).toEqual({ min: 20, max: 20 });
    expect(scenario.param.after).toEqual({ min: 24, max: 24 });
  });

  it('替换顺序为 观测->换算规则->模型参数，并记录各次输入版本', () => {
    const report = decomposeContribution({
      table: scenario.table,
      prevObservation: { kind: 'grade', grade: 'G2', procedure: 'P_A' },
      nextObservation: { kind: 'grade', grade: 'G2', procedure: 'P_A' },
      prevMode: 'unified',
      nextMode: 'per_procedure',
      prevBias: 0,
      nextBias: 0,
      topologyVersion: 'network-v3',
    });
    expect(report.order).toEqual(['observation', 'conversion_rule', 'model_params']);
    expect(report.steps.map((s) => s.replaced)).toEqual(['observation', 'conversion_rule', 'model_params']);
    for (const step of report.steps) {
      expect(step.inputs.topology).toBe('network-v3');
      expect(step.inputs.observation).toBe('grade:G2@P_A');
    }
    // 观测不变 => 清淤贡献 0；规则由统一表收窄到分规程 => 贡献区间 [-8, 0]
    expect(report.desiltingContribution).toEqual({ min: 0, max: 0 });
    expect(report.ruleContribution).toEqual({ min: -8, max: 0 });
    expect(report.ruleContribution!.min).toBeLessThan(0);
  });

  it('缺少同断面复测或清淤记录时清淤贡献为未知', () => {
    const report = decomposeContribution({
      table: scenario.table,
      prevObservation: null,
      nextObservation: { kind: 'percent', percent: 20 },
      prevMode: 'per_procedure',
      nextMode: 'per_procedure',
      prevBias: 0,
      nextBias: 0,
      topologyVersion: 'network-v3',
    });
    expect(report.desiltingUnknown).toBe(true);
    expect(report.desiltingContribution).toBeNull();
    expect(report.steps[0].unknown).toBe(true);
  });

  it('得分只能确定区间时报告有证据支持的贡献范围', () => {
    const report = decomposeContribution({
      table: scenario.table,
      prevObservation: { kind: 'grade', grade: 'G2', procedure: 'P_A' },
      nextObservation: { kind: 'grade', grade: 'G2', procedure: 'P_A' },
      prevMode: 'unified',
      nextMode: 'per_procedure',
      prevBias: 0,
      nextBias: 0,
      topologyVersion: 'network-v3',
    });
    // 统一 26~36 -> 分规程甲 26~28：贡献是区间 [-8, 0]
    expect(report.ruleContribution).toEqual({ min: -8, max: 0 });
  });

  it('跨期复测经同断面与清淤记录关联', () => {
    const links = linkCrossPeriod(sampleDesiltingInspections(), [sampleDesilting()]);
    expect(links).toHaveLength(1);
    expect(links[0].beforeInspectionId).toBe('INS-S10-before');
    expect(links[0].afterInspectionId).toBe('INS-S10-after');
  });
});

describe('规则对照试验', () => {
  it('使用有共同适用证据的规则，检查得分区间与回填资格变化', () => {
    const trial = scenario.trial;
    expect(trial.sharedEvidence.ok).toBe(true);
    expect(trial.sharedEvidence.batchIds).toEqual(['CAL-A-G2']);
    expect(trial.unified.scoreInterval).toEqual({ min: 26, max: 36 });
    expect(trial.perProcedure.scoreInterval).toEqual({ min: 26, max: 28 });
    expect(trial.unified.status).toBe('review');
    expect(trial.perProcedure.status).toBe('comparable');
    expect(trial.eligibilityChanged).toBe(true);
    expect(trial.retainedSeparately).toBe(true);
  });

  it('无共同适用证据时禁止对照试验', () => {
    // 用一条规程乙记录、但只在甲的资格下构造：改为对已撤销乙批次后的记录做试验
    const revokedTable = buildCalibration(revokedCalibrationData());
    const rec = records.find((r) => r.recordId === 'REC-S2')!;
    const trial = runRuleTrial(rec, revokedTable, { mode: 'per_procedure', threshold: 30, bias: 0 });
    // 规程乙批次撤销，统一表仍含规程甲 => 两者可能无共同批次
    expect(trial.sharedEvidence.ok).toBe(false);
  });
});

describe('已发布图层回放（未来只读）', () => {
  it('freeze + replay 指纹稳定', () => {
    const layer = freezePublishedLayer('L', sampleCalibrationData(), sampleRecords(), DEFAULT_SCENARIO_OPTIONS, '2026-06-30T00:00:00Z');
    const replay = replayPublishedLayer(layer);
    expect(replay.ok).toBe(true);
    expect(replay.fingerprint).toBe(layer.fingerprint);
  });
});

describe('ALWAYS：规程枚举稳定', () => {
  it('两种测量规程', () => {
    expect(ALL_PROCEDURES).toEqual(['P_A', 'P_B']);
  });
});
