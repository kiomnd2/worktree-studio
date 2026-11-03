import { Fragment, useEffect, useMemo, useState } from 'react';
import type { ErdFinding, ErdProject, ErdTable, ErdView } from '../../types';
import { colType } from './TableNode';
import { ISSUE_LABEL } from './Inspector';

/** ERD 표 보기. 테이블 한 줄씩, ▸로 컬럼을 펼친다. 편집은 오른쪽 Inspector에서 한다. */
type SortKey = 'physical_name' | 'logical_name' | 'columns' | 'bad' | 'rels';
const isBad = (f?: ErdFinding) => Boolean(f?.issues.some((i) => i !== 'no_term_link'));

export default function TableList({ project, view, findingsByTable, needle, onlyBad, selected, expandId, onSelect, onClearFilters }: {
  project: ErdProject; view: ErdView; findingsByTable: Map<string, Map<string, ErdFinding>>; needle: string; onlyBad: boolean;
  selected: string | null; expandId: { id: string; n: number } | null; onSelect: (id: string | null) => void; onClearFilters: () => void;
}) {
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: 'physical_name', asc: true });
  const [open, setOpen] = useState<Set<string>>(new Set());

  const rels = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of project.relationships) {
      m.set(r.from_table_id, (m.get(r.from_table_id) ?? 0) + 1);
      if (r.to_table_id !== r.from_table_id) m.set(r.to_table_id, (m.get(r.to_table_id) ?? 0) + 1);
    }
    return m;
  }, [project]);
  const badOf = (t: ErdTable) => [...(findingsByTable.get(t.physical_name.toUpperCase())?.values() ?? [])].filter((f) => isBad(f)).length;

  const rows = useMemo(() => {
    const hit = (s: string | null | undefined) => (s ?? '').toUpperCase().includes(needle);
    const list = project.tables.filter((t) => (!onlyBad || badOf(t) > 0)
      && (!needle || hit(t.physical_name) || hit(t.logical_name) || t.columns.some((c) => hit(c.physical_name) || hit(c.logical_name))));
    const val = (t: ErdTable): string | number => sort.key === 'physical_name' ? t.physical_name : sort.key === 'logical_name' ? t.logical_name
      : sort.key === 'columns' ? t.columns.length : sort.key === 'bad' ? badOf(t) : rels.get(t.id) ?? 0;
    return list.sort((a, b) => {
      const x = val(a), y = val(b);
      const d = typeof x === 'number' ? x - (y as number) : x.localeCompare(y as string);
      return (sort.asc ? d : -d) || a.physical_name.localeCompare(b.physical_name);
    });
  }, [project, needle, onlyBad, sort, rels, findingsByTable]); // eslint-disable-line react-hooks/exhaustive-deps

  // 다른 곳(위반 목록·차이 패널·ERD에서 보기)에서 고른 테이블은 펼치고 보이게 한다.
  useEffect(() => {
    if (!expandId) return;
    setOpen((o) => new Set(o).add(expandId.id));
    setTimeout(() => document.getElementById(`erd-row-${expandId.id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 30);
  }, [expandId]);

  const toggle = (id: string) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const head = (key: SortKey, label: string, num = false) => (
    <th className={num ? 'num' : ''} aria-sort={sort.key === key ? (sort.asc ? 'ascending' : 'descending') : 'none'}>
      <button className="erd-list-sort" onClick={() => setSort((s) => ({ key, asc: s.key === key ? !s.asc : !num }))}>
        {label}{sort.key === key ? (sort.asc ? ' ▲' : ' ▼') : ''}
      </button>
    </th>
  );

  return (
    <div className="erd-list">
      <p className="muted small erd-list-count">{project.tables.length}개 중 {rows.length}개</p>
      {rows.length === 0 ? (
        <div className="erd-empty">
          <p>조건에 맞는 테이블이 없습니다.</p>
          <button onClick={onClearFilters}>찾기·위반만 풀기</button>
        </div>
      ) : (
        <table className="erd-list-table">
          <thead>
            <tr><th className="erd-list-toggle" />{head('physical_name', '물리명')}{head('logical_name', '논리명')}{head('columns', '컬럼', true)}{head('bad', '위반', true)}{head('rels', '관계', true)}<th>설명</th></tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const findings = findingsByTable.get(t.physical_name.toUpperCase());
              const bad = badOf(t);
              const isOpen = open.has(t.id);
              return (
                <Fragment key={t.id}>
                  <tr id={`erd-row-${t.id}`} className={`clickable${selected === t.id ? ' on' : ''}`} onClick={() => onSelect(selected === t.id ? null : t.id)}>
                    <td className="erd-list-toggle">
                      <button className="small-btn" aria-expanded={isOpen} aria-label={isOpen ? '컬럼 접기' : '컬럼 펼치기'} onClick={(e) => { e.stopPropagation(); toggle(t.id); }}>{isOpen ? '▾' : '▸'}</button>
                    </td>
                    <td className="mono">{t.physical_name}</td>
                    <td>{t.logical_name}</td>
                    <td className="num">{t.columns.length}</td>
                    <td className={`num${bad ? ' bad' : ''}`}>{bad || ''}</td>
                    <td className="num">{rels.get(t.id) ?? ''}</td>
                    <td className="muted erd-list-desc" title={t.description ?? ''}>{t.description}</td>
                  </tr>
                  {isOpen && (
                    <tr className="erd-list-sub">
                      <td />
                      <td colSpan={6}>
                        {t.columns.length === 0 ? <p className="muted small">컬럼 없음</p> : (
                          <table className="erd-list-cols">
                            <thead><tr><th>PK</th><th>물리명</th><th>논리명</th><th>타입</th><th>NULL</th><th>용어</th><th>위반</th></tr></thead>
                            <tbody>
                              {[...t.columns].sort((a, b) => a.order_index - b.order_index).map((c) => {
                                const f = findings?.get(c.physical_name.toUpperCase());
                                const term = c.term_dictionary_id ? view.terms[c.term_dictionary_id] : undefined;
                                return (
                                  <tr key={c.id} className={isBad(f) ? 'bad' : ''}>
                                    <td>{c.is_primary_key ? '🔑' : ''}</td>
                                    <td className="mono">{c.physical_name}</td>
                                    <td>{c.logical_name}</td>
                                    <td className="mono">{colType(c)}</td>
                                    <td>{c.is_nullable ? 'Y' : 'N'}</td>
                                    <td>{term ? term.logical_name : <span className="muted">연결 없음</span>}</td>
                                    <td>{f && isBad(f) ? `⚠ ${f.issues.filter((i) => i !== 'no_term_link').map((i) => ISSUE_LABEL[i] ?? i).join(', ')}` : ''}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
