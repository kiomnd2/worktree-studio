import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { insertIntoPrompt, useServerEvents } from '../events';
import { parsePatch, toSplit, type DiffLine } from '../diff';
import type { ChangedFile, ChangeScope, Session, WorktreeChanges } from '../types';

const STATUS: Record<ChangedFile['status'], { label: string; cls: string }> = {
  added: { label: '추가', cls: 'add' },
  untracked: { label: '새 파일', cls: 'add' },
  modified: { label: '수정', cls: 'mod' },
  deleted: { label: '삭제', cls: 'del' },
  renamed: { label: '이름 변경', cls: 'mod' },
};

type Pick = { worktree_id: number; path: string };

/** 세션 워크트리의 변경 파일 목록과 파일별 diff. 기준 브랜치와 갈라진 뒤 바뀐 것, 또는 커밋 안 한 것만 본다. */
export default function ChangesPage({ session, onBack }: { session: Session; onBack: () => void }) {
  const [scope, setScope] = useState<ChangeScope>('base');
  const [data, setData] = useState<WorktreeChanges[] | null>(null);
  const [pick, setPick] = useState<Pick | null>(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api.changes(session.id, scope).then(setData).catch((e) => setError(e.message));
  }, [session.id, scope]);
  useEffect(reload, [reload]);
  // Claude가 작업을 끝내면 파일이 바뀌었을 수 있다.
  useServerEvents((e) => { if (e.type === 'session.updated' && e.sessionId === session.id) reload(); });

  const all = useMemo(() => (data ?? []).flatMap((w) => w.files.map((f) => ({ w, f }))), [data]);
  const current = pick ? all.find((x) => x.w.worktree_id === pick.worktree_id && x.f.path === pick.path) : all[0];
  const q = filter.trim().toLowerCase();

  return (
    <main className="main scroll">
      <div className="settings changes">
        <div className="page-head">
          <div>
            <p className="muted small">{session.ticket} · 변경 파일</p>
            <h1>변경 파일 비교</h1>
          </div>
          <div className="row">
            <div className="segmented" role="group" aria-label="비교 범위">
              <button aria-pressed={scope === 'base'} className={scope === 'base' ? 'on' : ''} onClick={() => setScope('base')}>기준 브랜치와</button>
              <button aria-pressed={scope === 'uncommitted'} className={scope === 'uncommitted' ? 'on' : ''} onClick={() => setScope('uncommitted')}>커밋 안 한 것만</button>
            </div>
            <button onClick={reload}>새로고침</button>
            <button onClick={onBack}>세션 화면으로</button>
          </div>
        </div>
        {error && <p className="banner error" role="alert">{error}</p>}

        <div className="changes-body">
          <aside className="card changes-list" aria-label="변경 파일 목록">
            <label className="sr-only" htmlFor="changes-filter">파일 이름으로 거르기</label>
            <input id="changes-filter" className="mono" placeholder="파일 이름으로 거르기" value={filter} onChange={(e) => setFilter(e.target.value)} />
            {!data && <p className="muted small">불러오는 중</p>}
            {data?.map((w) => {
              const files = w.files.filter((f) => !q || f.path.toLowerCase().includes(q));
              const add = w.files.reduce((n, f) => n + (f.additions ?? 0), 0);
              const del = w.files.reduce((n, f) => n + (f.deletions ?? 0), 0);
              return (
                <section key={w.worktree_id}>
                  <div className="changes-wt">
                    <strong>{w.project_name}</strong>
                    <span className="muted small">{w.files.length}개 <span className="plus">+{add}</span> <span className="minus">−{del}</span></span>
                  </div>
                  <div className="muted small changes-ref">
                    {scope === 'base' ? <><code>{w.branch}</code> ← <code>{w.base_branch}</code>에서 갈라진 지점 <code>{w.compare_ref}</code></> : <>마지막 커밋 이후</>}
                  </div>
                  {w.error && <p className="error-text">{w.error}</p>}
                  {w.files.length === 0 && !w.error && <p className="muted small">바뀐 파일이 없습니다.</p>}
                  <ul>
                    {files.map((f) => {
                      const active = current?.w.worktree_id === w.worktree_id && current.f.path === f.path;
                      return (
                        <li key={f.path}>
                          <button className={`change-item${active ? ' active' : ''}`} aria-current={active ? 'true' : undefined} onClick={() => setPick({ worktree_id: w.worktree_id, path: f.path })}>
                            <span className={`change-badge ${STATUS[f.status].cls}`} title={STATUS[f.status].label}>{STATUS[f.status].label}</span>
                            <span className="change-path" title={f.old_path ? `${f.old_path} → ${f.path}` : f.path}>
                              <span className="change-name mono">{baseOf(f.path)}</span>
                              {dirOf(f.path) && <span className="change-dir mono"><bdi>{dirOf(f.path).replace(/\/$/, '')}</bdi></span>}
                            </span>
                            <span className="change-stat small">{f.binary ? '바이너리' : <><span className="plus">+{f.additions ?? 0}</span> <span className="minus">−{f.deletions ?? 0}</span></>}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </aside>

          <section className="card diff-area" aria-label="파일 비교">
            {current ? <FileDiff key={`${current.w.worktree_id}:${current.f.path}:${scope}`} session={session} wt={current.w} file={current.f} scope={scope} /> : (
              <p className="muted">{data ? '바뀐 파일이 없습니다.' : '불러오는 중'}</p>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);

function readPref(key: string, fallback: boolean) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : v === '1'; } catch { return fallback; }
}
function writePref(key: string, v: boolean) {
  try { localStorage.setItem(key, v ? '1' : '0'); } catch { /* 사생활 보호 모드 등 */ }
}

function FileDiff({ session, wt, file, scope }: { session: Session; wt: WorktreeChanges; file: ChangedFile; scope: ChangeScope }) {
  const [split, setSplit] = useState(() => readPref('wts:diff-split', true));
  const [full, setFull] = useState(false);
  const [ws, setWs] = useState(false);
  const [patch, setPatch] = useState<{ patch: string; binary: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPatch(null); setError(null);
    api.diff(session.id, wt.worktree_id, file.path, scope, full, ws).then(setPatch).catch((e) => setError(e.message));
  }, [session.id, wt.worktree_id, file.path, scope, full, ws]);

  const hunks = useMemo(() => (patch ? parsePatch(patch.patch) : []), [patch]);

  return (
    <>
      <div className="diff-head">
        <div className="diff-title">
          <h2 className="mono">{file.path}</h2>
          <p className="muted small">
            {wt.project_name} · {STATUS[file.status].label}{file.old_path ? ` (${file.old_path}에서)` : ''}
            {!file.binary && <> · <span className="plus">+{file.additions ?? 0}</span> <span className="minus">−{file.deletions ?? 0}</span></>}
          </p>
        </div>
        <div className="row">
          <div className="segmented" role="group" aria-label="보기 방식">
            <button aria-pressed={split} className={split ? 'on' : ''} onClick={() => { setSplit(true); writePref('wts:diff-split', true); }}>나란히</button>
            <button aria-pressed={!split} className={!split ? 'on' : ''} onClick={() => { setSplit(false); writePref('wts:diff-split', false); }}>한 줄</button>
          </div>
          <label className="start-check small"><input type="checkbox" checked={ws} onChange={(e) => setWs(e.target.checked)} /> 공백 무시</label>
          <label className="start-check small"><input type="checkbox" checked={full} onChange={(e) => setFull(e.target.checked)} /> 파일 전체</label>
          <button className="small-btn" onClick={() => insertIntoPrompt(`${wt.project_name}의 ${file.path} 변경 내용을 봐줘.`)}>새 대화로 보내기</button>
        </div>
      </div>
      {error && <p className="banner error" role="alert">{error}</p>}
      {!patch && !error && <p className="muted">불러오는 중</p>}
      {patch?.binary && <p className="placeholder">바이너리 파일이라 내용을 비교하지 않습니다.</p>}
      {patch && !patch.binary && hunks.length === 0 && <p className="placeholder">{ws ? '공백을 빼면 바뀐 내용이 없습니다.' : '바뀐 내용이 없습니다.'}</p>}
      {hunks.length > 0 && (
        <div className={`diff ${split ? 'split' : 'unified'}`}>
          {hunks.map((h, i) => (
            <div key={i} className="hunk">
              {!full && <div className="hunk-head mono">{h.header}</div>}
              {split ? (
                <table className="diff-table">
                  <tbody>
                    {toSplit(h.lines).map((r, j) => (
                      <tr key={j}>
                        <Num n={r.left?.old ?? null} kind={r.left?.kind} />
                        <Code line={r.left} side="left" />
                        <Num n={r.right?.new ?? null} kind={r.right?.kind} />
                        <Code line={r.right} side="right" />
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <table className="diff-table">
                  <tbody>
                    {h.lines.map((l, j) => (
                      <tr key={j}>
                        <Num n={l.old} kind={l.kind} />
                        <Num n={l.new} kind={l.kind} />
                        <Code line={l} side="both" />
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function Num({ n, kind }: { n: number | null; kind?: DiffLine['kind'] }) {
  return <td className={`ln ${kind ?? 'empty'}`}>{n ?? ''}</td>;
}

function Code({ line, side }: { line: DiffLine | null; side: 'left' | 'right' | 'both' }) {
  if (!line) return <td className="code empty" />;
  const mark = line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' ';
  return (
    <td className={`code ${line.kind}`}>
      <span className="mark" aria-hidden="true">{side === 'both' || line.kind !== 'ctx' ? mark : ' '}</span>
      <span className="sr-only">{line.kind === 'add' ? '추가: ' : line.kind === 'del' ? '삭제: ' : ''}</span>
      {line.text || ' '}
    </td>
  );
}
