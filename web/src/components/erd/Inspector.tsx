import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import { insertIntoPrompt } from '../../events';
import type { ColumnEdit, DictSearch, ErdFinding, ErdProject, ErdTable, ErdView, Session } from '../../types';
import { colType } from './TableNode';

/**
 * 선택한 테이블의 속성 패널. 이름·색·컬럼 표를 고쳐 "저장"을 눌러야 erd-vibe에 반영된다(순서 포함).
 * 저장 전에 다른 사람이 같은 테이블을 고쳤으면 서버가 409를 주고, 덮어쓸지 다시 받을지 묻는다.
 */

type Row = ColumnEdit & { key: string };
const COLORS: [string, string][] = [['', '기본'], ['#3446C4', '파랑'], ['#0D7A68', '초록'], ['#8A4413', '갈색'], ['#8E1F1F', '빨강'], ['#6B3FA0', '보라'], ['#586274', '회색']];
export const ISSUE_LABEL: Record<string, string> = { variant: '비표준 표기', unregistered_term: '미등록 용어', unknown_word: '미등록 단어', domain_mismatch: '도메인 불일치', not_in_erd: 'ERD에 없음', no_term_link: '용어 연결 없음' };
let seq = 0;
const toRows = (t: ErdTable): Row[] => [...t.columns].sort((a, b) => a.order_index - b.order_index).map((c) => ({
  key: c.id, id: c.id, physical_name: c.physical_name, logical_name: c.logical_name, data_type: colType(c), is_primary_key: c.is_primary_key,
  is_nullable: c.is_nullable, is_unique: c.is_unique, default_value: c.default_value ?? '', description: c.description ?? '', term_dictionary_id: c.term_dictionary_id,
}));
const squash = (v: string) => v.replace(/\s+/g, '');
/** 표준으로 맞출 때 실제로 바뀌는 것. 이름이 이미 표준이면 타입이나 용어 연결만 바뀐다. */
function fixOf(r: Row, f: ErdFinding): { label: string; renames: boolean } | null {
  const t = f.resolution.term;
  if (!t) return null;
  const renames = t.standard !== r.physical_name;
  const retypes = Boolean(t.domain_type) && squash(t.domain_type!).toUpperCase() !== squash(r.data_type).toUpperCase();
  if (renames) return { label: '표준 이름으로 바꾸기', renames };
  if (retypes) return { label: '표준 타입으로 맞추기', renames };
  if (r.term_dictionary_id !== t.id) return { label: '용어 연결', renames };
  return null;
}
const sameRows = (a: Row[], b: Row[]) => JSON.stringify(a.map(({ key: _k, ...r }) => r)) === JSON.stringify(b.map(({ key: _k, ...r }) => r));

export default function Inspector({ session, project, view, table, findings, ownTouched, onSaved, onReload, onDeleted }: {
  session: Session; project: ErdProject; view: ErdView; table: ErdTable; findings: Map<string, ErdFinding>;
  /** 이 화면에서 방금 옮긴 테이블이면 true. 그 때문에 바뀐 updated_at은 충돌로 보지 않는다. */
  ownTouched: (tableId: string) => boolean;
  onSaved: (p: ErdProject) => void; onReload: () => void; onDeleted: (p: ErdProject) => void;
}) {
  const [head, setHead] = useState({ physical_name: table.physical_name, logical_name: table.logical_name, description: table.description ?? '', header_color: table.header_color ?? '' });
  const [rows, setRows] = useState<Row[]>(() => toRows(table));
  const [base, setBase] = useState(table.updated_at);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [termQ, setTermQ] = useState<string | null>(null);
  const original = useRef(table);
  const dirty = head.physical_name !== table.physical_name || head.logical_name !== table.logical_name || head.description !== (table.description ?? '')
    || head.header_color !== (table.header_color ?? '') || !sameRows(rows, toRows(table));

  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  // 받은 테이블이 바뀌면: 고친 것이 없으면 새 값으로, 고치는 중이면 그대로 두고 충돌은 저장 때 본다.
  useEffect(() => {
    const prev = original.current;
    original.current = table;
    if (prev.id !== table.id || !dirtyRef.current) {
      setHead({ physical_name: table.physical_name, logical_name: table.logical_name, description: table.description ?? '', header_color: table.header_color ?? '' });
      setRows(toRows(table)); setBase(table.updated_at); setError(null);
    } else if (ownTouched(table.id)) setBase(table.updated_at);
  }, [table]); // eslint-disable-line react-hooks/exhaustive-deps

  const setRow = (key: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const move = (i: number, d: -1 | 1) => setRows((rs) => { const n = [...rs]; const j = i + d; if (j < 0 || j >= n.length) return rs; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const addBlank = () => setRows((rs) => [...rs, { key: `new-${++seq}`, physical_name: '', logical_name: '', data_type: 'VARCHAR2(100)', is_primary_key: false, is_nullable: true }]);
  const addTerm = (t: DictSearch['terms'][number]) => {
    setRows((rs) => [...rs, { key: `new-${++seq}`, physical_name: t.standard, logical_name: t.logical_name, data_type: t.domain_type ?? 'VARCHAR2(100)', is_primary_key: false, is_nullable: true, term_dictionary_id: t.id }]);
    setTermQ(null);
  };

  const save = async (override?: Row[], force = false) => {
    const list = override ?? rows;
    const names = list.map((r) => r.physical_name.trim().toUpperCase());
    const bad = names.find((n) => !/^[A-Z][A-Z0-9_]*$/.test(n));
    if (bad !== undefined) { setError(`컬럼 물리명은 영문·숫자·밑줄만 씁니다: ${bad || '(빈 이름)'}`); return; }
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) { setError(`같은 테이블에 ${dup} 컬럼이 둘 있습니다.`); return; }
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(head.physical_name.trim())) { setError('테이블 물리명은 영문·숫자·밑줄만 씁니다.'); return; }
    if (list.some((r) => !r.data_type.trim())) { setError('타입이 빈 컬럼이 있습니다.'); return; }
    setBusy(true); setError(null);
    const kept = new Set(list.map((r) => r.id).filter(Boolean));
    try {
      const res = await api.erdSaveTable(project.id, table.id, {
        table: { physical_name: head.physical_name.trim().toUpperCase(), logical_name: head.logical_name.trim(), description: head.description, header_color: head.header_color || undefined },
        columns: list.map(({ key: _k, ...r }) => ({ ...r, physical_name: r.physical_name.trim().toUpperCase(), data_type: r.data_type.trim().toUpperCase() })),
        deleted_columns: table.columns.filter((c) => !kept.has(c.id)).map((c) => c.id),
        seen_updated_at: base, force,
      });
      onSaved(res.project);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        if (confirm(`${(e as Error).message}\n\n확인: 내 내용으로 덮어쓰기 · 취소: 다시 받기(고친 내용은 버림)`)) { setBusy(false); return save(list, true); }
        dirtyRef.current = false; onReload();
      } else setError((e as Error).message);
    }
    setBusy(false);
  };
  const remove = async () => {
    const rels = project.relationships.filter((r) => r.from_table_id === table.id || r.to_table_id === table.id).length;
    if (!confirm(`${table.physical_name} 테이블을 erd-vibe에서 지울까요?${rels ? `\n이 테이블에 걸린 관계 ${rels}개도 함께 지워집니다.` : ''}`)) return;
    setBusy(true);
    try { onDeleted((await api.erdDeleteTable(project.id, table.id)).project); } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  // 위반 컬럼을 표준(물리명·타입·용어 연결)으로 바꿔 바로 저장
  const toStandard = (r: Row, f: ErdFinding) => {
    const t = f.resolution.term;
    if (!t) return;
    const next = rows.map((x) => (x.key === r.key ? { ...x, physical_name: t.standard, data_type: t.domain_type ?? x.data_type, term_dictionary_id: t.id } : x));
    setRows(next);
    save(next);
  };
  const sourcePrompt = (r: Row, f: ErdFinding) => insertIntoPrompt(
    `ERD ${table.physical_name}.${r.physical_name} 컬럼을 표준 이름 ${f.resolution.term?.standard ?? '(사전 확인)'}${f.resolution.term?.domain_type ? `, 타입 ${f.resolution.term.domain_type}` : ''}(으)로 바꿨어. 소스(매퍼 SQL·resultMap, DDL, Liquibase, JPA @Column)에서 ${r.physical_name}을(를) 쓰는 곳을 찾아 같이 바꿔줘. dict_lookup으로 확인하고 진행해.`);

  return (
    <aside className="erd-inspector" aria-label={`${table.physical_name} 속성`}>
      <div className="block-head"><h2 className="mono">{table.physical_name} <span className="muted small">속성</span></h2></div>
      <div className="grid2">
        <label className="field"><span>물리명</span><input className="mono" value={head.physical_name} onChange={(e) => setHead({ ...head, physical_name: e.target.value.toUpperCase() })} /></label>
        <label className="field"><span>논리명</span><input value={head.logical_name} onChange={(e) => setHead({ ...head, logical_name: e.target.value })} /></label>
        <label className="field"><span>색</span>
          <select value={head.header_color} onChange={(e) => setHead({ ...head, header_color: e.target.value })}>
            {COLORS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            {head.header_color && !COLORS.some(([v]) => v === head.header_color) && <option value={head.header_color}>지정 색 {head.header_color}</option>}
          </select>
        </label>
        <label className="field"><span>설명</span><input value={head.description} onChange={(e) => setHead({ ...head, description: e.target.value })} /></label>
      </div>
      <div className="block-head">
        <h3>컬럼 <span className="muted small">{rows.length}</span></h3>
        <div className="row">
          <button className="small-btn" onClick={() => setTermQ(termQ === null ? '' : null)}>＋ 용어로 컬럼 추가</button>
          <button className="small-btn" onClick={addBlank}>＋ 직접</button>
        </div>
      </div>
      {termQ !== null && <TermPicker session={session} q={termQ} onQ={setTermQ} onPick={addTerm} />}
      <div className="erd-cols-wrap"><table className="erd-cols">
        <colgroup><col style={{ width: 24 }} /><col /><col style={{ width: 132 }} /><col style={{ width: 30 }} /><col style={{ width: 30 }} /><col style={{ width: 30 }} /></colgroup>
        <thead><tr><th aria-label="순서" /><th>물리명 · 논리명</th><th>타입</th><th>PK</th><th>NN</th><th aria-label="삭제" /></tr></thead>
        <tbody>
          {rows.map((r, i) => {
            const f = r.id ? findings.get(table.columns.find((c) => c.id === r.id)?.physical_name.toUpperCase() ?? '') : undefined;
            const term = r.term_dictionary_id ? view.terms[r.term_dictionary_id] : undefined;
            // 용어 이름이 컬럼 논리명과 같으면 줄을 따로 쓰지 않고 물리명 칸의 표시로만 보인다.
            const termDiffers = term && squash(term.logical_name) !== squash(r.logical_name);
            const fix = f ? fixOf(r, f) : null;
            const t = f?.resolution.term;
            return (
              <Fragment key={r.key}>
                <tr className={f?.issues.some((x) => x !== 'no_term_link') ? 'bad' : f ? 'nolink' : ''}>
                  <td className="erd-order">
                    <button className="icon" aria-label="위로" disabled={i === 0} onClick={() => move(i, -1)}>▲</button>
                    <button className="icon" aria-label="아래로" disabled={i === rows.length - 1} onClick={() => move(i, 1)}>▼</button>
                  </td>
                  <td><div className="erd-namecell">
                    <div className={`erd-physical${term ? ' linked' : ''}`}>
                      <input className="mono" aria-label="물리명" value={r.physical_name} onChange={(e) => setRow(r.key, { physical_name: e.target.value.toUpperCase() })} />
                      {term && <span className="erd-termmark" title={`연결한 용어: ${term.logical_name} (${term.standard})`}>용어</span>}
                    </div>
                    <input aria-label="논리명" value={r.logical_name} onChange={(e) => setRow(r.key, { logical_name: e.target.value })} />
                    {termDiffers && <span className="muted small" title="연결한 용어">용어 {term.logical_name}</span>}
                  </div></td>
                  <td><input className="mono" aria-label="타입" value={r.data_type} onChange={(e) => setRow(r.key, { data_type: e.target.value.toUpperCase() })} /></td>
                  <td><input type="checkbox" aria-label="PK" checked={r.is_primary_key} onChange={(e) => setRow(r.key, { is_primary_key: e.target.checked, is_nullable: e.target.checked ? false : r.is_nullable })} /></td>
                  <td><input type="checkbox" aria-label="NOT NULL" checked={!r.is_nullable} onChange={(e) => setRow(r.key, { is_nullable: !e.target.checked })} /></td>
                  <td><button className="icon danger" aria-label="컬럼 삭제" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>✕</button></td>
                </tr>
                {f && (
                  <tr className={`erd-hint ${f.issues.some((x) => x !== 'no_term_link') ? 'bad' : 'nolink'}`}><td />
                    <td colSpan={5} className="small">
                      <div>
                        <b>{f.issues.map((x) => ISSUE_LABEL[x] ?? x).join(', ')}</b>
                        {t && <> · 표준 <code>{t.standard}</code> {[t.logical_name, t.domain_name && t.domain_name !== t.logical_name ? t.domain_name : null, t.domain_type].filter(Boolean).join(' · ')}</>}
                      </div>
                      {fix && (
                        <div className="erd-hint-actions">
                          <button className="small-btn" disabled={busy} title="표준 이름·타입·용어 연결로 맞추고 바로 저장합니다" onClick={() => toStandard(r, f)}>{fix.label}</button>
                          {fix.renames && <button className="small-btn" onClick={() => sourcePrompt(r, f)}>소스도 바꾸게 프롬프트에 넣기</button>}
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table></div>
      {error && <p className="banner error" role="alert">{error}</p>}
      <div className="row">
        <button className="danger" disabled={busy} onClick={remove}>테이블 삭제</button>
        <span className="spacer" />
        {dirty && <button disabled={busy} onClick={() => { setHead({ physical_name: table.physical_name, logical_name: table.logical_name, description: table.description ?? '', header_color: table.header_color ?? '' }); setRows(toRows(table)); setError(null); }}>되돌리기</button>}
        <button className="primary" disabled={busy || !dirty} onClick={() => save()}>{busy ? '저장 중' : '저장'}</button>
      </div>
    </aside>
  );
}

function TermPicker({ session, q, onQ, onPick }: { session: Session; q: string; onQ: (q: string) => void; onPick: (t: DictSearch['terms'][number]) => void }) {
  const [res, setRes] = useState<DictSearch | null>(null);
  useEffect(() => {
    const t = setTimeout(() => { api.dictSearch(session.id, q, 20).then(setRes).catch(() => setRes(null)); }, 250);
    return () => clearTimeout(t);
  }, [q, session.id]);
  const terms = useMemo(() => res?.terms ?? [], [res]);
  return (
    <div className="erd-termpick">
      <input autoFocus placeholder="용어 찾기(거래일자, TR_DT)" value={q} onChange={(e) => onQ(e.target.value)} aria-label="용어 찾기" />
      <ul>
        {terms.map((t) => (
          <li key={t.id}><button onClick={() => onPick(t)}><span className="mono"><b>{t.standard}</b></span> {t.logical_name} <span className="muted mono">{t.domain_type ?? ''}</span></button></li>
        ))}
        {res && terms.length === 0 && <li className="muted small">찾은 용어가 없습니다. 용어 화면의 사전 관리에서 먼저 등록하세요.</li>}
      </ul>
    </div>
  );
}
