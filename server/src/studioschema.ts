import { db } from './db.js';
import { createRelationships, erdApi, erdProject, type ErdProject, type RelationshipByName } from './erdvibe.js';

/**
 * 이 도구 자체의 SQLite(studio.db) 테이블 문서. erd-vibe ERD로 동기화할 때 논리명·설명의 원본이다.
 * 구조(컬럼·타입·PK·NOT NULL·UNIQUE·기본값·FK)는 실행 중인 DB를 PRAGMA로 읽으므로 여기에는 적지 않는다.
 * 테이블·컬럼을 더하면 여기에도 적는다. 문서에 없는 테이블은 동기화하지 않는다(다른 브랜치가 같은 studio.db에 만든 표가 ERD에 섞이지 않게).
 * 문서에 없는 컬럼은 미리보기에 '문서 없음'으로 나오고 논리명은 물리명으로 들어간다.
 */
type ColDoc = string | [logical: string, description: string];
type TableDoc = { group: string; logical: string; description: string; columns?: Record<string, ColDoc>; skip?: boolean };

/** 여러 테이블에 같은 뜻으로 나오는 컬럼. 테이블 문서의 columns가 우선한다. */
const COMMON: Record<string, ColDoc> = {
  created_at: '생성일시', updated_at: '수정일시', session_id: '세션 ID', project_id: '프로젝트 ID', workspace_id: '워크스페이스 ID',
  worktree_id: '워크트리 ID', chat_id: ['대화 ID', '0이면 메인 대화'], account_id: '테스트 계정 ID', status: '상태', closed: '닫힘 여부',
  unread: '안 읽음 여부', claude_session_id: 'Claude 세션 ID', title: '제목', note: '메모', reason: '사유', error: '오류 메시지',
  name: '이름', deleted: ['삭제 여부', '닫은 세션이 가리키는 동안 지우지 않고 숨긴다'], summary: '요약',
};

export const STUDIO_TABLE_DOCS: Record<string, TableDoc> = {
  // 프로젝트
  projects: {
    group: '프로젝트', logical: '프로젝트', description: '등록한 앱(저장소 또는 모노레포 안의 앱 폴더)과 실행 설정',
    columns: {
      local_path: ['로컬 경로', '앱 폴더 절대 경로'], kind: ['종류', 'fe, be, unknown 등'], start_cmd: '실행 명령', check_cmd: '검사 명령',
      health_path: '상태 확인 경로', port_env: ['포트 환경변수', '포트를 넣을 환경변수 이름'], api_env_key: ['API 주소 환경변수', 'FE가 BE 주소를 받는 환경변수 이름'],
      baseline_url: ['기준 서버 주소', '예전 화면 전후 비교용(쓰지 않음)'], login_path: ['로그인 경로', '미리보기 캡처 로그인용'],
      setup_cmd: ['설치 명령', '새 워크트리 첫 실행 전 의존성 설치'], port_env_checked: '포트 설정 확인 여부', commit_template: '커밋 템플릿 경로',
      erd_project_id: ['ERD 프로젝트 ID', '예전 열(워크스페이스로 옮김)'], repo_root: ['저장소 루트', 'git 저장소 루트 경로'],
      subdir: ['하위 폴더', '저장소 루트에서 앱 폴더까지 상대 경로'], app_url: ['접속 주소 틀', '비우면 http://localhost:{port}'],
      copy_files: ['복사 파일', '클론에서 워크트리로 복사할 파일(JSON 배열)'], docker_stacks: ['도커 스택', '서버 실행 전에 띄울 compose 파일과 서비스(JSON)'],
    },
  },
  workspaces: {
    group: '프로젝트', logical: '워크스페이스', description: '함께 작업하는 프로젝트 묶음',
    columns: { jira_project: 'Jira 프로젝트 키', erd_project_id: ['ERD 프로젝트 ID', '용어 검사에 쓰는 erd-vibe ERD'] },
  },
  workspace_projects: { group: '프로젝트', logical: '워크스페이스 프로젝트', description: '워크스페이스에 속한 프로젝트와 순서', columns: { position: '순서' } },
  db_connections: {
    group: '프로젝트', logical: 'DB 연결', description: '프로젝트별 DB 연결 설정. 서버 실행 시 env_map대로 환경변수를 만든다',
    columns: {
      engine: 'DB 엔진', host: '호스트', port: '포트', database: '데이터베이스', username: '사용자', password: ['비밀번호', '암호화해 저장'],
      env_map: ['환경변수 매핑', 'JSON'], enabled: '사용 여부',
    },
  },
  // 세션·대화
  sessions: {
    group: '세션·대화', logical: '세션', description: '티켓 하나의 작업 단위. 메인 대화 상태를 같이 가진다',
    columns: { ticket: '티켓', primary_worktree_id: '대표 워크트리 ID', stale_notified: '방치 알림 여부' },
  },
  worktrees: {
    group: '세션·대화', logical: '워크트리', description: '세션이 프로젝트마다 쓰는 git 워크트리',
    columns: {
      path: '경로', branch: '브랜치', base_branch: '기준 브랜치', setup_done: '설치 완료 여부', port: ['포트', '세션에서 이 앱에 잡아 둔 포트'],
      in_place: ['원본 폴더 사용 여부', '1이면 워크트리 없이 원본 클론 폴더를 쓴다'],
    },
  },
  chats: {
    group: '세션·대화', logical: '추가 대화', description: '한 세션 안에서 메인 대화와 따로 돌리는 대화',
    columns: { db_connection_id: ['DB 연결 ID', 'DB 대화일 때 질의할 연결'] },
  },
  messages: { group: '세션·대화', logical: '메시지', description: '대화 기록', columns: { kind: '종류', payload: ['내용', 'JSON'] } },
  prompt_queue: {
    group: '세션·대화', logical: '프롬프트 대기열', description: 'Claude가 작업 중일 때 보낸 프롬프트',
    columns: { text: '내용', images: ['이미지', '파일 이름 JSON 배열'], plan: '계획 모드 여부' },
  },
  session_tasks: { group: '세션·대화', logical: '세션 작업 목록', description: '세션 화면 위에 보이는 작업 목록', columns: { tasks: ['작업', 'JSON 배열'] } },
  // 실행
  servers: {
    group: '실행', logical: '개발 서버', description: '워크트리마다 띄운 개발 서버',
    columns: { port: '포트', pid: '프로세스 ID', started_at: '시작일시' },
  },
  env_profiles: { group: '실행', logical: '환경값 프로필', description: '프로젝트별 환경변수 묶음', columns: { is_default: '기본 여부' } },
  env_vars: {
    group: '실행', logical: '환경변수', description: '프로필에 속한 환경변수',
    columns: {
      profile_id: '프로필 ID', key: '변수명', value: ['값', '비밀값은 암호화'], required: '필수 여부', secret: '비밀 여부',
      source: ['출처', 'manual, scan 등'], found_in: '발견 위치',
    },
  },
  session_env: {
    group: '실행', logical: '세션 환경값', description: '세션이 프로젝트마다 고른 프로필과 덮어쓴 값',
    columns: { profile_id: '프로필 ID', overrides: ['덮어쓴 값', 'JSON'] },
  },
  test_accounts: {
    group: '실행', logical: '테스트 계정', description: '화면 확인에 쓰는 로그인 계정. 워크스페이스가 비면 공용',
    columns: { login: '로그인 ID', password: ['비밀번호', '암호화해 저장'], session_id: '배정 세션 ID', assigned_at: '배정일시' },
  },
  // 확인·PR
  screen_checks: {
    group: '확인·PR', logical: '영향 화면', description: '세션 변경이 영향을 주는 화면과 캡처 결과',
    columns: {
      route: '경로', before_file: '변경 전 캡처', after_file: '변경 후 캡처', diff_file: '차이 이미지', diff_ratio: '차이 비율',
      boxes: ['차이 영역', 'JSON'], captured_at: '캡처일시', kind: ['영향 종류', 'direct, indirect'], also_routes: ['같은 화면 경로', 'JSON 배열'],
      manual: '직접 추가 여부',
    },
  },
  test_cases: {
    group: '확인·PR', logical: '화면 테스트', description: '세션의 화면 테스트 시나리오와 결과',
    columns: {
      role: '역할', start_path: '시작 경로', steps: ['단계', 'JSON 배열'], expected: ['기대 결과', 'JSON 배열'],
      results: ['실행 결과', 'JSON 배열'], shots: ['스크린샷', 'JSON 배열'], ran_at: '실행일시',
    },
  },
  pull_requests: {
    group: '확인·PR', logical: 'PR', description: '세션이 만든 GitHub PR',
    columns: {
      number: 'PR 번호', url: 'PR 주소', state: ['PR 상태', 'OPEN, MERGED, CLOSED'], checked_at: '확인일시',
      mergeable: ['머지 가능 여부', 'MERGEABLE, CONFLICTING, UNKNOWN'],
    },
  },
  // 쿼리·사전
  query_stats: {
    group: '쿼리·사전', logical: '쿼리 통계', description: '서버 로그에서 센 쿼리 모양별 집계',
    columns: {
      key: '쿼리 키', shape: '쿼리 모양', mapper: '매퍼 위치', calls: '호출 수', rows_total: '행 합계', rows_max: '최대 행 수', rows_n: '행 수 집계 수',
      ms_total: '시간 합계(ms)', ms_max: '최대 시간(ms)', ms_n: '시간 집계 수', last_rows: '마지막 행 수', same_rows: '행 수 같음 여부',
      warnings: ['경고', 'JSON 배열'], muted: '숨김 여부', first_at: '처음 본 시각', last_at: '마지막 본 시각', logger: '로거',
    },
  },
  dict_requests: {
    group: '쿼리·사전', logical: '사전 요청', description: 'Claude·사용자가 낸 단어·용어·ERD 변경 요청(승인 대기)',
    columns: { kind: '요청 종류', payload: ['요청 내용', 'JSON'], source: ['요청자', 'user, claude'], resolved_at: '처리일시' },
  },
  dict_ignores2: {
    group: '쿼리·사전', logical: '용어 검사 예외', description: '용어 검사에서 무시하는 컬럼 이름(테이블·위반 종류로 좁힐 수 있음)',
    columns: { tbl: ['테이블', '빈 값이면 전부'], name: '컬럼 이름', issue: ['위반 종류', '빈 값이면 전부'] },
  },
  dict_excludes: { group: '쿼리·사전', logical: '용어 검사 제외 경로', description: '용어 검사에서 빼는 파일 경로 패턴', columns: { pattern: '경로 패턴' } },
  dict_baseline2: {
    group: '쿼리·사전', logical: '용어 위반 기준선', description: '기존 위반을 정리 대상으로 모아 둔 목록',
    columns: { tbl: '테이블', name: '컬럼 이름', issue: '위반 종류', count: '건수', first_seen: '처음 본 일시', resolved_at: '해결일시' },
  },
  schema_ignores: { group: '쿼리·사전', logical: '스키마 검사 예외', description: '스키마 검사에서 무시하는 항목', columns: { key: '항목 키' } },
  // 기타
  settings: { group: '기타', logical: '설정', description: '도구 설정(키별 JSON)', columns: { key: '설정 키', value: ['설정 값', 'JSON'] } },
  usage_log: {
    group: '기타', logical: '사용량 기록', description: 'Claude 호출의 토큰·비용. 세션이 정리돼도 남긴다',
    columns: {
      purpose: '호출 목적', cwd: '작업 폴더', input_tokens: '입력 토큰', output_tokens: '출력 토큰', cache_read_tokens: '캐시 읽기 토큰',
      cache_write_tokens: '캐시 쓰기 토큰', cost_usd: '비용(USD)', models: ['모델별 사용량', 'JSON'], cumulative: ['누적값', 'SDK가 준 누적값 JSON'],
      num_turns: '턴 수', duration_ms: '소요 시간(ms)', is_error: '오류 여부', carried: '이어받음 여부',
    },
  },
  // 새 표로 옮긴 뒤 남은 예전 표
  dict_ignores: { group: '쿼리·사전', logical: '용어 검사 예외(예전)', description: 'dict_ignores2로 옮김', skip: true },
  dict_baseline: { group: '쿼리·사전', logical: '용어 위반 기준선(예전)', description: 'dict_baseline2로 옮김', skip: true },
};

export type StudioColumn = {
  physical_name: string; logical_name: string; description: string; data_type: string;
  is_primary_key: boolean; is_nullable: boolean; is_unique: boolean; default_value: string; documented: boolean;
};
export type StudioTable = { physical_name: string; logical_name: string; description: string; columns: StudioColumn[] };
/** skipped: DB에는 있지만 테이블 문서에 없어 동기화하지 않는 테이블 */
export type StudioSchema = { tables: StudioTable[]; relationships: RelationshipByName[]; skipped: string[] };

const docOf = (d: ColDoc | undefined): [string, string] | null => (d === undefined ? null : typeof d === 'string' ? [d, ''] : d);

/** 실행 중인 studio.db의 테이블·컬럼·FK를 읽어 테이블 문서와 합친다. 예전 표·sqlite 내부 표·문서에 없는 표는 뺀다. */
export function readStudioSchema(): StudioSchema {
  const all = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[])
    .map((r) => r.name).filter((n) => !STUDIO_TABLE_DOCS[n]?.skip);
  const names = all.filter((n) => STUDIO_TABLE_DOCS[n]);
  const synced = new Set(names);
  const tables: StudioTable[] = [];
  const relationships: RelationshipByName[] = [];
  for (const name of names) {
    const doc = STUDIO_TABLE_DOCS[name];
    const info = db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }[];
    // 한 컬럼짜리 UNIQUE 제약만 컬럼에 표시한다(여러 컬럼 UNIQUE는 ERD 컬럼 속성으로 나타낼 수 없다).
    const unique = new Set<string>();
    for (const ix of db.prepare(`PRAGMA index_list("${name}")`).all() as { name: string; unique: number; origin: string }[]) {
      if (!ix.unique || ix.origin === 'pk') continue;
      const cols = db.prepare(`PRAGMA index_info("${ix.name}")`).all() as { name: string }[];
      if (cols.length === 1) unique.add(cols[0].name);
    }
    const label = doc.logical;
    tables.push({
      physical_name: name,
      logical_name: label,
      description: `[${doc.group}] ${doc.description}`,
      columns: info.map((c) => {
        const d = c.name === 'id' && c.pk ? [`${label} ID`, ''] as [string, string] : docOf(doc.columns?.[c.name] ?? COMMON[c.name]);
        return {
          physical_name: c.name, logical_name: d?.[0] ?? c.name, description: d?.[1] ?? '', data_type: c.type || 'TEXT',
          is_primary_key: c.pk > 0, is_nullable: !(c.notnull || c.pk), is_unique: unique.has(c.name), default_value: c.dflt_value ?? '',
          documented: Boolean(d),
        };
      }),
    });
    for (const fk of db.prepare(`PRAGMA foreign_key_list("${name}")`).all() as { table: string; from: string; to: string | null }[]) {
      if (synced.has(fk.table)) relationships.push({ from_table_name: fk.table, from_column_name: fk.to ?? 'id', to_table_name: name, to_column_name: fk.from, relationship_type: 'one_to_many' });
    }
  }
  return { tables, relationships, skipped: all.filter((n) => !synced.has(n)) };
}

export type StudioDiffTable = {
  physical_name: string; logical_name: string; status: 'new' | 'changed' | 'same';
  table_changes: string[]; added_columns: string[]; changed_columns: string[]; undocumented_columns: string[];
};
export type StudioDiff = {
  erd: { id: string; name: string; dbms_type: string };
  tables: StudioDiffTable[];
  relationships_to_add: number;
  erd_only_tables: string[];
  erd_only_columns: string[];
  skipped_tables: string[];
};

const same = (a: unknown, b: unknown) => (a ?? '') === (b ?? '');

/** studio.db와 ERD를 맞대 본다. 비교 기준은 erdApi.syncTables와 같다(테이블·컬럼은 물리명, 바뀐 칸만). */
export async function diffStudioErd(pid: string, force = true): Promise<StudioDiff> {
  const schema = readStudioSchema();
  const erd = await erdProject(pid, force);
  const byName = new Map(erd.tables.map((t) => [t.physical_name, t]));
  const tables = schema.tables.map((t): StudioDiffTable => {
    const ex = byName.get(t.physical_name);
    const undocumented_columns = t.columns.filter((c) => !c.documented).map((c) => c.physical_name);
    const base = { physical_name: t.physical_name, logical_name: t.logical_name, undocumented_columns };
    if (!ex) return { ...base, status: 'new', table_changes: [], added_columns: t.columns.map((c) => c.physical_name), changed_columns: [] };
    const table_changes = (['logical_name', 'description'] as const).filter((k) => !same(t[k], ex[k]));
    const cols = new Map(ex.columns.map((c) => [c.physical_name, c]));
    const added_columns: string[] = [], changed_columns: string[] = [];
    for (const c of t.columns) {
      const e = cols.get(c.physical_name);
      if (!e) { added_columns.push(c.physical_name); continue; }
      const keys = ['logical_name', 'data_type', 'is_primary_key', 'is_nullable', 'is_unique', 'default_value', 'description'] as const;
      if (keys.some((k) => !same(c[k], e[k]))) changed_columns.push(c.physical_name);
    }
    const status = table_changes.length || added_columns.length || changed_columns.length ? 'changed' : 'same';
    return { ...base, status, table_changes, added_columns, changed_columns };
  });
  const studioNames = new Set(schema.tables.map((t) => t.physical_name));
  const erd_only_tables = erd.tables.filter((t) => !studioNames.has(t.physical_name)).map((t) => t.physical_name).sort();
  const erd_only_columns = schema.tables.flatMap((t) => {
    const ex = byName.get(t.physical_name);
    const have = new Set(t.columns.map((c) => c.physical_name));
    return (ex?.columns ?? []).filter((c) => !have.has(c.physical_name)).map((c) => `${t.physical_name}.${c.physical_name}`);
  });
  const relationships_to_add = schema.relationships.filter((r) => !relationshipExists(erd, r)).length;
  const order = { new: 0, changed: 1, same: 2 };
  return {
    erd: { id: erd.id, name: erd.name, dbms_type: erd.dbms_type },
    tables: tables.sort((a, b) => order[a.status] - order[b.status] || a.physical_name.localeCompare(b.physical_name)),
    relationships_to_add, erd_only_tables, erd_only_columns, skipped_tables: schema.skipped,
  };
}

function relationshipExists(erd: ErdProject, r: RelationshipByName) {
  const from = erd.tables.find((t) => t.physical_name === r.from_table_name);
  const to = erd.tables.find((t) => t.physical_name === r.to_table_name);
  const fc = from?.columns.find((c) => c.physical_name === r.from_column_name);
  const tc = to?.columns.find((c) => c.physical_name === r.to_column_name);
  return Boolean(fc && tc && erd.relationships.some((x) => x.from_column_id === fc.id && x.to_column_id === tc.id));
}

/** 테이블·컬럼을 추가·갱신하고 FK 관계를 만든다. ERD에만 있는 것은 지우지 않는다. */
export async function applyStudioErd(pid: string) {
  const schema = readStudioSchema();
  const { summary } = await erdApi.syncTables(pid, schema.tables.map((t) => ({
    physical_name: t.physical_name, logical_name: t.logical_name, description: t.description,
    columns: t.columns.map(({ documented: _, ...c }) => c),
  })));
  const rel = await createRelationships(pid, schema.relationships);
  return { tables: summary.tables, columns: summary.columns, relationships_created: rel.created, relationship_errors: rel.errors };
}
