import { useMemo, useState } from 'react';
import { Badge, Banner, Kv } from '../components/ui';
import {
  DEFAULT_BIAS,
  GRADE_LABEL,
  PROCEDURE_LABEL,
  SCORE_THRESHOLD,
  classifyBand,
  convertGrade,
  decomposeContribution,
  evaluateBackfill,
  lookupGradesByPercent,
  type BackfillDecision,
  type ConversionMode,
} from '../domain/calibration';
import {
  DESILTING_SECTION,
  checkLateContract,
  runCalibrationScenario,
  sampleCalibrationData,
  sampleContracts,
  sampleDesilting,
  sampleDesiltingInspections,
  sampleRecords,
} from '../domain/calibrationSample';
import { BAND_LABEL, BAND_TONE, STATUS_LABEL, STATUS_TONE, intervalText } from './calibrationShared';

export function CalibrationPage() {
  const [mode, setMode] = useState<ConversionMode>('per_procedure');
  const [bias, setBias] = useState(DEFAULT_BIAS);

  const table = useMemo(() => runCalibrationScenario().table, []);
  const records = useMemo(() => sampleRecords(), []);
  const contracts = useMemo(() => sampleContracts(), []);
  const options = { mode, threshold: SCORE_THRESHOLD, bias };

  const decisions = records.map((r) => ({ record: r, decision: evaluateBackfill(r, table, options) }));
  const late = checkLateContract(records, contracts);

  const g2Unified = convertGrade('G2', null, 'unified', table);
  const g2ProcA = convertGrade('G2', 'P_A', 'per_procedure', table);
  const g2ProcB = convertGrade('G2', 'P_B', 'per_procedure', table);
  const g2Missing = convertGrade('G2', null, 'per_procedure', table);

  return (
    <div>
      <div className="header">
        <h2>⑪ 淤积口径复算与旧记录回填</h2>
        <span className="meta">
          百分比 = 同断面淤积深度 / 当次管内径（先统一单位）；旧等级经校准范围换算，决定哪些旧记录能回填到新风险图层
        </span>
      </div>

      <Banner tone="info">
        风险分数 = 淤积百分比 + 模型偏置；达到 <strong>{SCORE_THRESHOLD}</strong> 判为高风险。
        当前偏置 <strong>{bias}</strong>，换算口径 <strong>{mode === 'unified' ? '统一对照表' : '分规程对照表'}</strong>。
      </Banner>

      <div className="panel">
        <h3>换算口径与模型偏置</h3>
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="small">换算表：</span>
          <label><input type="radio" checked={mode === 'per_procedure'} onChange={() => setMode('per_procedure')} /> 分规程表（记录规程时收窄区间）</label>
          <label><input type="radio" checked={mode === 'unified'} onChange={() => setMode('unified')} /> 统一对照表（跨规程取并集）</label>
        </div>
        <div className="row">
          <span className="small">模型偏置：</span>
          {[0, 4].map((b) => (
            <label key={b}><input type="radio" checked={bias === b} onChange={() => setBias(b)} /> {b}</label>
          ))}
          <span className="small">（切到 4 可直接观察“参数贡献 +4 分”）</span>
        </div>
      </div>

      <div className="grid2">
        <div className="panel">
          <h3>统一对照表（旧图层兼容：只有等级也能复算）</h3>
          <table>
            <thead><tr><th>等级</th><th>统一区间</th><th>规程甲</th><th>规程乙</th><th>缺失规程时</th></tr></thead>
            <tbody>
              {table.grades.map((g) => (
                <tr key={g.grade}>
                  <td><strong>{GRADE_LABEL[g.grade]}</strong></td>
                  <td><Badge tone={classifyBand(g.interval) === 'uncertain' ? 'warn' : 'ok'}>{intervalText(g.interval)}%</Badge></td>
                  <td>{g.byProcedure.P_A ? `${intervalText(g.byProcedure.P_A!)}%` : <Badge tone="block">缺</Badge>}</td>
                  <td>{g.byProcedure.P_B ? `${intervalText(g.byProcedure.P_B!)}%` : <Badge tone="block">缺</Badge>}</td>
                  <td>{intervalText(g.interval)}%（{g.missingProcedures.length ? <Badge tone="warn">缺 {g.missingProcedures.map((p) => PROCEDURE_LABEL[p]).join('、')}</Badge> : '全规程齐备'}）</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small">
            统一表取同等级各规程校准范围的<strong>最小下界与最大上界</strong>；等级 2 合并 26%~36%，跨越 30 风险线，
            因此统一表下等级 2 的旧记录只能“待复核”。分规程表把区间收窄，但需分别追踪各规程的校准证据。
          </p>
        </div>

        <div className="panel">
          <h3>等级 2 在不同口径下的换算与风险带</h3>
          <table>
            <thead><tr><th>口径</th><th>换算区间</th><th>风险带</th><th>缺证</th></tr></thead>
            <tbody>
              {[
                ['统一表（忽略规程）', g2Unified],
                ['分规程表 · 规程甲', g2ProcA],
                ['分规程表 · 规程乙', g2ProcB],
                ['分规程表 · 规程缺失', g2Missing],
              ].map(([label, conv]) => {
                const c = conv as ReturnType<typeof convertGrade>;
                const band = c.interval ? classifyBand({ min: c.interval.min + bias, max: c.interval.max + bias }) : null;
                return (
                  <tr key={label as string}>
                    <td>{label as string}</td>
                    <td>{intervalText(c.interval)}%</td>
                    <td>{band ? <Badge tone={BAND_TONE[band]}>{BAND_LABEL[band]}</Badge> : <Badge tone="block">无</Badge>}</td>
                    <td>{c.evidenceInsufficient ? <Badge tone="block">缺证</Badge> : <Badge tone="ok">齐备</Badge>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <h4>百分比反查等级（保留全部候选）</h4>
          <div className="row">
            {[
              { pct: 27.5, proc: 'P_A' as const },
              { pct: 35, proc: 'P_A' as const },
              { pct: 35, proc: null },
              { pct: 45, proc: 'P_B' as const },
            ].map(({ pct, proc }) => {
              const hits = lookupGradesByPercent(pct, proc, table, mode);
              return (
                <div key={`${pct}-${proc ?? 'none'}`} className="panel" style={{ padding: '8px 10px', marginBottom: 0 }}>
                  <div className="small">{pct}% · {proc ? PROCEDURE_LABEL[proc] : '缺规程'}</div>
                  <div>{hits.length ? hits.map((g) => <Badge key={g} tone="info">{GRADE_LABEL[g]}</Badge>) : <span className="small">无匹配</span>}</div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="panel">
        <h3>契约选择：按来源 + 采集时间（迟到记录仍按采集时间解释）</h3>
        <table>
          <thead><tr><th>契约</th><th>口径</th><th>采集生效区间</th><th>说明</th></tr></thead>
          <tbody>
            {contracts.map((c) => (
              <tr key={c.contractId}>
                <td className="mono">{c.contractId}<div className="small">{c.version}</div></td>
                <td>{c.metric === 'grade' ? '等级' : '百分比'}</td>
                <td className="small">{c.effectiveFrom} ~ {c.effectiveTo ?? '至今'}</td>
                <td>{c.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Banner tone="ok">
          迟到记录 <strong>{late.recordId}</strong>：采集于 {late.collectedAt}、到达于 {late.arrivedAt}，
          选中 <strong>{late.selectedContractId}</strong>（{late.selectedVersion}）。
          若误按到达时间会落到 {late.contractIfArrivalTime}（新百分比契约），结论将失真。
        </Banner>
      </div>

      <div className="panel">
        <h3>旧记录逐条回填判定（原始记录与换算版本均保留）</h3>
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>记录</th><th>管段</th><th>断面 / 巡检</th><th>规程</th><th>旧等级</th>
                <th>换算区间</th><th>换算得分</th><th>换算带</th><th>同次实测</th><th>实测带</th><th>回填</th><th>原因</th>
              </tr>
            </thead>
            <tbody>
              {decisions.map(({ record, decision }) => (
                <tr key={record.recordId}>
                  <td className="mono">{record.recordId}</td>
                  <td>{record.segmentId}</td>
                  <td className="small">{record.sectionId}<div className="mono">{record.inspectionId}</div></td>
                  <td>{record.procedure ? PROCEDURE_LABEL[record.procedure] : <Badge tone="warn">缺失</Badge>}</td>
                  <td>{record.grade ? GRADE_LABEL[record.grade] : <span className="small">—（纯量测）</span>}</td>
                  <td>{decision.converted ? intervalText(decision.converted.interval) + '%' : '—'}</td>
                  <td>{intervalText(decision.scoreInterval)}</td>
                  <td>{decision.band ? <Badge tone={BAND_TONE[decision.band]}>{BAND_LABEL[decision.band]}</Badge> : '—'}</td>
                  <td>{decision.measuredPercent !== null ? `${decision.measuredPercent}%` : <span className="small">无</span>}</td>
                  <td>{decision.measuredBand ? <Badge tone={BAND_TONE[decision.measuredBand]}>{BAND_LABEL[decision.measuredBand]}</Badge> : '—'}</td>
                  <td><Badge tone={STATUS_TONE[decision.status]}>{STATUS_LABEL[decision.status]}</Badge></td>
                  <td className="small">{reasonText(decision)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small">
          三条阻止自动回填的规则：换算区间横跨风险线、任一适用规程缺少校准（缺证）、
          同次实测与换算结果处于不同风险带。回填被阻止时原始记录仍保留，换算版本单列为候选。
        </p>
      </div>

      <div className="panel">
        <h3>同一断面淤积复测（跨期经清淤记录关联）</h3>
        <DesiltingSection />
      </div>
    </div>
  );
}

function reasonText(d: BackfillDecision): string {
  if (d.reasons.length === 0) return '—';
  const map: Record<string, string> = {
    risk_band_uncertain: '换算区间跨风险线',
    evidence_insufficient: '适用规程缺校准（缺证）',
    measured_conflict: '同次实测与换算异带',
    no_conversion: '无可换算的量测',
  };
  return d.reasons.map((r) => map[r] ?? r).join('；');
}

function DesiltingSection() {
  const desilting = sampleDesilting();
  const inspections = sampleDesiltingInspections();
  const before = inspections[0];
  const after = inspections[1];
  const data = sampleCalibrationData();
  const table = runCalibrationScenario().table;
  const pctOf = (r: typeof before) =>
    r.measurement ? (r.measurement.depth / r.measurement.diameterMm) * 100 : 0;
  const beforePct = pctOf(before);
  const afterPct = pctOf(after);
  // 观测贡献：固定换算与偏置
  const obsReport = decomposeContribution({
    table,
    prevObservation: before.measurement ? { kind: 'percent', percent: beforePct } : null,
    nextObservation: { kind: 'percent', percent: afterPct },
    prevMode: 'per_procedure',
    nextMode: 'per_procedure',
    prevBias: 0,
    nextBias: 0,
    topologyVersion: 'network-v3',
  });
  // 参数贡献：固定观测与换算，偏置 0 -> 4
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
  return (
    <>
      <Kv
        pairs={[
          ['断面', `${DESILTING_SECTION}（内径 ${desilting.diameterMm} 毫米）`],
          ['清淤前', `${desilting.beforeDepth}${desilting.unit} → ${beforePct}%`],
          ['清淤后', `${desilting.afterDepth}${desilting.unit} → ${afterPct}%`],
          ['校准证据规模', `${data.samples.length} 条配对样本、${data.batches.length} 个批次`],
        ]}
      />
      <table style={{ marginTop: 10 }}>
        <thead><tr><th>替换项</th><th>锁定项</th><th>前得分</th><th>后得分</th><th>贡献</th></tr></thead>
        <tbody>
          <tr>
            <td>观测（清淤 40mm→20mm）</td><td className="small">换算=分规程表、偏置=0、拓扑=v3</td>
            <td>{intervalText(obsReport.steps[0].before)}</td>
            <td>{intervalText(obsReport.steps[0].after)}</td>
            <td><Badge tone="ok">{intervalText(obsReport.desiltingContribution)}</Badge></td>
          </tr>
          <tr>
            <td>模型参数（偏置 0→4）</td><td className="small">观测=20%、换算=分规程表、拓扑=v3</td>
            <td>{intervalText(paramReport.steps[2].before)}</td>
            <td>{intervalText(paramReport.steps[2].after)}</td>
            <td><Badge tone="warn">{intervalText(paramReport.paramContribution)}</Badge></td>
          </tr>
        </tbody>
      </table>
      <p className="small">
        锁定拓扑与其他特征，按「观测 → 换算规则 → 模型参数」顺序每次只替换一项，用连续两次可比得分之差计算贡献；
        清淤使分数减 20（40%→20%），偏置 0→4 使分数加 4。缺少同断面复测或清淤记录时，清淤贡献列为未知。
      </p>
    </>
  );
}
