import { useCallback, useEffect, useState } from 'react';
import { api, docUrl } from '../api';
import { reportPrompt } from './TaskBar';
import { insertIntoPrompt, useServerEvents } from '../events';
import SendButton from './SendButton';
import ApprovalCards from './ApprovalCards';
import type { DocKind, DocMeta, SessionWiki } from '../types';

export const DOC_KIND: Record<DocKind, string> = { plan: '계획서', screen: '화면설계서', db: 'DB 변경 설계서', test: '테스트 결과서', report: '완료 보고서', other: '기타 문서' };

/** Project-Wiki에 게시할 수 있는 문서(계획서·DB 변경 설계서·완료 보고서) */
export const wikiPublishable = (d: DocMeta) => d.kind === 'plan' || d.kind === 'db' || d.kind === 'report';

/** 위키 게시 상태 배지. 게시한 적 없으면 아무것도 그리지 않는다. */
export function WikiBadge({ doc }: { doc: DocMeta }) {
  const p = doc.published;
  if (!p || !wikiPublishable(doc)) return null;
  if (p.deleted_at) return <span className="pill wiki-badge">게시 취소됨</span>;
  if (p.version < doc.version) return <span className="pill warn wiki-badge" title="로컬에 더 새로운 판이 있습니다">위키 {p.version}판 · 로컬 {doc.version}판</span>;
  return <span className="pill accent wiki-badge">위키 게시됨 {p.version}판</span>;
}

function when(iso: string) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 세션의 산출물(계획서·화면설계서·테스트 결과서·완료 보고서). 판별로 본다.
 * live(열린 세션에서 연 것)면 프롬프트에서 언급해 Claude가 다시 읽게 할 수 있다. 보관함에서 열면 닫은 세션도 본다.
 */
export default function DocsPage({ sessionId, ticket, live = false, initial, backLabel, onBack }: {
  sessionId: number; ticket: string; live?: boolean; initial: string | null; backLabel: string; onBack: () => void;
}) {
  const [docs, setDocs] = useState<DocMeta[] | null>(null);
  const [pick, setPick] = useState<string | null>(initial);
  const [version, setVersion] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [wiki, setWiki] = useState<SessionWiki | null>(null);
  const [wikiBusy, setWikiBusy] = useState(false);

  const reload = useCallback(() => { api.docs(sessionId).then(setDocs).catch((e) => setError(e.message)); }, [sessionId]);
  const reloadWiki = useCallback(() => { api.sessionWiki(sessionId).then(setWiki).catch(() => setWiki(null)); }, [sessionId]);
  useEffect(reload, [reload]);
  useEffect(reloadWiki, [reloadWiki]);
  useServerEvents((e) => {
    if (e.type === 'docs.updated' && e.sessionId === sessionId) reload();
    if (e.type === 'approvals.updated' && e.sessionId === sessionId) reloadWiki();
  });
  useEffect(() => { if (initial) { setPick(initial); setVersion(null); } }, [initial]);

  const current = docs?.find((d) => d.name === pick) ?? docs?.[0] ?? null;
  // 새 판이 저장되면 최신 판을 다시 그린다.
  const shown = version && current && version < current.version ? version : current?.version;
  const groups = (['plan', 'screen', 'db', 'test', 'report', 'other'] as DocKind[]).map((k) => ({ kind: k, list: (docs ?? []).filter((d) => d.kind === k) })).filter((g) => g.list.length);

  function mention(d: DocMeta) {
    insertIntoPrompt(`${DOC_KIND[d.kind]} "${d.title}"(${d.path})를 참고해서 `);
    onBack();
  }

  // 작업 목록 없이 진행한 세션도 여기서 보고서를 부탁할 수 있다. 보내고 대화로 돌아가 진행을 보게 한다.
  async function requestReport() {
    try { await api.prompt(sessionId, reportPrompt(ticket), []); onBack(); } catch (e) { setError((e as Error).message); }
  }

  // 위키 게시는 승인 카드를 띄우기만 한다. 실제로 보내는 것은 카드에서 승인했을 때다.
  async function publish(d: DocMeta) {
    setWikiBusy(true); setError(null);
    try { await api.wikiPublish(sessionId, d.name); reloadWiki(); } catch (e) { setError((e as Error).message); }
    setWikiBusy(false);
  }

  async function unpublish(d: DocMeta) {
    if (!confirm(`"${d.title}"의 위키 게시를 취소할까요? 위키 노트는 지워지지 않고 "게시 취소됨"으로 남으며, 이 노트를 인용한 위키는 다음 실행 때 다시 만들어집니다.`)) return;
    setWikiBusy(true); setError(null);
    try { await api.wikiUnpublish(sessionId, d.name); } catch (e) { setError((e as Error).message); }
    setWikiBusy(false);
  }

  async function remove(d: DocMeta) {
    if (!confirm(`"${d.title}"의 모든 판을 지울까요?`)) return;
    try { await api.deleteDoc(sessionId, d.name); setPick(null); } catch (e) { setError((e as Error).message); }
  }

  return (
    <main className="main scroll">
      <div className="settings changes">
        <div className="page-head">
          <div>
            <p className="muted small">{ticket} · 산출물</p>
            <h1>산출물</h1>
          </div>
          <div className="row">
            {live && <button onClick={requestReport}>{docs?.some((d) => d.kind === 'report') ? '보고서 다시 작성' : '완료 보고서 작성'}</button>}
            <button onClick={() => api.revealArchive(sessionId).catch((e) => setError(e.message))}>폴더 열기</button>
            <button onClick={onBack}>{backLabel}</button>
          </div>
        </div>
        {error && <p className="banner error" role="alert">{error}</p>}
        <ApprovalCards session={{ id: sessionId }} only="wikipublish" />

        {docs && docs.length === 0 ? (
          <div className="card">
            <p>아직 산출물이 없습니다.</p>
            <p className="muted small">프롬프트 입력창에서 "계획 먼저"를 켜고 보내면 계획서와 화면설계서가, 화면 테스트를 돌리면 테스트 결과서가, 개발을 마치고 "완료 보고서 작성"을 누르면 완료 보고서가 여기에 쌓입니다.</p>
          </div>
        ) : (
          <div className="changes-body">
            <aside className="card changes-list" aria-label="문서 목록">
              {!docs && <p className="muted small">불러오는 중</p>}
              {groups.map((g) => (
                <section key={g.kind}>
                  <div className="changes-wt"><strong>{DOC_KIND[g.kind]}</strong><span className="muted small">{g.list.length}개</span></div>
                  <ul>
                    {g.list.map((d) => {
                      const active = current?.name === d.name;
                      return (
                        <li key={d.name}>
                          <button className={`change-item doc-item${active ? ' active' : ''}`} aria-current={active ? 'true' : undefined} onClick={() => { setPick(d.name); setVersion(null); }}>
                            <span className="change-path">
                              <span className="change-name">{d.title}</span>
                              <span className="change-dir mono">{d.name}</span>
                            </span>
                            <span className="change-stat small muted">{d.version}판 · {when(d.updated_at)}{wiki?.connected && <WikiBadge doc={d} />}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </aside>

            {current && (
              <section className="card doc-area" aria-label="문서 보기">
                <div className="diff-head">
                  <div className="diff-title">
                    <h2>{current.title}</h2>
                    <p className="muted small">{DOC_KIND[current.kind]} · <code>{current.path}</code></p>
                  </div>
                  <div className="row">
                    {current.version > 1 && (
                      <select aria-label="판" value={shown} onChange={(e) => setVersion(Number(e.target.value))}>
                        {Array.from({ length: current.version }, (_, i) => current.version - i).map((v) => (
                          <option key={v} value={v}>{v}판{v === current.version ? ' (최신)' : ''}</option>
                        ))}
                      </select>
                    )}
                    {live && <SendButton className="small-btn primary" label="대화에서 언급" onSend={() => mention(current)} />}
                    <a className="small-btn" href={docUrl(sessionId, current.name, shown)} target="_blank" rel="noreferrer">새 창으로</a>
                    <button className="small-btn" onClick={() => remove(current)}>삭제</button>
                  </div>
                </div>
                {wiki?.connected && wikiPublishable(current) && (() => {
                  const p = current.published;
                  const waiting = wiki.pending.includes(current.name);
                  return (
                    <div className="wiki-bar small" aria-label="Project-Wiki 게시">
                      <strong>Project-Wiki</strong>
                      <WikiBadge doc={current} />
                      <button className="small-btn" disabled={wikiBusy || waiting} onClick={() => publish(current)}>
                        {waiting ? '승인 카드 확인 중' : p ? '다시 게시' : '위키 게시'}
                      </button>
                      {p && !p.deleted_at && <a className="small-btn" href={p.url} target="_blank" rel="noreferrer">위키에서 보기 ↗</a>}
                      {p && !p.deleted_at && <button className="small-btn" disabled={wikiBusy} onClick={() => unpublish(current)}>게시 취소</button>}
                      {p && (
                        <span className="muted">
                          {p.deleted_at ? `취소 ${when(p.deleted_at)}` : `게시 ${when(p.published_at)}`} · {p.project?.name ?? wiki.project?.name ?? ''} · <code>{p.path}</code>
                        </span>
                      )}
                    </div>
                  );
                })()}
                <iframe
                  key={`${current.name}:${shown}:${current.updated_at}`}
                  className="doc-frame"
                  title={current.title}
                  sandbox=""
                  src={docUrl(sessionId, current.name, shown)}
                />
              </section>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
