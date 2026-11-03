import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { insertIntoPrompt, useServerEvents } from '../events';
import { type PlanInsight, planInsight, prettySql } from '../planinsight';
import type { ExplainResult, QueryDetail, QueryList, QuerySort, QueryStat, QueryWarning } from '../types';

const WARNING: Record<QueryWarning, { label: string; tone: 'err' | 'warn' | 'accent'; why: string }> = {
  'n+1': { label: 'N+1 의심', tone: 'err', why: '같은 스레드에서 2초 안에 10번 넘게, 값만 바뀌어 나왔습니다. 목록을 돌며 한 건씩 조회하는지 보세요.' },
  large: { label: '대량 결과', tone: 'err', why: '한 번에 1,000행 넘게 돌려줬습니다. 페이징이나 조건이 빠졌는지 보세요.' },
  slow: { label: '느림', tone: 'err', why: '한 번에 500ms를 넘겼습니다.' },
  cache: { label: '캐시 후보', tone: 'accent', why: '호출 수 상위인데 결과 크기가 매번 같습니다. 코드성 데이터라면 캐시를 검토하세요.' },
  'select-star': { label: 'SELECT *', tone: 'warn', why: '필요 없는 컬럼까지 읽습니다.' },
  'like-prefix': { label: '앞 % LIKE', tone: 'warn', why: "앞에 %가 붙은 LIKE는 인덱스를 못 탑니다." },
  'fn-column': { label: '컬럼에 함수', tone: 'warn', why: 'WHERE 컬럼에 함수(TO_CHAR, UPPER 등)를 씌우면 그 컬럼 인덱스를 못 탑니다.' },
  'no-where': { label: 'WHERE 없음', tone: 'warn', why: 'WHERE 없이 테이블 전체를 읽거나 바꿉니다.' },
  'big-offset': { label: '큰 OFFSET', tone: 'warn', why: 'OFFSET이 커서 앞 행을 모두 읽고 버립니다.' },
};

const SORT_LABEL: Record<QuerySort, string> = { calls: '호출 수', rows: '최대 행', time: '최대 시간', recent: '최근' };

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const num = (n: number | null) => (n === null ? '-' : n.toLocaleString());

/**
 * BE 서버 로그에서 센 쿼리 모양별 집계. 초기화 뒤 화면 하나를 열어 그 화면이 낸 쿼리를 본다.
 * 고를 때만 실행 계획을 받고, 고치는 일은 근거를 묶어 새 대화로 넘긴다(보내기와 반영은 사용자가 한다).
 */
export default function QueryPanel({ worktreeId, projectName }: { worktreeId: number; projectName: string }) {
  const [sort, setSort] = useState<QuerySort>('calls');
  const [warningsOnly, setWarningsOnly] = useState(false);
  const [data, setData] = useState<QueryList | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api.queries(worktreeId, sort, warningsOnly).then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message));
  }, [worktreeId, sort, warningsOnly]);
  useEffect(reload, [reload]);
  useEffect(() => setSelected(null), [worktreeId]);
  useServerEvents((e) => { if (e.type === 'queries' && e.worktreeId === worktreeId) reload(); });

  async function reset() {
    setError(null);
    try { await api.resetQueries(worktreeId); setSelected(null); reload(); } catch (e) { setError((e as Error).message); }
  }

  const rows = data?.rows ?? [];
  const totalCalls = rows.reduce((n, r) => n + r.calls, 0);
  const warned = rows.filter((r) => r.warnings.length).length;

  return (
    <div className="query-panel">
      <div className="query-tools">
        <label className="small muted" htmlFor="query-sort">정렬</label>
        <select id="query-sort" value={sort} onChange={(e) => setSort(e.target.value as QuerySort)}>
          {(Object.keys(SORT_LABEL) as QuerySort[]).map((k) => <option key={k} value={k}>{SORT_LABEL[k]}</option>)}
        </select>
        <button className={`chip-btn${warningsOnly ? ' on' : ''}`} aria-pressed={warningsOnly} onClick={() => setWarningsOnly(!warningsOnly)}>경고만</button>
        <span className="muted small">{rows.length}개 모양 · {totalCalls.toLocaleString()}회{warned ? ` · 경고 ${warned}` : ''}</span>
        <span className="spacer" />
        <button className="small-btn" title="집계를 비웁니다. 비운 뒤 화면 하나를 열면 그 화면이 낸 쿼리만 봅니다." onClick={reset}>초기화</button>
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
      {data && rows.length === 0 && <EmptyHelp data={data} warningsOnly={warningsOnly} />}
      {rows.length > 0 && (
        <div className="query-table-wrap">
          <table className="query-table">
            <colgroup>
              <col className="c-shape" /><col className="c-mapper" /><col className="c-calls" /><col className="c-rows" /><col className="c-time" /><col className="c-warn" />
            </colgroup>
            <thead>
              <tr><th>쿼리</th><th>매퍼</th><th className="num">호출</th><th className="num">행 평균/최대</th><th className="num">시간</th><th>경고</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className={r.key === selected ? 'selected' : ''} onClick={() => setSelected(r.key === selected ? null : r.key)}>
                  <td className="mono shape" title={r.shape}>
                    <button className="link" aria-expanded={r.key === selected} onClick={(e) => { e.stopPropagation(); setSelected(r.key === selected ? null : r.key); }}>{short(r.shape, 300)}</button>
                  </td>
                  <td className="mono small mapper" title={r.mapper ?? undefined}>{r.mapper ?? '-'}</td>
                  <td className="num">{r.calls.toLocaleString()}</td>
                  <td className="num">{num(r.rows_avg)} / {num(r.rows_max)}</td>
                  <td className="num">{r.ms_max === null ? '-' : `${r.ms_avg} / ${r.ms_max}ms`}</td>
                  <td><Warnings list={r.warnings} muted={r.muted} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected && data && (
        <QueryModal onClose={() => setSelected(null)}>
          <Detail key={selected} worktreeId={worktreeId} projectName={projectName} stat={rows.find((r) => r.key === selected) ?? null} queryKey={selected} connections={data.connections} />
        </QueryModal>
      )}
    </div>
  );
}

/**
 * 쿼리 상세 창. 로그 영역을 크게 본 상태(position: fixed)에서도 위에 뜨도록 body에 그린다.
 * Esc는 이 창만 닫는다(로그 크게 보기까지 닫히지 않게 먼저 받아 멈춘다).
 */
function QueryModal({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="overlay query-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog wide query-dialog" role="dialog" aria-modal="true" aria-labelledby="query-detail-title">
        {children}
        <div className="dialog-actions">
          <button className="primary" autoFocus onClick={onClose}>닫기</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Warnings({ list, muted }: { list: QueryWarning[]; muted: boolean }) {
  if (muted) return <span className="muted small">숨김</span>;
  return <span className="query-warns">{list.map((w) => <span key={w} className={`pill ${WARNING[w].tone}`} title={WARNING[w].why}>{WARNING[w].label}</span>)}</span>;
}

/** 쿼리가 없을 때: SQL 로그를 켰는지, 어떤 패키지를 켰는지 보여 줘 사용자가 직접 고칠 수 있게 한다. */
function EmptyHelp({ data, warningsOnly }: { data: QueryList; warningsOnly: boolean }) {
  if (warningsOnly) return <p className="muted small">경고가 붙은 쿼리가 없습니다.</p>;
  const info = data.sql_log;
  return (
    <div className="query-empty small">
      <p>아직 서버 로그에서 SQL을 찾지 못했습니다. 미리보기에서 화면을 열면 그 화면이 낸 쿼리가 모입니다.</p>
      {!info && <p className="muted">이 서버를 도구에서 띄우면 매퍼 SQL 로그를 켜서 띄웁니다.</p>}
      {info && !info.enabled && <p className="muted">서버 실행 창에서 SQL 로그 켜기를 끈 채로 띄웠습니다. 다시 띄울 때 켜세요.</p>}
      {info?.enabled && (
        <>
          {info.keys.length > 0 && <p className="muted">넣은 환경값: {info.keys.map((k) => <code key={k}>{k}=DEBUG</code>).reduce<React.ReactNode[]>((a, c, i) => (i ? [...a, ' ', c] : [c]), [])}</p>}
          {info.kept.length > 0 && <p className="muted">환경값에 직접 넣은 값을 따름: {info.kept.join(', ')}</p>}
          {info.packages.length === 0 && !info.hibernate && (
            <p className="muted">매퍼 XML namespace나 @MapperScan에서 패키지를 찾지 못했습니다. 환경값에 <code>LOGGING_LEVEL_&lt;매퍼 패키지&gt;=DEBUG</code>(예: LOGGING_LEVEL_COM_EXAMPLE_MAPPER)를 넣고 다시 띄우세요.</p>
          )}
          <p className="muted">로그가 나오는데도 비어 있으면 프로젝트 로깅 설정(logback 등)이 DEBUG를 막고 있거나, 지원하지 않는 로그 형식입니다(MyBatis, Hibernate, p6spy를 읽습니다).</p>
        </>
      )}
    </div>
  );
}

function Detail({ worktreeId, projectName, stat, queryKey, connections }: {
  worktreeId: number; projectName: string; stat: QueryStat | null; queryKey: string; connections: QueryList['connections'];
}) {
  const [detail, setDetail] = useState<QueryDetail | null>(null);
  const [plan, setPlan] = useState<ExplainResult | null>(null);
  // 고르지 않으면 서버가 정한다(켜진 연결, 마지막으로 붙은 연결 순).
  const [conn, setConn] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const autoRan = useRef(false);

  // 목록이 바뀔 때(호출 수 증가 등) 상세도 새로 받는다. 받은 실행 계획은 그대로 둔다.
  const statKey = stat ? `${stat.calls}:${stat.muted}:${stat.warnings.join(',')}` : '';
  useEffect(() => {
    api.query(worktreeId, queryKey).then(setDetail).catch((e) => setError(e.message));
  }, [worktreeId, queryKey, statKey]);

  async function explain(analyze = false) {
    setBusy(true);
    setPlanError(null);
    try {
      const r = await api.explainQuery(worktreeId, queryKey, conn, analyze);
      setPlan(r);
      setConn(r.connection_id);
    } catch (e) { setPlanError((e as Error).message); } finally { setBusy(false); }
  }

  // 쿼리를 고르면 실행 계획을 바로 받는다. 읽기 SELECT이고 연결이 있을 때만, 처음 한 번.
  const canExplain = Boolean(detail?.example && connections.length && /^\s*(SELECT|WITH)\b/i.test(detail.example.sql));
  useEffect(() => {
    if (!canExplain || autoRan.current) return;
    autoRan.current = true;
    explain(false);
  }, [canExplain]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!detail) {
    return error ? <p id="query-detail-title" className="error-text" role="alert">{error}</p>
      : <p id="query-detail-title" className="muted" role="status"><span className="spinner" aria-hidden="true" /> 쿼리 상세를 불러오는 중</p>;
  }
  const engine = connections.find((c) => c.id === (conn ?? plan?.connection_id))?.engine ?? (connections.length === 1 ? connections[0].engine : undefined);
  const fromEnv = connections.length > 0 && connections.every((c) => c.from_env);
  const sqlEngine = plan?.engine ?? engine ?? connections[0]?.engine;

  async function toggleMute() {
    setError(null);
    try { await api.muteQuery(worktreeId, queryKey, !detail!.muted); } catch (e) { setError((e as Error).message); }
  }

  const d = detail;
  const loc = d.location;
  return (
    <section className="query-detail" aria-label="쿼리 상세">
      <div className="query-detail-head">
        <h1 id="query-detail-title" className="mono query-title">{loc?.short_id ?? d.mapper ?? '매퍼 모름'}</h1>
        <span className="muted small">호출 {d.calls.toLocaleString()} · 행 {num(d.rows_avg)}/{num(d.rows_max)}{d.ms_max !== null ? ` · ${d.ms_avg}/${d.ms_max}ms` : ''}</span>
      </div>
      {d.warnings.length > 0 && (
        <ul className="query-why small">
          {d.warnings.map((w) => <li key={w}><span className={`pill ${WARNING[w].tone}`}>{WARNING[w].label}</span> {WARNING[w].why}</li>)}
        </ul>
      )}

      <div className="query-section">
        <div className="small muted">위치</div>
        {loc ? (
          <div className="query-loc small">
            <div><span className="muted">매퍼</span> <code>{loc.full_id}</code></div>
            <div><span className="muted">XML</span> <code>{loc.file}:{loc.line}</code></div>
            {loc.callers.length > 0 ? (
              <div>
                <span className="muted">부르는 곳</span>
                <ul>{loc.callers.map((c) => <li key={`${c.file}:${c.line}`}><code>{c.file}:{c.line}</code> <span className="muted mono">{c.text}</span></li>)}</ul>
              </div>
            ) : <div className="muted">부르는 곳을 찾지 못했습니다.</div>}
            {loc.candidates > 1 && <div className="muted">같은 이름의 문장이 {loc.candidates}개라 SQL의 테이블로 골랐습니다.</div>}
          </div>
        ) : (
          <p className="muted small">
            {d.logger ? <>로그의 로거 <code>{d.logger}</code>에 맞는 매퍼 XML을 찾지 못했습니다.</> : '로그에 매퍼 이름이 없습니다(MyBatis 로그가 아니거나, 도구를 다시 켠 뒤 아직 안 찍힘).'}
          </p>
        )}
      </div>

      <div className="query-section">
        <div className="small muted">모양</div>
        <pre className="query-sql">{prettySql(d.shape, sqlEngine)}</pre>
      </div>
      {d.example ? (
        <div className="query-section">
          <div className="small muted">예시 SQL (마지막 호출, 값 포함)</div>
          <pre className="query-sql">{prettySql(d.example.filled, sqlEngine)}</pre>
          {d.example.params.length > 0 && (
            <div className="small muted mono query-params">파라미터: {d.example.params.map((p) => (p.value === null ? 'null' : `${p.value}${p.type ? `(${p.type})` : ''}`)).join(', ')}</div>
          )}
        </div>
      ) : (
        <p className="muted small">예시 SQL이 없습니다. 도구를 다시 켜면 값이 들어간 SQL은 남지 않습니다. 화면을 한 번 더 열어 주세요.</p>
      )}

      <div className="query-actions">
        {connections.length > 1 && (
          <select aria-label="실행 계획을 볼 DB 연결" value={conn ?? ''} onChange={(e) => setConn(e.target.value ? Number(e.target.value) : undefined)}>
            {conn === undefined && <option value="">자동 선택</option>}
            {connections.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.target}){c.enabled ? ' · 켜짐' : ''}</option>)}
          </select>
        )}
        <button className="small-btn" disabled={busy || !canExplain} title={!connections.length ? '이 앱에 DB 연결이 없습니다' : undefined} onClick={() => explain(false)}>{busy ? '받는 중' : plan ? '실행 계획 다시 받기' : '실행 계획'}</button>
        {engine === 'postgres' && <button className="small-btn" disabled={busy || !canExplain} title="질의를 실제로 돌립니다(읽기 전용 트랜잭션, 롤백)" onClick={() => explain(true)}>ANALYZE로 실행</button>}
        <button className="small-btn primary" title="근거를 묶어 새 대화 탭의 입력창에 넣습니다. 보내기는 직접 합니다." onClick={() => insertIntoPrompt(optimizePrompt(projectName, d, plan))}>최적화 요청</button>
        <span className="spacer" />
        <button className="small-btn" onClick={toggleMute}>{d.muted ? '경고 보이기' : '경고 숨기기'}</button>
      </div>
      {!connections.length && <p className="muted small">실행 계획을 보려면 DB 설정에서 이 앱의 DB 연결을 추가하거나, 환경값에 DB 주소(ORACLE_HOST, SPRING_DATASOURCE_URL 등)를 넣으세요.</p>}
      {fromEnv && <p className="muted small">DB 설정에 연결이 없어 서버 환경값에서 짐작한 연결로 붙습니다.</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      {planError && <p className="error-text query-plan-error" role="alert">{planError}</p>}
      {busy && !plan && <p className="muted small">실행 계획을 받는 중…</p>}
      {plan && <PlanView plan={plan} actualRows={d.rows_max} />}
    </section>
  );
}

const LEVEL_LABEL = { bad: '문제', warn: '주의', info: '참고', ok: '좋음' } as const;
const LEVEL_TONE = { bad: 'err', warn: 'warn', info: 'accent', ok: 'ok' } as const;

/** 실행 계획: 풀이(요약과 단계별 설명)를 먼저, 원본 계획은 접어 둔다. */
function PlanView({ plan, actualRows }: { plan: ExplainResult; actualRows: number | null }) {
  const insight = useMemo(() => planInsight(plan, actualRows), [plan, actualRows]);
  return (
    <div className="query-plan">
      <div className="query-plan-head">
        <strong>실행 계획</strong>
        <span className="small muted">{plan.connection} · {plan.ms}ms</span>
      </div>
      {insight.findings.length > 0 && (
        <ul className="plan-findings">
          {insight.findings.map((f, i) => <li key={i} className={`plan-finding ${f.level}`}><span className={`pill ${LEVEL_TONE[f.level]}`}>{LEVEL_LABEL[f.level]}</span> <span>{f.text}</span></li>)}
        </ul>
      )}
      {insight.steps.length > 0 && <PlanSteps insight={insight} />}
      <details className="plan-raw" open={!insight.steps.length && !insight.findings.length}>
        <summary className="small">원본 계획</summary>
        <pre className="query-sql plan">{plan.plan || '(계획이 비어 있습니다)'}</pre>
      </details>
      <div className="small muted">관련 테이블</div>
      {plan.tables.map((t) => (
        <div key={t.name} className="query-table-info small">
          <strong className="mono">{t.name}</strong> <span className="muted">행 {t.rows === null ? '알 수 없음' : t.rows.toLocaleString()}</span>
          {t.indexes.length ? (
            <ul>
              {t.indexes.map((i) => (
                <li key={i.name} className="mono">
                  {i.name}{i.unique ? ' (UNIQUE)' : ''}: {i.columns}{i.used && <span className="pill ok">계획에서 씀</span>}
                </li>
              ))}
            </ul>
          ) : <div className="muted">인덱스 없음</div>}
        </div>
      ))}
      {plan.notes.map((n) => <p key={n} className="muted small">{n}</p>)}
    </div>
  );
}

/** 단계별 풀이. 들여쓰기가 깊은 단계가 먼저 실행된다(같은 깊이는 위에서 아래로). */
function PlanSteps({ insight }: { insight: PlanInsight }) {
  return (
    <div className="plan-steps-wrap">
      <table className="plan-steps">
        <colgroup><col className="c-id" /><col className="c-op" /><col className="c-rows" /><col className="c-cost" /><col /></colgroup>
        <thead><tr><th>Id</th><th>단계</th><th className="num">예상 행</th><th className="num">비용</th><th>설명</th></tr></thead>
        <tbody>
          {insight.steps.map((s) => (
            <tr key={s.id} className={s.level ?? ''}>
              <td className="num mono">{s.id}</td>
              <td className="mono"><span style={{ paddingLeft: `${s.depth * 12}px` }} className="plan-op">{s.op}</span>{s.name && <div className="plan-name" style={{ paddingLeft: `${s.depth * 12}px` }}>{s.name}</div>}</td>
              <td className="num mono">{s.rows || '-'}</td>
              <td className="num mono">{s.cost || '-'}</td>
              <td>
                {s.desc}
                {s.preds.map((p, i) => <div key={i} className="plan-pred mono">{p}</div>)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">들여쓰기가 깊은 단계가 먼저 실행되고, 결과가 위 단계로 올라갑니다. 비용은 아래 단계 비용을 포함한 누적값입니다.</p>
    </div>
  );
}

/** Claude에게 넘길 근거. 고치기 전에 원인과 수정안을 먼저 받는다. */
function optimizePrompt(project: string, d: QueryDetail, plan: ExplainResult | null): string {
  const lines = [
    `${project} 서버 로그에서 이 쿼리가 문제로 보여. 원인을 짚고 최적화 방안을 제안해줘.`,
    '아래 매퍼 XML(또는 쿼리를 만드는 코드)의 수정안을 diff로 먼저 보여 주고, 내가 확인한 뒤에 고쳐. 인덱스가 필요하면 DDL은 mcp__studio__db_query로 보내 승인받아.',
    '',
    `매퍼: ${d.location?.full_id ?? d.mapper ?? '모름'}`,
    ...(d.location ? [`매퍼 XML: ${d.location.file}:${d.location.line}`, ...d.location.callers.slice(0, 5).map((c) => `부르는 곳: ${c.file}:${c.line}`)] : []),
    `집계: 호출 ${d.calls}회, 행 평균 ${num(d.rows_avg)} 최대 ${num(d.rows_max)}${d.ms_max !== null ? `, 시간 평균 ${d.ms_avg}ms 최대 ${d.ms_max}ms` : ''}`,
    `경고: ${d.warnings.length ? d.warnings.map((w) => WARNING[w].label).join(', ') : '없음'}`,
    `쿼리 key: ${d.key} (mcp__studio__server_queries로 다시 볼 수 있음)`,
    '모양:', '```sql', d.shape, '```',
  ];
  if (d.example) lines.push('예시 SQL:', '```sql', d.example.filled, '```');
  if (plan) {
    const insight = planInsight(plan, d.rows_max);
    if (insight.findings.length) lines.push('계획 풀이:', ...insight.findings.map((f) => `- [${LEVEL_LABEL[f.level]}] ${f.text}`));
    lines.push(`실행 계획 (${plan.connection}):`, '```', plan.plan.split('\n').slice(0, 80).join('\n'), '```');
    for (const t of plan.tables) {
      lines.push(`- ${t.name}: 행 ${t.rows ?? '알 수 없음'}, 인덱스 ${t.indexes.length ? t.indexes.map((i) => `${i.name}(${i.columns})${i.used ? '*' : ''}`).join(', ') : '없음'}`);
    }
    if (plan.tables.some((t) => t.indexes.some((i) => i.used))) lines.push('(*: 계획에서 쓴 인덱스)');
  } else {
    lines.push('실행 계획은 아직 안 봤어. 필요하면 mcp__studio__db_explain으로 봐.');
  }
  return lines.join('\n');
}
