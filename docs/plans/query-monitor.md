# 쿼리 감시 플랜

> 기능 계획서 v0.3 · 작성 2026-10-30 · 갱신 2026-11-19
> 상태: 1~3단계 구현 완료 (PR #6, 커밋 `650e3d3`)
> 원본: `docs/query-monitor-plan.html` (v0.2, 착수 전 시점)에서 옮김

**서버 로그로 쿼리를 감시하고 최적화까지 잇는 기능.**
띄운 BE 서버가 찍는 SQL 로그를 실시간으로 모아, 자주 불리거나 무겁거나 N+1로 반복되는 쿼리를 찾아 보여준다. 고를 때만 실행 계획을 받고, 고치는 일은 Claude가 제안하고 사용자가 승인한다.

## 1. 배경과 목표

지금은 화면이 느리면 로그 탭을 손으로 훑어 같은 쿼리가 몇 번 나왔는지 세고, SQL을 복사해 DB 도구에서 실행 계획을 따로 본다. 서버 로그와 DB 연결은 이미 이 도구 안에 있으니 그 사이를 잇는다.

### 착수 시점에 있던 재료

- `server/src/runner.ts`의 `pushLine`이 서버 출력을 한 줄씩 받아 비밀값을 가린 뒤 3000줄까지 들고 있다.
- `server/src/dbquery.ts`의 `runQuery`가 세션 DB에 읽기 질의를 롤백 트랜잭션으로 실행한다. `EXPLAIN`은 이미 읽기로 본다.
- `server/src/claude.ts`의 `db_query` 도구와 `server/src/approvals.ts`의 `dbwrite` 승인 카드가 있다.

### 빠져 있던 것

- 로그에서 SQL을 알아보는 코드가 없다. 로그는 3000줄에서 잘리므로 나중에 훑어서는 앞부분을 놓친다.
- Oracle과 MSSQL은 실행 계획을 받는 문장이 `isReadOnly`에 걸려 막힌다.
- Claude가 서버 로그나 쿼리 통계를 볼 도구가 없다.

### 목표

- 화면 하나를 눌렀을 때 어떤 쿼리가 몇 번, 몇 행씩 나갔는지 바로 보인다.
- 의심 쿼리를 골라 버튼 한 번으로 실행 계획과 인덱스 정보를 본다.
- 고칠 쿼리는 근거(통계, 계획, 매퍼 위치)를 붙여 Claude에게 넘기고, 수정과 DDL은 승인 뒤에만 반영된다.

## 2. 범위

### 하는 것

- MyBatis, Hibernate, p6spy 로그에서 SQL 추출
- 쿼리 모양별 집계와 규칙 기반 경고
- 집계를 SQLite에 보관 (도구를 다시 켜도 남음)
- RightPanel BE 서버 영역의 쿼리 탭
- 엔진별 실행 계획 조회 (Oracle 우선)
- Claude 최적화 요청 버튼과 조회 도구
- 매퍼 SQL 로그를 기본으로 켜는 환경값 넣기

### 하지 않는 것

- 자동 수정, 자동 인덱스 생성
- 운영 DB 감시
- DB 쪽 통계(`pg_stat_statements`, `V$SQL`) 수집 — 이후 검토
- Node ORM(Prisma, Sequelize 등) 로그 — 2차
- 파라미터가 들어간 예시 SQL의 저장

## 3. 아키텍처

```
BE 서버 출력 (stdout / stderr)
  → pushLine            비밀값 가림 (기존, runner.ts)
  → SQL 추출기          querylog.ts (신규)
  → 쿼리 집계           워크트리별, SQLite 보관
      ├→ 쿼리 탭        RightPanel / QueryPanel
      └→ Claude 도구    server_queries · db_explain
                          → explainQuery (dbquery.ts, 롤백)
                          → 세션 DB (Oracle · PG · MySQL · MSSQL)
```

추출과 집계는 줄이 들어올 때마다 한다. 실행 계획은 사용자가 고르거나 Claude가 도구를 부를 때만 DB에 묻는다.

## 4. 기능 명세

| # | 기능 | 설명 | 구현 메모 | 단계 | 상태 |
| --- | --- | --- | --- | --- | --- |
| 1 | SQL 추출 | 로그 줄에서 SQL, 파라미터, 결과 행 수, 실행 시간, 호출 위치를 뽑는다. | MyBatis: `==>  Preparing:`, `==> Parameters:`, `<==      Total:`/`Updates:`. 로거 이름에서 매퍼 id, 스레드 이름(`[nio-9091-exec-1]`)으로 요청 묶음. Hibernate: `Hibernate:`, `org.hibernate.SQL`, 여러 줄 SQL은 다음 로그 머리까지 잇는다. p6spy: 한 줄에 시간과 SQL. `==>`, `Hibernate` 같은 글자로 먼저 걸러 정규식 비용을 줄인다. | 1 | ✅ |
| 2 | 쿼리 모양 묶기 | 값만 다른 쿼리를 하나로 센다. | 문자열·숫자 리터럴을 `?`로, `IN (?, ?, …)`을 `IN (…)`으로, 공백·대소문자 정리. 해시를 키로 쓴다. | 1 | ✅ |
| 3 | 집계 | 모양별 호출 수, 결과 행 합계·최대, 시간 합계·최대(있을 때), 매퍼 id, 처음·마지막 시각, 예시 하나. | 메모리 `Map`에 모으고 5초마다 바뀐 행만 `query_stats`에 한 트랜잭션으로 쓴다. 키는 (워크트리, 모양 해시). 워크트리당 최대 500개, 넘으면 마지막 시각이 오래된 것부터 지움. 워크트리 정리 때 함께 삭제. "초기화" 버튼. 파라미터가 들어간 예시 SQL은 메모리에만. | 1 | ✅ |
| 4 | 쿼리 탭 | BE 서버 영역에서 로그와 쿼리를 오간다. | 열: 쿼리 모양 앞부분, 매퍼, 호출 수, 평균·최대 행, 시간, 경고. 호출 수·행·시간 정렬, 경고만 보기. WebSocket `queries` 이벤트로 갱신(1초 묶음). | 1 | ✅ |
| 5 | 경고 | N+1, 대량 결과, 느림, SQL 모양 문제를 표시한다. | 5절 탐지 규칙 참고. | 1 | ✅ |
| 6 | 매퍼 로그 켜기 | BE 서버를 띄울 때 SQL 로그를 기본으로 켠다. 서버 실행 대화상자에서 끌 수 있다. | Spring은 `LOGGING_LEVEL_<매퍼 패키지>=DEBUG`. 패키지는 `@MapperScan`, 매퍼 XML `namespace`에서 찾는다. 사용자가 같은 키를 직접 넣었으면 그 값을 따른다. 로그 탭에 SQL 줄 숨기기 토글. | 1 | ✅ |
| 7 | 실행 계획 | 쿼리를 골라 실행 계획과 관련 테이블의 인덱스·행 수를 본다. Oracle부터. | `explainQuery`. 6절 참고. 도구를 다시 켜서 예시 SQL이 없으면 화면을 한 번 더 열어 달라고 안내. | 2 | ✅ |
| 8 | Claude 최적화 요청 | 쿼리 상세에서 버튼을 누르면 근거를 묶어 세션 대화로 보낸다. | 보내는 것: 쿼리 모양, 예시 SQL, 집계 수치, 경고, 실행 계획, 매퍼 id. Claude는 매퍼 XML을 찾아 diff를 제안하고, 인덱스 DDL은 `dbwrite` 승인 카드로 올린다. | 3 | ✅ |
| 9 | Claude 조회 도구 | 대화 중에 Claude가 직접 통계와 계획을 본다. | `server_queries`: 세션 서버들의 집계 목록(정렬·경고 필터). `db_explain`: 연결 번호와 SQL로 실행 계획. 둘 다 읽기라 계획 모드에서도 허용. | 3 | ✅ |

### 구현 결과

- 커밋 메시지 기준 "매퍼 위치"와 "실행 계획 풀이"가 함께 들어갔다 (`server/src/mapperindex.ts`, `formatExplain`).
- `query_stats` 테이블은 `server/src/db.ts`가 아니라 `server/src/querylog.ts`가 직접 만든다. 매퍼 패키지 찾기(`findMapperPackages`)도 `querylog.ts`에 있다.
- 실행 계획에 쓸 DB 연결 고르기는 `server/src/querydb.ts`(등록한 연결 우선, 없으면 환경값에서 짐작), 화면은 `web/src/components/QueryPanel.tsx`로 분리됐다.
- 세부 차이는 아직 대조하지 않았다. 필요하면 이 표의 상태를 코드와 맞춰 갱신한다.

## 5. 탐지 규칙

규칙은 의심을 표시할 뿐 판단하지 않는다. 기준값은 처음엔 상수로 두고 쓰면서 맞춘다.

| 경고 | 조건 | 필요한 로그 |
| --- | --- | --- |
| N+1 의심 | 같은 스레드에서 같은 모양이 2초 안에 10번 넘게, 파라미터만 바뀌어 나온다. | 스레드 이름이 있는 로그 형식 |
| 대량 결과 | 한 번에 1,000행 넘게 돌려준다. | MyBatis `Total:` |
| 느림 | 한 번에 500ms를 넘긴다. | p6spy 같은 시간 로그. MyBatis 기본 로그에는 시간이 없다. |
| 잦은 호출 | 측정 구간에서 호출 수 상위 5개 중 결과가 매번 같은 크기인 것(캐시 후보). | 모든 형식 |
| SQL 모양 | `SELECT *`, 앞에 `%`가 붙은 `LIKE`, WHERE 컬럼에 함수(`TO_CHAR(col)`, `UPPER(col)`), WHERE 없는 SELECT·UPDATE·DELETE, 큰 `OFFSET`. | 모든 형식 |

## 6. 실행 계획

`explainQuery(c, sql, params)`는 `isReadOnly`를 통과한 SELECT만 받고, 엔진별로 계획 문장을 감싸 한 연결·한 트랜잭션에서 실행한 뒤 롤백한다. `?` 자리에는 로그에서 잡은 파라미터 값을 넣는다.

| 엔진 | 방법 | 주의 |
| --- | --- | --- |
| Oracle | `EXPLAIN PLAN SET STATEMENT_ID = :id FOR …` 다음 `SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(NULL, :id, 'TYPICAL'))` | 두 문장이고 PLAN_TABLE에 쓰므로 전용 경로를 둔다. 리터럴로 넣은 계획은 바인드 변수 계획과 다를 수 있다고 화면에 적는다. 인덱스: `ALL_INDEXES`, `ALL_IND_COLUMNS`, 행 수: `ALL_TABLES.NUM_ROWS`. |
| PostgreSQL | `EXPLAIN (FORMAT JSON) …`. 원하면 `ANALYZE`를 붙여 실제 실행(롤백). | ANALYZE는 실제로 돌리므로 버튼을 따로 둔다. 인덱스: `pg_indexes`, 행 수: `pg_class.reltuples`. |
| MySQL·MariaDB | `EXPLAIN FORMAT=JSON …` | 인덱스: `information_schema.STATISTICS`. |
| MSSQL | `SET SHOWPLAN_XML ON` 다음 질의, 끝나면 `OFF` | `SET`이 쓰기 단어라 전용 경로가 필요하다. 질의는 실행되지 않는다. |

## 7. 핵심 흐름: 느린 화면에서 수정 제안까지

1. **서버 띄우기**: 평소처럼 띄우면 매퍼 SQL 로그가 켜진 채로 시작한다.
2. **측정 구간 잡기**: 쿼리 탭에서 초기화를 누르고 미리보기에서 느린 화면을 한 번 연다.
3. **의심 쿼리 보기**: 호출 수 순으로 보면 N+1 경고가 붙은 `selectDetail`이 40번 나간 것이 보인다.
4. **실행 계획**: 행을 눌러 상세를 열고 실행 계획을 받는다. 테이블 전체 읽기와 인덱스 목록이 함께 나온다.
5. **Claude에게 넘기기**: "최적화 요청"을 누르면 근거가 대화로 들어간다. Claude가 매퍼 XML을 찾아 JOIN 한 번으로 바꾸는 diff와 인덱스 DDL을 제안한다.
6. **승인과 확인**: 코드 수정은 평소처럼, DDL은 승인 카드로 반영한다. 다시 초기화하고 같은 화면을 열어 호출 수가 줄었는지 본다.

## 8. 변경 파일

| 파일 | 변경 | 단계 |
| --- | --- | --- |
| `server/src/querylog.ts` | 신규. 형식별 추출기, 모양 정규화, 워크트리별 집계, 경고 규칙, `query_stats` 테이블, 매퍼 패키지 찾기. | 1 |
| `server/src/querydb.ts` | 신규(계획 외). 워크트리별 실행 계획용 DB 연결 고르기. | 2 |
| `server/src/runner.ts` | `pushLine`에서 추출기 호출, 서버를 띄울 때 로그 레벨 환경값 넣기. | 1 |
| `server/src/cleanup.ts` | 워크트리 정리 때 해당 집계 삭제. | 1 |
| `server/src/hub.ts` | `queries` 이벤트 추가. | 1 |
| `server/src/index.ts` | `GET /api/worktrees/:id/queries`, `POST …/queries/reset`, `POST …/queries/:key/explain`. | 1·2 |
| `server/src/mapperindex.ts` | 매퍼 id → XML 위치 찾기. | 1 |
| `web/src/components/RightPanel.tsx`, `QueryPanel.tsx` | BE 서버 영역에 로그/쿼리 전환, 쿼리 목록과 상세. | 1 |
| `web/src/types.ts`, `api.ts`, `events.ts` | 쿼리 집계 타입, API, 이벤트 처리. | 1 |
| `server/src/dbquery.ts` | `explainQuery`, `formatExplain`과 엔진별 인덱스·행 수 조회. | 2 |
| `server/src/claude.ts` | `server_queries`, `db_explain` 도구. | 3 |

## 9. 로드맵

| 단계 | 기간 | 내용 | 완료 기준 | 상태 |
| --- | --- | --- | --- | --- |
| 1. 추출, 집계, 쿼리 탭 | 3~4일 | MyBatis·Hibernate 추출기, 모양 묶기, 경고 규칙, SQLite 보관, 쿼리 탭, 매퍼 로그 기본 켜기. 찾아서 보여주기만 한다. | KEA BE를 따로 설정하지 않고 띄워 화면 하나를 열면, 그 화면이 낸 쿼리가 모양별 호출 수와 행 수로 보이고 반복 조회에는 N+1 표시가 붙는다. 도구를 다시 켜도 집계가 남아 있다. | ✅ |
| 2. 실행 계획 | 2~3일 | Oracle 전용 경로 먼저, 이어서 PostgreSQL, MySQL, MSSQL. 인덱스와 행 수를 함께 보여준다. | 쿼리 상세에서 버튼 한 번으로 Oracle 실행 계획과 관련 인덱스가 나오고, DB에는 아무것도 남지 않는다. | ✅ |
| 3. Claude 연계 | 2일 | 최적화 요청 버튼과 `server_queries`, `db_explain` 도구. | 요청 버튼을 누르면 Claude가 해당 매퍼 XML 위치와 근거를 짚은 수정안을 내고, DDL은 승인 카드로만 올라온다. | ✅ |
| 이후 | - | Node ORM 로그, Oracle `V$SQL` 기반 실제 계획, DB 쪽 통계 수집 | 미정 | ⬜ |

## 10. 리스크와 대응

| 등급 | 리스크 | 내용 | 대응 |
| --- | --- | --- | --- |
| 높음 | 로그가 안 나옴 | 매퍼 패키지를 못 찾거나 프로젝트가 다른 로깅 설정을 쓰면 기본 켜기가 효과가 없다. 프로젝트마다 로그 형식도 다르다. | 쿼리 탭이 비어 있으면 넣은 환경값과 찾은 패키지를 보여주고 직접 고칠 수 있게 한다. 추출기는 형식별로 나눠 하나씩 붙인다. |
| 높음 | 로그가 SQL로 덮임 | 모든 BE 서버 로그에 SQL 줄이 크게 늘고, 3000줄 보관이 금방 차서 오류 줄이 밀려난다. | 로그 탭 SQL 줄 숨기기 토글. 실패 요약(`failureExcerpt`)은 SQL 줄을 빼고 고른다. 글자 검사로 먼저 거르고, 모양 수 상한, 1초 묶음 전송, 5초 묶음 저장. |
| 중간 | 계획이 실제와 다름 | 리터럴을 넣은 계획은 바인드 변수로 실행될 때 계획과 다를 수 있다. | 화면에 적어 두고, PostgreSQL은 ANALYZE 선택지를 둔다. Oracle `V$SQL` 기반 실제 계획은 이후 검토. |
| 중간 | 경고 오탐 | 의도한 반복 조회나 배치 조회에도 N+1이 붙는다. | 표시만 하고, 쿼리 모양별로 경고 숨기기를 둔다. |
| 낮음 | 파라미터 노출 | 예시 SQL에 개인정보가 들어간다. | `maskSecrets`를 거친 줄만 쓴다. SQLite에는 값을 뺀 모양과 수치만 저장하고, 예시 SQL은 메모리에만 둔다. |
| 낮음 | PLAN_TABLE 권한 | Oracle 계정에 PLAN_TABLE이 없거나 권한이 없다. | 오류를 그대로 보여주고 필요한 권한을 안내한다. |

## 11. 결정 사항

- **집계 보관: SQLite** — 도구를 다시 켜도 집계가 남는다. 값을 뺀 모양과 수치만 저장하고, 워크트리를 정리할 때 함께 지운다.
- **매퍼 로그 켜기: 기본으로 켬** — BE 서버를 띄우면 따로 설정하지 않아도 쿼리 탭이 채워진다. 서버 실행 대화상자에서 끌 수 있고, 로그 탭에는 SQL 줄 숨기기를 둔다.
- **엔진 순서: Oracle 먼저** — KEA 프로젝트가 Oracle이라 가장 먼저 쓴다. 전용 경로가 필요해 2단계 공수가 가장 크다.
- **고치는 방식: 제안과 승인만** — 자동 수정은 넣지 않는다. 코드는 평소 대화 흐름으로, DDL은 `dbwrite` 승인 카드로만 반영한다.
