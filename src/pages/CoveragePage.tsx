import { useMemo, useState } from 'react';
import { Badge, Banner, Empty, Kv } from '../components/ui';
import {
  DEFAULT_BIAS,
  GRADE_LABEL,
  PROCEDURE_LABEL,
  SCORE_THRESHOLD,
  buildCalibration,
  buildCoverage,
  replayPublishedLayer,
  type CoverageResult,
} from '../domain/calibration';
import {
  revokedCalibrationData,
  runCalibrationScenario,
  sampleCalibrationData,
  sampleRecords,
} from '../domain/calibrationSample';
import { BAND_LABEL, BAND_TONE, STATUS_LABEL, STATUS_TONE, intervalText } from './calibrationShared';

const OPTIONS = { mode: 'per_procedure' as const, threshold: SCORE_THRESHOLD, bias: DEFAULT_BIAS };

export function CoveragePage() {
  const [revoked, setRevoked] = useState(false);
  const [drillSegment, setDrillSegment] = useState<string | null>(null);

  const scenario = useMemo(() => runCalibrationScenario(), []);

  const current = useMemo<CoverageResult>(() => {
    const data = revoked ? revokedCalibrationData() : sampleCalibrationData();
    return buildCoverage(sampleRecords(), buildCalibration(data), OPTIONS);
  }, [revoked]);

  const baseline = scenario.coverage;
  const layer = scenario.publishedLayer;
  const replay = useMemo(() => replayPublishedLayer(layer, revoked ? revokedCalibrationData() : sampleCalibrationData()), [layer, revoked]);

  return (
    <div>
      <div className="header">
        <h2>⑫ 覆盖图、规则对照试验与批次撤销回放</h2>
        <span className="meta">
          覆盖图以各瓦片纳入复算的管段为分母，每段只计一次；状态可下钻到原记录与版本
        </span>
      </div>

      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>覆盖图（分瓦片统计）</h3>
          <button className={revoked ? 'ghost' : 'ghost danger'} onClick={() => setRevoked((v) => !v)}>
            {revoked ? '恢复规程乙校准批次' : '撤销规程乙唯一有效校准批次'}
          </button>
        </div>
        {revoked && (
          <Banner tone="warn">
            已撤销规程乙等级 2 的唯一有效批次 <span className="mono">CAL-B-G2</span>：依赖该批次的待发布管段变为缺证，
            覆盖计数随之更新；原已发布图层仍按旧证据复现。
          </Banner>
        )}
        <div className="grid2">
          {(revoked ? current.tiles : baseline.tiles).map((t) => (
            <div className="panel" key={t.tileId} style={{ marginBottom: 0 }}>
              <h4 style={{ marginTop: 0 }}>{t.tileId} · 分母 {t.denominator} 段</h4>
              <div className="row">
                <Badge tone="ok">可比 {t.counts.comparable}</Badge>
                <Badge tone="warn">待复核 {t.counts.review}</Badge>
                <Badge tone="block">缺证 {t.counts.missing_evidence}</Badge>
              </div>
              <div className="progress" style={{ marginTop: 8 }}>
                <i style={{ width: `${(t.counts.comparable / t.denominator) * 100}%`, background: 'var(--ok)' }} />
              </div>
              <div className="small">可比占比 {Math.round((t.counts.comparable / t.denominator) * 100)}%（每段只计一次）</div>
            </div>
          ))}
        </div>
        <Kv
          pairs={[
            ['覆盖分母（纳入复算管段）', `${(revoked ? current : baseline).denominator} 段`],
            ['状态计数', `可比 ${(revoked ? current : baseline).totals.comparable} / 待复核 ${(revoked ? current : baseline).totals.review} / 缺证 ${(revoked ? current : baseline).totals.missing_evidence}`],
            ['使用批次', (revoked ? current : baseline).batchIdsUsed.join('、') || '无'],
            ['覆盖版本指纹', <span className="mono">{(revoked ? current : baseline).version}</span>],
          ]}
        />
      </div>

      <div className="panel">
        <h3>管段级状态（可下钻到原记录与版本）</h3>
        <div className="scroll-x">
          <table>
            <thead><tr><th>管段</th><th>瓦片</th><th>状态</th><th>记录</th><th>得分区间</th><th>换算版本</th><th></th></tr></thead>
            <tbody>
              {(revoked ? current : baseline).rows.map((row) => (
                <tr key={row.segmentId}>
                  <td><strong>{row.segmentId}</strong></td>
                  <td>{row.tileId}</td>
                  <td><Badge tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</Badge></td>
                  <td className="mono">{row.recordId}</td>
                  <td>{intervalText(row.decision.scoreInterval)}</td>
                  <td className="mono small">{row.decision.conversionVersion}</td>
                  <td><button className="ghost" style={{ padding: '3px 8px' }} onClick={() => setDrillSegment(row.segmentId === drillSegment ? null : row.segmentId)}>下钻</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {drillSegment && (() => {
          const row = (revoked ? current : baseline).rows.find((r) => r.segmentId === drillSegment);
          const rec = sampleRecords().find((r) => r.recordId === row?.recordId);
          if (!row || !rec) return <Empty text="无下钻记录" />;
          return (
            <div className="panel" style={{ marginTop: 10, background: '#f8fafc' }}>
              <h4 style={{ marginTop: 0 }}>下钻：管段 {row.segmentId} · 原记录 {rec.recordId}</h4>
              <Kv
                pairs={[
                  ['断面 / 巡检', `${rec.sectionId} / ${rec.inspectionId}`],
                  ['测量规程', rec.procedure ? PROCEDURE_LABEL[rec.procedure] : '缺失'],
                  ['旧等级', rec.grade ? GRADE_LABEL[rec.grade] : '（纯量测记录）'],
                  ['采集 / 到达', `${rec.collectedAt} / ${rec.arrivedAt}`],
                  ['来源', rec.source],
                  ['管段版本', rec.segmentVersion],
                  ['记录原值（深度/内径）', rec.measurement ? `${rec.measurement.depth}${rec.measurement.unit} / ${rec.measurement.diameterMm}mm` : '无'],
                  ['换算区间', row.decision.converted ? `${intervalText(row.decision.converted.interval)}%` : '—'],
                  ['风险带', row.decision.band ? <Badge tone={BAND_TONE[row.decision.band]}>{BAND_LABEL[row.decision.band]}</Badge> : '—'],
                  ['原始记录保留', '是（换算版本另存）'],
                ]}
              />
            </div>
          );
        })()}
      </div>

      <div className="panel">
        <h3>规则对照试验（统一表 vs 分规程表）</h3>
        <p className="small">
          对同一次规程甲巡检（S1：等级 2）分别套用统一表与分规程表，检查得分区间与回填资格怎样变化；
          试验要求两种表共享共同适用证据，结果单独留存。
        </p>
        <TrialTable trial={scenario.trial} />
      </div>

      <div className="panel">
        <h3>已发布图层回放（撤销批次后仍按旧证据复现）</h3>
        <Banner tone={replay.ok ? 'ok' : 'block'}>
          {replay.ok
            ? `已发布图层 ${layer.layerId} 按冻结证据复现成功（指纹 ${replay.fingerprint.slice(0, 12)}…）。`
            : '回放指纹与冻结证据不一致，图层无法复现！'}
          {replay.divergesFromCurrent !== null && (
            <span> 与当前（{revoked ? '已撤销' : '未撤销'}）校准重建结果{replay.divergesFromCurrent ? '不同' : '一致'}。</span>
          )}
        </Banner>
        <Kv
          pairs={[
            ['发布图层', layer.layerId],
            ['发布时间', layer.publishedAt],
            ['冻结时覆盖指纹', <span className="mono">{layer.fingerprint}</span>],
            ['回放覆盖指纹', <span className="mono">{replay.fingerprint}</span>],
            ['回放状态计数', `可比 ${replay.coverage.totals.comparable} / 待复核 ${replay.coverage.totals.review} / 缺证 ${replay.coverage.totals.missing_evidence}`],
          ]}
        />
      </div>
    </div>
  );
}

function TrialTable({ trial }: { trial: ReturnType<typeof runCalibrationScenario>['trial'] }) {
  return (
    <>
      <Banner tone={trial.sharedEvidence.ok ? 'info' : 'block'}>
        共同适用证据：{trial.sharedEvidence.ok ? trial.sharedEvidence.batchIds.join('、') : '无'} —— {trial.sharedEvidence.reason}
      </Banner>
      <table>
        <thead><tr><th>指标</th><th>统一表</th><th>分规程表</th><th>变化</th></tr></thead>
        <tbody>
          <tr>
            <td>得分区间</td>
            <td>{intervalText(trial.unified.scoreInterval)}</td>
            <td>{intervalText(trial.perProcedure.scoreInterval)}</td>
            <td>{intervalText(trial.scoreRangeShift)}</td>
          </tr>
          <tr>
            <td>风险带</td>
            <td>{trial.unified.band ? <Badge tone={BAND_TONE[trial.unified.band]}>{BAND_LABEL[trial.unified.band]}</Badge> : '—'}</td>
            <td>{trial.perProcedure.band ? <Badge tone={BAND_TONE[trial.perProcedure.band]}>{BAND_LABEL[trial.perProcedure.band]}</Badge> : '—'}</td>
            <td>{trial.unified.band !== trial.perProcedure.band ? <Badge tone="warn">风险带改变</Badge> : <Badge tone="gray">不变</Badge>}</td>
          </tr>
          <tr>
            <td>回填资格</td>
            <td>{trial.unified.eligible ? <Badge tone="ok">可回填</Badge> : <Badge tone="block">阻止</Badge>}</td>
            <td>{trial.perProcedure.eligible ? <Badge tone="ok">可回填</Badge> : <Badge tone="block">阻止</Badge>}</td>
            <td>{trial.eligibilityChanged ? <Badge tone="warn">资格改变</Badge> : <Badge tone="gray">不变</Badge>}</td>
          </tr>
          <tr>
            <td>状态</td>
            <td><Badge tone={STATUS_TONE[trial.unified.status]}>{STATUS_LABEL[trial.unified.status]}</Badge></td>
            <td><Badge tone={STATUS_TONE[trial.perProcedure.status]}>{STATUS_LABEL[trial.perProcedure.status]}</Badge></td>
            <td>—</td>
          </tr>
        </tbody>
      </table>
      <p className="small">
        试验编号 <span className="mono">{trial.trialId}</span>，使用批次 {trial.unified.batchIds.join('、') || '无'}；
        结果单独留存（retainedSeparately = {String(trial.retainedSeparately)}），不影响现行对照表。
      </p>
    </>
  );
}
