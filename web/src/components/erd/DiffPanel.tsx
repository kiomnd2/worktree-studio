import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { insertIntoPrompt } from '../../events';
import type { ErdProject, SchemaDiff, Session } from '../../types';

/** 캔버스 아래 ERD ↔ 소스 DDL(.sql·Liquibase) 비교. 테이블 이름은 대소문자·스키마 접두어를 무시한다. */

const KIND: Record<SchemaDiff['kind'], [string, string]> = {
  source_only_table: ['소스에만', 'warn'], erd_only_table: ['ERD에만', ''], source_only_column: ['소스에만', 'warn'],
  erd_only_column: ['ERD에만', ''], type_mismatch: ['타입 다름', 'err'],
};

export default function DiffPanel({ session, project, onSelect, onImport, onClose }: {
  session: Session; project: ErdProject; onSelect: (table: string) => void; onImport: (file: string) => void; onClose: () => void;
}) {
  const [data, setData] = useState<{ source_tables: number; diffs: SchemaDiff[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setBusy(true);
    try { setData(await api.erdDiff(session.id)); setError(null); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }, [session.id]);
  useEffect(() => { load(); }, [load, project.updated_at]);

  const ddlPrompt = async (d: SchemaDiff) => {
    const t = project.tables.find((x) => x.physical_name.toUpperCase() === d.table.toUpperCase());
    if (!t) return;
    try {
      const { ddl } = await api.erdExportDdl(project.id, { table_ids: [t.id] });
      insertIntoPrompt(`ERD에는 있는데 소스 DDL에 없는 테이블 ${t.physical_name}(${t.logical_name})이야. 이 프로젝트의 DDL·마이그레이션 방식에 맞게 추가해줘.\n\`\`\`sql\n${ddl}\n\`\`\``);
    } catch (e) { setError((e as Error).message); }
  };
  const fixPrompt = (d: SchemaDiff) => insertIntoPrompt(d.kind === 'type_mismatch'
    ? `소스 ${d.file}:${d.line}의 ${d.table}.${d.column} 타입이 ${d.source_type}인데 ERD는 ${d.erd_type}이야. 어느 쪽이 맞는지 dict_lookup으로 도메인을 확인하고 맞춰줘.`
    : `ERD ${d.table}에 있는 ${d.column}(${d.erd_type ?? ''}) 컬럼이 소스 DDL에 없어. 소스 DDL·마이그레이션에 추가할지 확인하고 맞춰줘.`);

  const rows = data?.diffs ?? [];
  return (
    <section className="erd-diff" aria-label="소스와 비교">
      <div className="block-head">
        <h3>ERD ↔ 소스 DDL <span className="muted small">{data ? `소스에서 테이블 ${data.source_tables}개 찾음 · 차이 ${rows.length}` : ''}</span></h3>
        <div className="row">
          <button className="small-btn" disabled={busy} onClick={load}>{busy ? '비교 중' : '↻'}</button>
          <button className="small-btn" onClick={onClose} aria-label="닫기">✕</button>
        </div>
      </div>
      {error && <p className="banner error" role="alert">{error}</p>}
      {data && data.source_tables === 0 && <p className="muted small">워크트리에서 타입이 적힌 CREATE TABLE(.sql)이나 Liquibase createTable을 찾지 못했습니다.</p>}
      {data && data.source_tables > 0 && rows.length === 0 && <p className="muted small">ERD와 소스 DDL이 같습니다.</p>}
      {rows.length > 0 && (
        <div className="table-wrap"><table className="dict-table">
          <thead><tr><th>테이블.컬럼</th><th>차이</th><th>ERD</th><th>소스</th><th>할 일</th></tr></thead>
          <tbody>{rows.map((d, i) => (
            <tr key={i} className="clickable" onClick={() => onSelect(d.table)}>
              <td className="mono">{d.table}{d.column ? `.${d.column}` : ''}</td>
              <td><span className={`pill ${KIND[d.kind][1]}`}>{KIND[d.kind][0]}</span></td>
              <td className="mono small">{d.kind === 'erd_only_table' ? `${project.tables.find((t) => t.physical_name.toUpperCase() === d.table.toUpperCase())?.columns.length ?? 0} 컬럼` : d.erd_type ?? '-'}</td>
              <td className="mono small">{d.source_type ?? (d.columns ? `${d.columns.length} 컬럼` : '-')}{d.file ? ` · ${d.file}:${d.line}` : ''}</td>
              <td onClick={(e) => e.stopPropagation()}>
                {(d.kind === 'source_only_table' || d.kind === 'source_only_column') && d.file && <button className="small-btn" onClick={() => onImport(d.file!)}>ERD에 반영</button>}
                {d.kind === 'erd_only_table' && <button className="small-btn" onClick={() => ddlPrompt(d)}>DDL 만들어 프롬프트에 넣기</button>}
                {(d.kind === 'type_mismatch' || d.kind === 'erd_only_column') && <button className="small-btn" onClick={() => fixPrompt(d)}>프롬프트에 넣기</button>}
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </section>
  );
}
