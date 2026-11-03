/** erd-vibe 데이터 모양. erd-vibe API 응답을 이 모양으로 맞춰 쓴다. */

export type Word = { id: string; name: string; english_name: string; abbreviation: string | null; definition: string };
export type Domain = {
  id: string; name: string; description: string | null;
  data_type_default: string | null; data_type_oracle: string | null; data_type_mysql: string | null; data_type_postgresql: string | null;
  data_type_mariadb?: string | null; data_type_mssql?: string | null; data_type_sqlite?: string | null;
};
export type Term = { id: string; logical_name: string; physical_name: string; physical_abbr_name: string | null; domain_name: string | null; description: string };
export type Dictionary = { words: Word[]; terms: Term[]; domains: Domain[]; loaded_at: number };

export type ErdColumn = {
  id: string; table_id: string; logical_name: string; physical_name: string; data_type: string | null; data_length: string | number | null;
  is_primary_key: boolean; is_nullable: boolean; is_unique: boolean; default_value: string | null;
  description: string | null; order_index: number; term_dictionary_id: string | null;
};
export type ErdTable = {
  id: string; logical_name: string; physical_name: string; description: string | null;
  position_x: number; position_y: number; header_color: string | null; default_has_pk_auto_increment: boolean | null;
  updated_at: string | null; columns: ErdColumn[];
};
export type RelationshipType = 'one_to_one' | 'one_to_many' | 'many_to_many';
export type ErdRelationship = {
  id: string; from_table_id: string; from_column_id: string; to_table_id: string; to_column_id: string;
  relationship_type: RelationshipType; description: string | null;
};
export type ErdMemo = { id: string; content: string; position_x: number; position_y: number; width: number | null; height: number | null; background_color: string | null };
export type ErdProject = {
  id: string; name: string; description: string | null; dbms_type: string; updated_at: string | null;
  tables: ErdTable[]; relationships: ErdRelationship[]; memos: ErdMemo[];
};

/** ERD 프로젝트의 DBMS에 맞는 도메인 타입. 그 DBMS 칸이 비어 있으면 기본 타입. */
export function domainType(d: Domain, dbms: string): string | null {
  const key = `data_type_${dbms.toLowerCase()}` as keyof Domain;
  return ((d[key] as string | null | undefined) || d.data_type_default) ?? null;
}

/** ERD 컬럼 타입에 길이를 붙인 표기. VARCHAR + 100 → VARCHAR(100) */
export const columnType = (c: { data_type: string | null; data_length: string | number | null }) =>
  c.data_type ? (c.data_length && !c.data_type.includes('(') ? `${c.data_type}(${c.data_length})` : c.data_type) : null;
