import { useEffect, useState } from 'react';
import { api } from '../../api';
import { insertIntoPrompt } from '../../events';
import type { DdlPreview, ErdProject, ParsedDdl, Session } from '../../types';

/**
 * DDL 가져오기(붙여넣기·워크트리 파일 → 파싱 → 미리보기 → 반영)와 내보내기(DBMS별 생성).
 * 가져오기는 같은 이름 테이블의 컬럼을 덮어쓰고(erd-vibe tables/sync), 지우지는 않는다.
 */

const DBMS = ['ORACLE', 'MYSQL', 'MARIADB', 'POSTGRESQL'];
const GEN_DBMS = ['ORACLE', 'MYSQL', 'MARIADB', 'POSTGRESQL', 'MSSQL', 'SQLITE'];
const STATUS: Record<DdlPreview['status'], [string, string]> = { new: ['새로', 'accent'], changed: ['바뀜', 'warn'], same: ['같음', ''] };
type DdlFile = { worktree_id: number; project_name: string; path: string };

export default function DdlDialog({ session, project, mode, seedFile, selectedId, onApplied, onClose }: {
  session: Session; project: ErdProject; mode: 'import' | 'export'; seedFile: string | null; selectedId: string | null;
  onApplied: (p: ErdProject) => void; onClose: () => void;
}) {
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog wide" role="dialog" aria-modal="true" aria-labelledby="ddl-title" onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
        {mode === 'import'
          ? <ImportPane session={session} project={project} seedFile={seedFile} onApplied={onApplied} onClose={onClose} />
          : <ExportPane project={project} selectedId={selectedId} onClose={onClose} />}
      </div>
    </div>
  );
}

function ImportPane({ session, project, seedFile, onApplied, onClose }: { session: Session; project: ErdProject; seedFile: string | null; onApplied: (p: ErdProject) => void; onClose: () => void }) {
  const [source, setSource] = useState<'paste' | 'file'>(seedFile ? 'file' : 'paste');
  const [text, setText] = useState('');
  const [files, setFiles] = useState<DdlFile[] | null>(null);
  const [file, setFile] = useState<DdlFile | null>(null);
  const [dbms, setDbms] = useState(DBMS.includes(project.dbms_type.toUpperCase()) ? project.dbms_type.toUpperCase() : 'ORACLE');
  const [result, setResult] = useState<{ parsed: ParsedDdl; preview: DdlPreview[] } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ tables: number; relationships: number; errors: string[]; unregistered: string[] } | null>(null);

  useEffect(() => {
    if (source !== 'file' || files) return;
    api.erdDdlFiles(session.id).then((fs) => {
      setFiles(fs);
      if (seedFile) {
        const hit = fs.find((f) => f.path === seedFile || `${f.project_name}/${f.path}` === seedFile);
        if (hit) setFile(hit);
      }
    }).catch((e) => setError(e.message));
  }, [source, files, session.id, seedFile]);
  // 파일을 고르면 바로 파싱
  useEffect(() => { if (file) parse(); }, [file, dbms]); // eslint-disable-line react-hooks/exhaustive-deps

  const parse = async () => {
    setBusy(true); setError(null); setResult(null); setDone(null);
    try {
      const r = await api.erdParseDdl(session.id, { ...(source === 'file' && file ? { file: { worktree_id: file.worktree_id, path: file.path } } : { ddl: text }), dbms: dbms.toLowerCase(), project: project.id });
      setResult(r);
      setPicked(new Set(r.preview.filter((p) => p.status !== 'same').map((p) => p.physical_name)));
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  const apply = async () => {
    if (!result) return;
    const tables = result.parsed.tables.filter((t) => picked.has(t.physical_name.toUpperCase()) || picked.has(t.physical_name));
    if (!tables.length) return;
    const changed = result.preview.filter((p) => p.status === 'changed' && picked.has(p.physical_name)).length;
    if (!confirm(`ERD ${project.name}에 테이블 ${tables.length}개를 반영할까요?${changed ? `\n바뀐 테이블 ${changed}개는 컬럼을 덮어씁니다.` : ''}\n팀이 같이 쓰는 ERD입니다.`)) return;
    setBusy(true); setError(null);
    try {
      const names = new Set(tables.map((t) => t.physical_name.toUpperCase()));
      const rels = result.parsed.relationships.filter((r) => names.has(r.to_table_name.toUpperCase()));
      const r = await api.erdApplyDdl(project.id, { tables, relationships: rels });
      const unregistered = [...new Set(result.preview.filter((p) => names.has(p.physical_name.toUpperCase())).flatMap((p) => p.violations.filter((v) => v.verdict === 'unregistered_term' || v.verdict === 'unknown_word').map((v) => v.name)))];
      setDone({ tables: tables.length, relationships: r.relationships_created, errors: r.relationship_errors, unregistered });
      onApplied(r.project);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  // 미등록 이름마다 판정으로 초안을 만들어 등록 요청(요청 탭에서 고쳐 승인)
  const makeRequests = async () => {
    if (!done) return;
    setBusy(true);
    let made = 0;
    try {
      for (const name of done.unregistered) {
        const r = (await api.dictSearch(session.id, name, 1)).resolution;
        if (!r) continue;
        if (r.draft) {
          await api.addDictRequest(session.id, { kind: 'term', reason: `DDL 가져오기 · ${name}`, payload: { logical_name: r.draft.logical_name, physical_name: r.draft.physical_name, physical_abbr_name: r.draft.physical_abbr_name, domain_name: null, description: '' } });
          made++;
        } else {
          for (const tok of r.missing) { await api.addDictRequest(session.id, { kind: 'word', reason: `DDL 가져오기 · ${name}의 ${tok}`, payload: { name: '', english_name: tok, abbreviation: tok, definition: '' } }); made++; }
        }
      }
      setDone({ ...done, unregistered: [] });
      setError(made ? null : '만들 요청이 없습니다.');
      if (made) alert(`등록 요청 ${made}건을 만들었습니다. 용어 화면의 요청 탭에서 고쳐 승인하세요.`);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  return (
    <>
      <div className="dialog-head"><h1 id="ddl-title">DDL 가져오기</h1><span className="muted small">ERD {project.name}</span></div>
      <div className="row">
        <div className="seg" role="group" aria-label="가져올 곳">
          <button className={`chip-btn${source === 'paste' ? ' on' : ''}`} onClick={() => { setSource('paste'); setResult(null); }}>붙여넣기</button>
          <button className={`chip-btn${source === 'file' ? ' on' : ''}`} onClick={() => { setSource('file'); setResult(null); }}>워크트리 파일에서</button>
        </div>
        <label className="row small">DBMS <select value={dbms} onChange={(e) => setDbms(e.target.value)}>{DBMS.map((d) => <option key={d}>{d}</option>)}</select></label>
      </div>
      {source === 'paste' ? (
        <textarea className="mono erd-ddl-text" rows={10} placeholder={'CREATE TABLE TB_REFUND (\n  RFND_ID NUMBER(12) PRIMARY KEY,\n  ...\n);'} value={text} onChange={(e) => setText(e.target.value)} aria-label="DDL" />
      ) : (
        <select value={file ? `${file.worktree_id}:${file.path}` : ''} onChange={(e) => setFile(files?.find((f) => `${f.worktree_id}:${f.path}` === e.target.value) ?? null)} aria-label="DDL 파일">
          <option value="">{files ? (files.length ? `CREATE TABLE이 있는 파일 ${files.length}개` : 'CREATE TABLE이 있는 .sql·.xml 파일이 없습니다') : '파일 찾는 중'}</option>
          {files?.map((f) => <option key={`${f.worktree_id}:${f.path}`} value={`${f.worktree_id}:${f.path}`}>{f.project_name}/{f.path}</option>)}
        </select>
      )}
      {source === 'paste' && <div className="row"><button disabled={busy || !text.trim()} onClick={parse}>{busy && !result ? '파싱 중' : '미리보기'}</button></div>}
      {error && <p className="banner error" role="alert">{error}</p>}
      {result && (
        <div className="table-wrap"><table className="dict-table">
          <thead><tr><th /><th>테이블</th><th>상태</th><th>컬럼</th><th>판정</th></tr></thead>
          <tbody>{result.preview.map((p) => (
            <tr key={p.physical_name}>
              <td><input type="checkbox" aria-label={`${p.physical_name} 반영`} checked={picked.has(p.physical_name)} onChange={() => setPicked((s) => { const n = new Set(s); if (n.has(p.physical_name)) n.delete(p.physical_name); else n.add(p.physical_name); return n; })} /></td>
              <td><span className="mono">{p.physical_name}</span>{p.logical_name && p.logical_name !== p.physical_name && <> <span className="muted small">{p.logical_name}</span></>}</td>
              <td><span className={`pill ${STATUS[p.status][1]}`}>{STATUS[p.status][0]}</span></td>
              <td className="small">{p.status === 'new' ? p.columns : p.status === 'changed' ? `+${p.added_columns} / 바뀜 ${p.changed_columns}` : p.columns}</td>
              <td className="small">{p.violations.length ? p.violations.map((v) => <span key={v.name} className={`pill ${v.verdict === 'variant' ? 'err' : 'warn'}`} title={v.standard ? `표준 ${v.standard}` : ''}>{v.name}</span>) : <span className="muted">-</span>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {result && result.parsed.relationships.length > 0 && <p className="muted small">외래키 {result.parsed.relationships.length}개는 고른 테이블에 걸린 것만 관계로 만듭니다.</p>}
      {done && (
        <div className="banner">
          테이블 {done.tables}개를 반영했습니다{done.relationships ? `, 관계 ${done.relationships}개를 만들었습니다` : ''}.
          {done.errors.length > 0 && <> 관계 {done.errors.length}개는 못 만들었습니다: {done.errors.join(' · ')}</>}
          {done.unregistered.length > 0 && <> 사전에 없는 컬럼 {done.unregistered.length}개 <button className="small-btn" disabled={busy} onClick={makeRequests}>등록 요청 만들기</button></>}
        </div>
      )}
      <div className="dialog-actions">
        <button onClick={onClose}>{done ? '닫기' : '취소'}</button>
        {!done && <button className="primary" disabled={busy || !result || picked.size === 0} onClick={apply}>{busy && result ? '반영 중' : `반영 (${picked.size}개)`}</button>}
      </div>
    </>
  );
}

function ExportPane({ project, selectedId, onClose }: { project: ErdProject; selectedId: string | null; onClose: () => void }) {
  const [dbms, setDbms] = useState(GEN_DBMS.includes(project.dbms_type.toUpperCase()) ? project.dbms_type.toUpperCase() : 'ORACLE');
  const [opts, setOpts] = useState({ comments: true, foreign_keys: true, drop_first: false });
  const [scope, setScope] = useState<'all' | 'selected'>(selectedId ? 'selected' : 'all');
  const [ddl, setDdl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    api.erdExportDdl(project.id, { dbms, ...opts, table_ids: scope === 'selected' && selectedId ? [selectedId] : undefined })
      .then((r) => { setDdl(r.ddl); setError(null); }).catch((e) => setError(e.message));
  }, [project.id, dbms, opts, scope, selectedId]);
  const sel = selectedId ? project.tables.find((t) => t.id === selectedId) : undefined;
  const check = (k: keyof typeof opts, label: string) => <label className="row small"><input type="checkbox" checked={opts[k]} onChange={(e) => setOpts({ ...opts, [k]: e.target.checked })} /> {label}</label>;
  return (
    <>
      <div className="dialog-head"><h1 id="ddl-title">DDL 내보내기</h1><span className="muted small">ERD {project.name}</span></div>
      <div className="row">
        <label className="row small">DBMS <select value={dbms} onChange={(e) => setDbms(e.target.value)}>{GEN_DBMS.map((d) => <option key={d}>{d}</option>)}</select></label>
        {check('comments', 'COMMENT')}{check('foreign_keys', 'FK')}{check('drop_first', 'DROP 먼저')}
        <span className="spacer" />
        <div className="seg" role="group" aria-label="테이블 범위">
          <button className={`chip-btn${scope === 'all' ? ' on' : ''}`} onClick={() => setScope('all')}>전체 ({project.tables.length})</button>
          <button className={`chip-btn${scope === 'selected' ? ' on' : ''}`} disabled={!sel} onClick={() => setScope('selected')}>{sel ? `선택한 것 (${sel.physical_name})` : '선택한 것 없음'}</button>
        </div>
      </div>
      {error && <p className="banner error" role="alert">{error}</p>}
      <textarea className="mono erd-ddl-text" rows={18} readOnly value={ddl} aria-label="생성한 DDL" />
      <div className="dialog-actions">
        <button onClick={() => insertIntoPrompt(`ERD ${project.name}에서 만든 ${dbms} DDL이야. 소스의 DDL·마이그레이션과 맞춰줘.\n\`\`\`sql\n${ddl}\n\`\`\``)} disabled={!ddl}>프롬프트에 넣기</button>
        <button onClick={() => navigator.clipboard.writeText(ddl).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })} disabled={!ddl}>{copied ? '복사함' : '복사'}</button>
        <button className="primary" onClick={onClose}>닫기</button>
      </div>
    </>
  );
}
