import { format } from 'sql-formatter';
import type { ExplainResult } from './types';

/**
 * 쿼리 감시 화면에서 SQL을 줄 맞춰 보여 주고, 실행 계획을 읽기 쉽게 풀어 준다.
 * 계획 풀이는 규칙 기반이다(Oracle DBMS_XPLAN 표, PostgreSQL EXPLAIN 글, MySQL EXPLAIN 표, SQL Server SHOWPLAN_TEXT).
 */

const LANG: Record<string, 'plsql' | 'postgresql' | 'mysql' | 'mariadb' | 'transactsql'> = {
  oracle: 'plsql', postgres: 'postgresql', mysql: 'mysql', mariadb: 'mariadb', mssql: 'transactsql',
};

/** 줄바꿈·들여쓰기. 모양의 IN (…)은 포매터가 모르는 글자라 잠시 이름으로 바꿨다가 되돌린다. 못 읽으면 그대로 둔다. */
export function prettySql(sql: string, engine?: string): string {
  try {
    return format(sql.replace(/…/g, '__STUDIO_ELLIPSIS__'), {
      language: LANG[engine ?? 'oracle'] ?? 'plsql', keywordCase: 'upper', tabWidth: 2, paramTypes: { positional: true },
    }).replace(/__STUDIO_ELLIPSIS__/g, '…');
  } catch {
    return sql;
  }
}

export type PlanLevel = 'bad' | 'warn' | 'info' | 'ok';
export type PlanStep = { id: string; depth: number; op: string; name: string; rows: string; cost: string; desc: string; preds: string[]; level?: PlanLevel };
export type PlanFinding = { level: PlanLevel; text: string };
export type PlanInsight = { steps: PlanStep[]; findings: PlanFinding[] };

/** 테이블이 이보다 크면 전체 읽기를 문제로 본다. 작은 코드 테이블은 전체 읽기가 더 빠르다. */
const BIG_TABLE = 10_000;

const ORACLE_OPS: [RegExp, string][] = [
  [/^TABLE ACCESS (STORAGE )?FULL/, '테이블 전체를 처음부터 끝까지 읽습니다.'],
  [/^TABLE ACCESS BY (GLOBAL |LOCAL )?INDEX ROWID/, '인덱스로 찾은 행 위치(ROWID)로 테이블 행을 가져옵니다.'],
  [/^TABLE ACCESS BY USER ROWID/, 'ROWID로 행 하나를 바로 가져옵니다.'],
  [/^INDEX UNIQUE SCAN/, '유니크 인덱스로 한 행만 찾습니다(가장 빠른 방식).'],
  [/^INDEX RANGE SCAN DESCENDING/, '인덱스를 거꾸로 범위 탐색합니다(ORDER BY DESC를 인덱스로 처리).'],
  [/^INDEX RANGE SCAN/, '인덱스에서 조건에 맞는 범위만 읽습니다.'],
  [/^INDEX SKIP SCAN/, '인덱스 첫 컬럼 조건 없이 다음 컬럼으로 건너뛰며 찾습니다. 첫 컬럼 값 종류가 많으면 느립니다.'],
  [/^INDEX FAST FULL SCAN/, '인덱스 전체를 순서 없이 빠르게 읽습니다(테이블 대신 인덱스만 읽음).'],
  [/^INDEX FULL SCAN/, '인덱스 전체를 순서대로 읽습니다.'],
  [/^NESTED LOOPS (ANTI|SEMI)/, '바깥 행마다 안쪽을 찾아 있는지/없는지만 봅니다(EXISTS/NOT EXISTS).'],
  [/^NESTED LOOPS/, '바깥 행마다 안쪽 테이블을 찾아 붙입니다. 바깥 행이 적고 안쪽이 인덱스로 찾을 때 좋습니다.'],
  [/^HASH JOIN (RIGHT )?(ANTI|SEMI)/, '해시 표를 만들어 있는지/없는지만 봅니다(EXISTS/NOT EXISTS).'],
  [/^HASH JOIN (RIGHT )?OUTER/, '한쪽으로 해시 표를 만들어 외부 조인합니다.'],
  [/^HASH JOIN/, '한쪽으로 해시 표를 만들어 다른 쪽과 맞춥니다. 큰 테이블끼리 조인할 때 씁니다.'],
  [/^MERGE JOIN CARTESIAN/, '조인 조건 없이 모든 행을 곱합니다(카테시안 곱).'],
  [/^MERGE JOIN/, '양쪽을 정렬한 뒤 맞춰 붙입니다.'],
  [/^SORT ORDER BY STOPKEY/, '정렬하면서 앞쪽 몇 행만 남깁니다(페이징·FETCH FIRST).'],
  [/^SORT ORDER BY/, 'ORDER BY 정렬.'],
  [/^SORT GROUP BY/, '정렬해서 GROUP BY.'],
  [/^SORT AGGREGATE/, '집계 함수(COUNT, SUM 등)로 한 행을 만듭니다.'],
  [/^SORT UNIQUE/, '정렬해서 중복을 없앱니다(DISTINCT, UNION).'],
  [/^HASH GROUP BY/, '해시로 GROUP BY.'],
  [/^HASH UNIQUE/, '해시로 중복을 없앱니다(DISTINCT).'],
  [/^COUNT STOPKEY/, 'ROWNUM 조건으로 정해진 행 수에서 멈춥니다.'],
  [/^WINDOW/, '분석 함수(ROW_NUMBER, OVER 등)를 계산합니다.'],
  [/^FILTER/, '조건으로 거릅니다. 아래에 서브쿼리가 있으면 바깥 행마다 다시 실행될 수 있습니다.'],
  [/^VIEW/, '서브쿼리·인라인 뷰 결과를 한 덩어리로 다룹니다.'],
  [/^UNION-ALL/, '결과를 이어 붙입니다.'],
  [/^BUFFER SORT/, '안쪽 결과를 메모리에 담아 되풀이해 씁니다.'],
  [/^SELECT STATEMENT/, '질의 결과.'],
  [/^(UPDATE|DELETE|INSERT) STATEMENT/, '데이터 변경.'],
];

const describe = (op: string) => ORACLE_OPS.find(([re]) => re.test(op))?.[1] ?? '';
const num = (s: string) => {
  const m = s.trim().match(/^([\d.]+)\s*([KMG])?/);
  if (!m) return NaN;
  return Number(m[1]) * ({ K: 1e3, M: 1e6, G: 1e9 } as Record<string, number>)[m[2] ?? ''] || Number(m[1]);
};
const fmt = (n: number) => (Number.isFinite(n) ? n.toLocaleString() : '?');
/** 조건에서 컬럼에 함수를 씌운 곳(인덱스를 못 타게 한다) */
const FN_ON_COLUMN = /\b(TO_CHAR|TO_DATE|TO_NUMBER|UPPER|LOWER|TRUNC|SUBSTR|NVL|COALESCE|RPAD|LPAD|REPLACE|TRIM|INTERNAL_FUNCTION)\s*\(\s*"?[A-Z_][\w$#".]*"?\s*[,)]/i;
/** 함수를 씌운 컬럼 이름(보여 주기용). INTERNAL_FUNCTION은 Oracle이 형변환을 넣은 것이다. */
function fnColumn(preds: string[]): string | null {
  const m = preds.join(' ').match(/\b(TO_CHAR|TO_DATE|TO_NUMBER|UPPER|LOWER|TRUNC|SUBSTR|NVL|COALESCE|RPAD|LPAD|REPLACE|TRIM)\s*\(\s*(?:INTERNAL_FUNCTION\s*\(\s*)?("?[A-Z_][\w$#".]*"?)/i);
  return m ? `${m[1]}(${m[2].replace(/"/g, '')})` : null;
}

function tableRows(plan: ExplainResult, name: string): number | null {
  const t = plan.tables.find((x) => x.name.toUpperCase().split('.').pop() === name.toUpperCase().split('.').pop());
  return t?.rows ?? null;
}

/** 조건에 나온 컬럼이 첫 컬럼인 인덱스. 있는데 전체 읽기를 했다면 함수·형변환을 의심한다. */
function unusedIndex(plan: ExplainResult, table: string, preds: string[]): string | null {
  const t = plan.tables.find((x) => x.name.toUpperCase().split('.').pop() === table.toUpperCase());
  if (!t) return null;
  const cols = new Set([...preds.join(' ').matchAll(/"([A-Z_][A-Z0-9_$#]*)"/g)].map((m) => m[1]));
  const idx = t.indexes.find((i) => cols.has(i.columns.split(',')[0].trim().toUpperCase()));
  return idx ? `${idx.name}(${idx.columns})` : null;
}

function oracle(plan: ExplainResult, actualRows: number | null): PlanInsight | null {
  const lines = plan.plan.split('\n');
  const head = lines.findIndex((l) => /^\|\s*Id\s*\|/.test(l));
  if (head < 0) return null;
  const cols = lines[head].split('|').slice(1, -1).map((c) => c.trim());
  const at = (name: RegExp) => cols.findIndex((c) => name.test(c));
  const [cId, cOp, cName, cRows, cCost] = [at(/^Id$/), at(/^Operation$/), at(/^Name$/), at(/^Rows$/), at(/^Cost/)];
  const steps: PlanStep[] = [];
  for (const l of lines.slice(head + 1)) {
    if (!l.startsWith('|')) { if (steps.length) break; continue; }
    if (/^\|-+/.test(l) || /^-+$/.test(l)) continue;
    const cells = l.split('|').slice(1, -1);
    if (cells.length !== cols.length) continue;
    const opRaw = cells[cOp] ?? '';
    const op = opRaw.trim();
    const depth = (opRaw.match(/^ */)?.[0].length ?? 1) - 1;
    steps.push({ id: (cells[cId] ?? '').replace('*', '').trim(), depth, op, name: (cells[cName] ?? '').trim(), rows: (cells[cRows] ?? '').trim(), cost: (cells[cCost] ?? '').trim().replace(/\s*\(\d+\)$/, ''), desc: describe(op), preds: [] });
  }
  if (!steps.length) return null;
  // Predicate Information: "   2 - filter(...)", 이어지는 줄은 더 들여쓴다.
  const pi = lines.findIndex((l) => /^Predicate Information/.test(l));
  if (pi >= 0) {
    let cur: PlanStep | undefined;
    for (const l of lines.slice(pi + 2)) {
      if (/^\S/.test(l) && !/^\s*\d+ - /.test(l)) break;
      const m = l.match(/^\s*(\d+) - (.*)$/);
      if (m) { cur = steps.find((s) => s.id === m[1]); cur?.preds.push(m[2].trim()); }
      else if (cur && l.trim()) cur.preds[cur.preds.length - 1] += ` ${l.trim()}`;
    }
  }

  // 단계의 하위 범위(자기 뒤로 깊이가 더 깊은 단계들)
  const subtree = (i: number) => {
    let j = i + 1;
    while (j < steps.length && steps[j].depth > steps[i].depth) j++;
    return steps.slice(i, j);
  };
  // FILTER의 두 번째 자식부터는 바깥 행마다 다시 실행하는 서브쿼리다.
  const perRow = new Set<PlanStep>();
  steps.forEach((s, i) => {
    if (!/^FILTER/.test(s.op)) return;
    const kids = subtree(i).slice(1).filter((k) => k.depth === s.depth + 1);
    for (const k of kids.slice(1)) subtree(steps.indexOf(k)).forEach((x) => perRow.add(x));
  });

  const findings: PlanFinding[] = [];
  for (const s of steps) {
    if (/^TABLE ACCESS (STORAGE )?FULL/.test(s.op)) {
      const n = tableRows(plan, s.name);
      const fn = s.preds.some((p) => FN_ON_COLUMN.test(p));
      const fnCol = fnColumn(s.preds);
      const idx = unusedIndex(plan, s.name, s.preds);
      if (perRow.has(s)) {
        s.level = n !== null && n < BIG_TABLE ? 'warn' : 'bad';
        findings.push({ level: s.level, text: `서브쿼리 안에서 ${s.name}${n !== null ? `(약 ${fmt(n)}행)` : ''}을(를) 전체 읽습니다. 바깥 행마다 다시 실행되므로 바깥 행 수만큼 반복됩니다.${fnCol ? ` 조건의 ${fnCol}처럼 컬럼에 함수를 씌우면 인덱스를 못 탑니다. 컬럼 쪽은 그대로 두고 비교 값을 바꾸세요(예: 날짜 범위 비교).` : idx ? ` 인덱스 ${idx}가 있는데 쓰지 않았습니다.` : ' 서브쿼리 조건 컬럼에 인덱스를 검토하세요.'}` });
        continue;
      }
      if (n !== null && n < BIG_TABLE) {
        findings.push({ level: 'info', text: `${s.name}(약 ${fmt(n)}행)은 작은 테이블이라 전체 읽기가 자연스럽습니다.` });
        continue;
      }
      s.level = 'bad';
      const why = fn ? `조건 컬럼에 함수를 씌워(${fnCol ?? '함수'}) 인덱스를 못 탑니다` : idx ? `인덱스 ${idx}가 있는데 쓰지 않았습니다(형변환·함수·낮은 선택도를 확인하세요)` : '조건에 맞는 인덱스가 없습니다';
      findings.push({ level: 'bad', text: `${s.name}을(를) 전체 읽습니다${n !== null ? `(테이블 약 ${fmt(n)}행)` : ''}. ${why}.${s.preds.length ? ` 조건: ${s.preds.join(' / ')}` : ''}` });
    }
    if (/^MERGE JOIN CARTESIAN/.test(s.op)) { s.level = 'bad'; findings.push({ level: 'bad', text: `id ${s.id}: 조인 조건이 빠져 카테시안 곱이 됩니다. JOIN ON 조건을 확인하세요.` }); }
    if (/^INDEX SKIP SCAN/.test(s.op)) { s.level = 'warn'; findings.push({ level: 'warn', text: `${s.name}을(를) SKIP SCAN 합니다. 인덱스 첫 컬럼 조건을 넣거나 컬럼 순서가 맞는 인덱스를 검토하세요.` }); }
    if (/^FILTER/.test(s.op)) {
      const kids = subtree(steps.indexOf(s)).slice(1).filter((k) => k.depth === s.depth + 1);
      if (kids.length > 1) {
        s.level = 'warn';
        const outer = kids[0];
        findings.push({ level: 'warn', text: `id ${s.id} FILTER: ${outer.name || outer.op}(예상 ${outer.rows || '?'}행)의 행마다 서브쿼리 ${kids.length - 1}개(id ${kids.slice(1).map((k) => k.id).join(', ')})를 다시 실행합니다. 쿼리의 EXISTS/NOT EXISTS가 이렇게 풀렸습니다. 바깥 행이 많아지면 느려지므로, 조인(세미/안티 조인)으로 풀리게 바꾸거나 서브쿼리가 인덱스로만 읽게 하세요.` });
      }
    }
  }
  // 가장 비싼 단계(전체 비용 대비)
  const total = num(steps[0].cost);
  const costly = steps.slice(1).filter((s) => !/^(SORT AGGREGATE|VIEW|COUNT|SELECT)/.test(s.op))
    .map((s) => ({ s, c: num(s.cost) })).filter((x) => Number.isFinite(x.c)).sort((a, b) => b.c - a.c)
    .find((x) => !steps.some((k) => k.depth > x.s.depth && steps.indexOf(k) > steps.indexOf(x.s) && num(k.cost) === x.c));
  if (costly && Number.isFinite(total) && total > 0) {
    findings.push({ level: 'info', text: `비용이 가장 큰 단계: id ${costly.s.id} ${costly.s.op}${costly.s.name ? ` ${costly.s.name}` : ''} (cost ${fmt(costly.c)}, 전체 ${fmt(total)}의 ${Math.round((costly.c / total) * 100)}%).` });
  }
  // 예상 행 수와 실제(로그의 결과 행 수)가 크게 다르면 통계가 오래됐을 수 있다.
  const est = num(steps[0].rows || steps[1]?.rows || '');
  if (actualRows !== null && Number.isFinite(est) && actualRows > 100 && (est * 10 < actualRows || est > actualRows * 10)) {
    findings.push({ level: 'warn', text: `옵티마이저 예상 ${fmt(est)}행인데 실제로는 ${fmt(actualRows)}행이 나왔습니다. 테이블 통계가 오래돼 계획이 틀렸을 수 있습니다(DBMS_STATS 수집 확인).` });
  }
  if (!findings.some((f) => f.level === 'bad' || f.level === 'warn')) {
    findings.unshift({ level: 'ok', text: steps.some((s) => /^INDEX/.test(s.op)) ? '큰 문제는 보이지 않습니다. 인덱스로 필요한 행만 읽습니다.' : '큰 문제는 보이지 않습니다.' });
  }
  return { steps, findings };
}

function postgres(plan: ExplainResult): PlanInsight {
  const steps: PlanStep[] = [];
  const findings: PlanFinding[] = [];
  const PG_OPS: [RegExp, string][] = [
    [/^Seq Scan/, '테이블 전체를 읽습니다.'], [/^Index Only Scan/, '인덱스만 읽고 테이블은 읽지 않습니다.'], [/^Index Scan/, '인덱스로 찾은 행을 읽습니다.'],
    [/^Bitmap Heap Scan/, '비트맵으로 모은 행 위치로 테이블을 읽습니다.'], [/^Bitmap Index Scan/, '인덱스로 행 위치 비트맵을 만듭니다.'],
    [/^Nested Loop/, '바깥 행마다 안쪽을 찾아 붙입니다.'], [/^Hash Join/, '해시 표로 조인합니다.'], [/^Merge Join/, '정렬해서 맞춰 붙입니다.'],
    [/^Hash$/, '조인용 해시 표를 만듭니다.'], [/^Sort/, '정렬.'], [/^Aggregate|^HashAggregate|^GroupAggregate/, '집계.'], [/^Limit/, '앞쪽 몇 행만 남깁니다.'], [/^SubPlan/, '바깥 행마다 다시 실행하는 서브쿼리.'],
  ];
  let id = 0;
  for (const l of plan.plan.split('\n')) {
    const m = l.match(/^(\s*)(?:->\s*)?([A-Z][A-Za-z ]*?)(?: using (\S+))?(?: on (\S+)(?: \w+)?)?\s+\(cost=[\d.]+\.\.([\d.]+) rows=(\d+)/);
    if (m) {
      const op = m[2].trim();
      steps.push({ id: String(id++), depth: Math.floor(m[1].length / 2), op: m[3] ? `${op} using ${m[3]}` : op, name: m[4] ?? '', rows: m[6], cost: m[5], desc: PG_OPS.find(([re]) => re.test(op))?.[1] ?? '', preds: [] });
      continue;
    }
    const p = l.match(/^\s*(Filter|Index Cond|Hash Cond|Join Filter|Recheck Cond|Sort Key):\s*(.*)$/);
    if (p && steps.length) steps[steps.length - 1].preds.push(`${p[1]}: ${p[2]}`);
  }
  for (const s of steps) {
    if (s.op.startsWith('Seq Scan')) {
      const n = tableRows(plan, s.name);
      if (n !== null && n < BIG_TABLE) { findings.push({ level: 'info', text: `${s.name}(약 ${fmt(n)}행)은 작은 테이블이라 전체 읽기가 자연스럽습니다.` }); continue; }
      s.level = 'bad';
      const fn = s.preds.some((p) => FN_ON_COLUMN.test(p.replace(/::\w+/g, '')));
      findings.push({ level: 'bad', text: `${s.name}을(를) 전체 읽습니다${n !== null ? `(약 ${fmt(n)}행)` : ''}. ${fn ? '조건 컬럼에 함수를 씌워 인덱스를 못 탑니다' : '조건에 맞는 인덱스가 없거나 선택도가 낮습니다'}.${s.preds.length ? ` ${s.preds.join(' / ')}` : ''}` });
    }
  }
  if (/SubPlan/.test(plan.plan)) findings.push({ level: 'warn', text: 'SubPlan이 있습니다. 바깥 행마다 서브쿼리를 다시 실행합니다. JOIN으로 바꿀 수 있는지 보세요.' });
  if (!findings.some((f) => f.level === 'bad' || f.level === 'warn')) findings.unshift({ level: 'ok', text: '큰 문제는 보이지 않습니다.' });
  return { steps, findings };
}

function mysql(plan: ExplainResult): PlanInsight {
  const lines = plan.plan.split('\n').map((l) => l.split('|').map((c) => c.trim()));
  const [head, ...rows] = lines;
  const col = (n: string) => head.indexOf(n);
  const findings: PlanFinding[] = [];
  for (const r of rows) {
    const table = r[col('table')];
    const type = r[col('type')];
    const extra = r[col('Extra')] ?? '';
    const n = Number(r[col('rows')]);
    if (type === 'ALL' && !(n < BIG_TABLE)) findings.push({ level: 'bad', text: `${table}을(를) 전체 읽습니다(예상 ${fmt(n)}행). 조건에 맞는 인덱스가 없거나 쓰지 못했습니다${r[col('possible_keys')] && r[col('possible_keys')] !== 'NULL' ? `(후보 인덱스: ${r[col('possible_keys')]})` : ''}.` });
    if (type === 'index') findings.push({ level: 'warn', text: `${table}의 인덱스 전체를 읽습니다(${r[col('key')]}).` });
    if (/Using filesort/.test(extra)) findings.push({ level: 'warn', text: `${table}: ORDER BY를 인덱스로 못 하고 따로 정렬합니다(Using filesort).` });
    if (/Using temporary/.test(extra)) findings.push({ level: 'warn', text: `${table}: 임시 테이블을 만듭니다(GROUP BY·DISTINCT).` });
  }
  if (!findings.length) findings.push({ level: 'ok', text: '큰 문제는 보이지 않습니다.' });
  return { steps: [], findings };
}

function mssql(plan: ExplainResult): PlanInsight {
  const findings: PlanFinding[] = [];
  for (const m of plan.plan.matchAll(/\b(Table Scan|Clustered Index Scan|Index Scan)\(OBJECT:\(([^)]*)\)/g)) {
    findings.push({ level: m[1] === 'Index Scan' ? 'warn' : 'bad', text: `${m[2]}: ${m[1]} — ${m[1] === 'Table Scan' ? '테이블 전체를 읽습니다' : '인덱스 전체를 읽습니다(Seek가 아님)'}.` });
  }
  if (/Nested Loops/.test(plan.plan) && findings.length) findings.push({ level: 'info', text: 'Nested Loops 안쪽에서 Scan이 반복되면 바깥 행 수만큼 다시 읽습니다.' });
  if (!findings.length) findings.push({ level: 'ok', text: '큰 문제는 보이지 않습니다(Seek로 읽습니다).' });
  return { steps: [], findings };
}

/** actualRows: 로그에서 본 결과 행 수(최대). 예상 행 수와 비교한다. */
export function planInsight(plan: ExplainResult, actualRows: number | null): PlanInsight {
  try {
    if (plan.engine === 'oracle') return oracle(plan, actualRows) ?? { steps: [], findings: [] };
    if (plan.engine === 'postgres') return postgres(plan);
    if (plan.engine === 'mysql' || plan.engine === 'mariadb') return mysql(plan);
    if (plan.engine === 'mssql') return mssql(plan);
  } catch { /* 풀이 없이 원본만 보여 준다 */ }
  return { steps: [], findings: [] };
}
