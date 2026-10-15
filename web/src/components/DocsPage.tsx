import { useCallback, useEffect, useState } from 'react';
import { api, docUrl } from '../api';
import { insertIntoPrompt, useServerEvents } from '../events';
import type { DocKind, DocMeta } from '../types';

export const DOC_KIND: Record<DocKind, string> = { plan: '계획서', screen: '화면설계서', test: '테스트 결과서', other: '기타 문서' };

function when(iso: string) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 세션의 산출물(계획서·화면설계서·테스트 결과서). 판별로 본다.
 * live(열린 세션에서 연 것)면 프롬프트에서 언급해 Claude가 다시 읽게 할 수 있다. 보관함에서 열면 닫은 세션도 본다.
 */
export default function DocsPage({ sessionId, ticket, live = false, initial, backLabel, onBack }: {
  sessionId: number; ticket: string; live?: boolean; initial: string | null; backLabel: string; onBack: () => void;
}) {
  const [docs, setDocs] = useState<DocMeta[] | null>(null);
  const [pick, setPick] = useState<string | null>(initial);
  const [version, setVersion] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => { api.docs(sessionId).then(setDocs).catch((e) => setError(e.message)); }, [sessionId]);
  useEffect(reload, [reload]);
  useServerEvents((e) => { if (e.type === 'docs.updated' && e.sessionId === sessionId) reload(); });
  useEffect(() => { if (initial) { setPick(initial); setVersion(null); } }, [initial]);

  const current = docs?.find((d) => d.name === pick) ?? docs?.[0] ?? null;
  // 새 판이 저장되면 최신 판을 다시 그린다.
  const shown = version && current && version < current.version ? version : current?.version;
  const groups = (['plan', 'screen', 'test', 'other'] as DocKind[]).map((k) => ({ kind: k, list: (docs ?? []).filter((d) => d.kind === k) })).filter((g) => g.list.length);

  function mention(d: DocMeta) {
    insertIntoPrompt(`${DOC_KIND[d.kind]} "${d.title}"(${d.path})를 참고해서 `);
    onBack();
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
            <button onClick={() => api.revealArchive(sessionId).catch((e) => setError(e.message))}>폴더 열기</button>
            <button onClick={onBack}>{backLabel}</button>
          </div>
        </div>
        {error && <p className="banner error" role="alert">{error}</p>}

        {docs && docs.length === 0 ? (
          <div className="card">
            <p>아직 산출물이 없습니다.</p>
            <p className="muted small">프롬프트 입력창에서 "계획 먼저"를 켜고 보내면 계획서와 화면설계서가, 화면 테스트를 돌리면 테스트 결과서가 여기에 쌓입니다.</p>
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
                            <span className="change-stat small muted">{d.version}판 · {when(d.updated_at)}</span>
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
                    {live && <button className="small-btn primary" onClick={() => mention(current)}>새 대화에서 언급</button>}
                    <a className="small-btn" href={docUrl(sessionId, current.name, shown)} target="_blank" rel="noreferrer">새 창으로</a>
                    <button className="small-btn" onClick={() => remove(current)}>삭제</button>
                  </div>
                </div>
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
