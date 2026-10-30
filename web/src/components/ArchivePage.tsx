import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useServerEvents } from '../events';
import type { ArchiveEntry } from '../types';
import { DOC_KIND } from './DocsPage';

/**
 * 모든 세션의 산출물(계획서·화면설계서·테스트 결과서). 세션을 닫거나 리소스를 정리해도 남아서,
 * 작업이 끝난 뒤에도 티켓이나 제목으로 찾아 볼 수 있다.
 */
export default function ArchivePage({ onOpen }: { onOpen: (e: ArchiveEntry, name?: string) => void }) {
  const [list, setList] = useState<ArchiveEntry[] | null>(null);
  const [q, setQ] = useState('');
  const [project, setProject] = useState('');
  const [error, setError] = useState<string | null>(null);
  const reload = () => { api.archive().then(setList).catch((e) => setError(e.message)); };
  useEffect(reload, []);
  useServerEvents((e) => { if (e.type === 'docs.updated' || e.type === 'sessions.changed') reload(); });

  const projects = useMemo(() => [...new Set((list ?? []).flatMap((e) => e.projects))].sort(), [list]);

  const groups = useMemo(() => {
    const t = q.trim().toLowerCase();
    const hit = (e: ArchiveEntry) => (!project || e.projects.includes(project)) && (!t || [e.ticket, e.summary, ...e.branches, ...e.docs.map((d) => d.title)].some((x) => x.toLowerCase().includes(t)));
    const m = new Map<string, ArchiveEntry[]>();
    for (const e of (list ?? []).filter(hit)) m.set(e.workspace_name, [...(m.get(e.workspace_name) ?? []), e]);
    return [...m];
  }, [list, q, project]);

  return (
    <main className="main scroll">
      <div className="settings archive">
        <div className="page-head">
          <div>
            <p className="muted small">세션을 닫아도 남습니다</p>
            <h1>산출물 보관함</h1>
          </div>
          <div className="row">
            <button onClick={() => api.revealArchive().catch((e) => setError(e.message))}>보관함 폴더 열기</button>
          </div>
        </div>
        {error && <p className="banner error" role="alert">{error}</p>}
        <div className="archive-filters">
          <label className="sr-only" htmlFor="archive-project">프로젝트</label>
          <select id="archive-project" className="archive-project" value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">모든 프로젝트</option>
            {projects.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <label className="sr-only" htmlFor="archive-q">티켓, 제목, 브랜치, 문서 이름으로 찾기</label>
          <input id="archive-q" className="archive-search" placeholder="티켓, 제목, 브랜치, 문서 이름으로 찾기" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {!list && <p className="muted small">불러오는 중</p>}
        {list?.length === 0 && (
          <div className="card">
            <p>아직 산출물이 없습니다.</p>
            <p className="muted small">"계획 먼저"로 보낸 계획서·화면설계서와 화면 테스트 결과서가 세션별로 여기에 모입니다.</p>
          </div>
        )}
        {list && list.length > 0 && groups.length === 0 && <p className="muted small">찾는 산출물이 없습니다.</p>}
        {groups.map(([ws, entries]) => (
          <section key={ws} className="archive-group">
            <h2>{ws}</h2>
            <ul className="archive-list">
              {entries.map((e) => (
                <li key={e.session_id} className="card archive-item">
                  <div className="archive-head">
                    <button className="link archive-title" onClick={() => onOpen(e)}>
                      <strong>{e.ticket}</strong> {e.summary || '요약 없음'}
                    </button>
                    {e.closed && <span className="archive-badge">닫힌 세션</span>}
                    <span className="spacer" />
                    <span className="muted small">{e.updated_at.slice(0, 10)}</span>
                    <button className="small-btn" onClick={() => api.revealArchive(e.session_id).catch((err) => setError(err.message))}>폴더</button>
                  </div>
                  <p className="muted small">
                    {e.branches.map((b) => <code key={b} className="branch">{b}</code>)}
                    {e.prs.map((p) => <a key={p.number} href={p.url} target="_blank" rel="noreferrer"> PR #{p.number}{p.state === 'MERGED' ? ' 머지됨' : p.state === 'OPEN' ? ' 열림' : ' 닫힘'}</a>)}
                  </p>
                  <ul className="archive-docs">
                    {e.docs.map((d) => (
                      <li key={d.name}>
                        <button className="small-btn" onClick={() => onOpen(e, d.name)}>
                          <span className="muted">{DOC_KIND[d.kind]}</span> {d.title}{d.version > 1 ? ` · ${d.version}판` : ''}
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </main>
  );
}
