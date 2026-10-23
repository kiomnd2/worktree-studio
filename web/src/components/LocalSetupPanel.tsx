import { useEffect, useState } from 'react';
import { api } from '../api';
import type { DbCandidate, DbConnectionInput, DbEngine, DockerStack, LocalSetup, Project } from '../types';

const ENGINES: { value: DbEngine; label: string; port: number }[] = [
  { value: 'postgres', label: 'PostgreSQL', port: 5432 },
  { value: 'mysql', label: 'MySQL', port: 3306 },
  { value: 'mariadb', label: 'MariaDB', port: 3306 },
  { value: 'oracle', label: 'Oracle', port: 1521 },
  { value: 'mssql', label: 'SQL Server', port: 1433 },
  { value: 'mongodb', label: 'MongoDB', port: 27017 },
  { value: 'redis', label: 'Redis', port: 6379 },
];
const LABEL = Object.fromEntries(ENGINES.map((e) => [e.value, e.label])) as Record<DbEngine, string>;

const mapToText = (m: Record<string, string>) => Object.entries(m).map(([k, v]) => `${k}=${v}`).join('\n');
const textToMap = (t: string) => Object.fromEntries(t.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).flatMap((l) => {
  const i = l.indexOf('=');
  return i > 0 ? [[l.slice(0, i).trim(), l.slice(i + 1).trim()]] : [];
}));

/** 스택 목록에 서비스를 더한다(같은 파일이면 합친다). */
function mergeStack(list: DockerStack[], add: DockerStack): DockerStack[] {
  const hit = list.find((s) => s.file === add.file);
  if (!hit) return [...list, add];
  return list.map((s) => (s === hit ? { ...s, services: [...new Set([...s.services, ...add.services])] } : s));
}

type Props = { p: Project; notify: (text: string) => void };

/**
 * 프로젝트의 로컬 실행 환경. 새 워크트리에서 서버가 바로 뜨도록
 * DB 연결(환경값 프로필과 따로), 서버 앞에 띄울 도커, 클론에서 복사할 로컬 설정 파일을 정한다.
 */
export default function LocalSetupPanel({ p, notify }: Props) {
  const [data, setData] = useState<LocalSetup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState<{ id?: number; c: DbConnectionInput; mapText: string } | null>(null);
  const [tests, setTests] = useState<Record<number, string>>({});

  const load = () => api.localSetup(p.id).then(setData).catch((e) => setError((e as Error).message));
  useEffect(() => { load(); }, [p.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(label: string, fn: () => Promise<unknown>, done?: string) {
    setBusy(label); setError(null);
    try { await fn(); await load(); if (done) notify(done); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }

  async function newForm(engine: DbEngine, from?: DbCandidate) {
    const d = await api.dbDefaults(p.id, engine);
    const g = from ?? d.guess;
    setForm({
      c: {
        name: from ? `로컬 ${LABEL[engine]} (${from.from.split(' · ').pop()})` : `로컬 ${LABEL[engine]}`, engine,
        host: g?.host ?? 'localhost', port: g?.port ?? ENGINES.find((e) => e.value === engine)!.port,
        database: g?.database ?? '', username: g?.username ?? '', password: g?.password ?? '',
        env_map: d.env_map, enabled: true, note: from ? `compose ${from.from}` : '',
      },
      mapText: mapToText(d.env_map),
    });
  }

  if (!data) return <div className="local-setup muted small">{error ?? '로컬 실행 환경을 살펴보는 중'}</div>;

  const covered = new Set(data.connections.filter((c) => c.enabled).map((c) => c.engine));
  const needs = data.needs.filter((e) => !covered.has(e));
  // 저장소 compose 파일은 상대 경로, Studio가 만든 파일은 절대 경로로 저장돼 있다.
  const studio = (file: string) => file.startsWith('/');

  return (
    <div className="local-setup">
      <div className="local-head">
        <strong>로컬 실행 환경</strong>
        <span className="muted small">새 워크트리에서 서버가 바로 뜨게, 서버를 띄우기 전에 아래를 맞춥니다</span>
        <span className="spacer" />
        <span className={`pill ${data.docker === 'ok' ? 'ok' : 'warn'}`}>Docker {data.docker === 'ok' ? '켜짐' : data.docker === 'daemon-down' ? '꺼짐' : '없음'}</span>
        {data.docker === 'daemon-down' && <button className="small-btn" onClick={() => act('docker', () => api.openDocker(), 'Docker Desktop을 켜는 중입니다. 잠시 뒤 다시 확인하세요.')}>Docker 켜기</button>}
      </div>
      {error && <p className="error-text small" role="alert">{error}</p>}

      {/* ---------- DB 연결 ---------- */}
      <section className="local-block" aria-label="DB 연결">
        <div className="local-block-head">
          <strong>DB 연결</strong>
          <span className="muted small">환경값 프로필과 따로 둡니다. 켠 연결이 서버 실행 때 환경변수(SPRING_DATASOURCE_URL, DATABASE_URL 등)로 들어가고 프로필 값보다 우선합니다.</span>
        </div>
        {data.connections.length === 0 && <p className="muted small">아직 DB 연결이 없습니다.</p>}
        <ul className="db-list">
          {data.connections.map((c) => (
            <li key={c.id} className={c.enabled ? undefined : 'off'}>
              <label className="start-check" title="같은 종류의 다른 연결은 꺼집니다">
                <input type="checkbox" checked={c.enabled} onChange={(e) => act(`en-${c.id}`, () => (e.target.checked ? api.enableDb(c.id) : api.updateDb(c.id, { ...c, enabled: false })))} />
                <strong>{c.name}</strong>
              </label>
              <span className="pill">{LABEL[c.engine]}</span>
              <code className="small">{c.host}:{c.port ?? ''}{c.database ? `/${c.database}` : ''}</code>
              {c.username && <span className="muted small">{c.username}</span>}
              <span className="muted small mono">{Object.keys(c.env_map).join(', ') || '환경변수 없음'}</span>
              <span className="spacer" />
              {tests[c.id] && <span className="small">{tests[c.id]}</span>}
              <button className="small-btn" disabled={busy === `t-${c.id}`} onClick={async () => {
                setBusy(`t-${c.id}`);
                try { const r = await api.testDb(c.id); setTests((t) => ({ ...t, [c.id]: r.reachable ? `${r.target} 열림` : `${r.target} 응답 없음` })); }
                catch (e) { setError((e as Error).message); } finally { setBusy(null); }
              }}>연결 확인</button>
              <button className="small-btn" onClick={() => setForm({ id: c.id, c: { ...c }, mapText: mapToText(c.env_map) })}>편집</button>
              <button className="small-btn danger" onClick={() => { if (confirm(`${c.name} 연결을 지울까요?`)) act(`d-${c.id}`, () => api.deleteDb(c.id), `${c.name} 연결을 지웠습니다.`); }}>삭제</button>
              {c.note && <div className="muted small db-note">{c.note}</div>}
            </li>
          ))}
        </ul>

        {data.candidates.length > 0 && (
          <div className="local-found">
            <span className="small strong">docker compose에서 찾은 로컬 DB</span>
            {data.candidates.map((c) => (
              <div key={c.from} className="row small">
                <span className="pill">{LABEL[c.engine]}</span>
                <code>{c.host}:{c.port}{c.database ? `/${c.database}` : ''}</code>
                <span className="muted">{c.from}</span>
                <span className="spacer" />
                <button className="small-btn dark" disabled={Boolean(busy)} onClick={() => act(`cand-${c.from}`, async () => {
                  const d = await api.dbDefaults(p.id, c.engine);
                  await api.createDb(p.id, { name: `로컬 ${LABEL[c.engine]}`, engine: c.engine, host: c.host, port: c.port, database: c.database, username: c.username, password: c.password, env_map: d.env_map, enabled: true, note: `compose ${c.from}` });
                  if (c.stack) await api.saveLocalSetup(p.id, { stacks: mergeStack(data.stacks, c.stack) });
                }, `${LABEL[c.engine]} 연결을 만들고, 서버 실행 전에 도커로 ${c.stack?.services.join(', ')}를 띄우게 했습니다.`)}>연결로 쓰고 도커로 띄우기</button>
                <button className="small-btn" onClick={() => newForm(c.engine, c)}>고쳐서 추가</button>
              </div>
            ))}
          </div>
        )}

        {needs.length > 0 && (
          <div className="local-found">
            <span className="small strong">DB가 필요해 보입니다</span>
            {needs.map((e) => (
              <div key={e} className="row small">
                <span className="pill warn">{LABEL[e]}</span>
                <span className="muted">의존성에 {LABEL[e]} 드라이버가 있는데 켠 연결이 없습니다.</span>
                <span className="spacer" />
                {data.studio_engines.includes(e) && (
                  <button className="small-btn dark" disabled={Boolean(busy)} title="Studio 데이터 폴더에 compose 파일을 만들고(저장소에는 쓰지 않음) 서버 실행 전에 띄웁니다. 빈 DB라 스키마·데이터는 앱 마이그레이션이나 직접 넣어야 합니다"
                    onClick={() => act(`studio-${e}`, () => api.createStudioDb(p.id, e), `로컬 도커 ${LABEL[e]}를 만들었습니다. 서버를 띄울 때 도커로 먼저 띄웁니다.`)}>
                    {busy === `studio-${e}` ? '만드는 중' : '로컬 도커 DB 만들기'}
                  </button>
                )}
                <button className="small-btn" onClick={() => newForm(e)}>접속 정보 직접 넣기</button>
              </div>
            ))}
          </div>
        )}

        {!form && (
          <div className="row">
            <span className="muted small">새 연결</span>
            {ENGINES.map((e) => <button key={e.value} className="small-btn dashed" onClick={() => newForm(e.value)}>+ {e.label}</button>)}
          </div>
        )}
        {form && (
          <DbForm form={form} setForm={setForm} busy={Boolean(busy)} onSave={() => act('save-db', async () => {
            const c = { ...form.c, env_map: textToMap(form.mapText) };
            if (form.id) await api.updateDb(form.id, c); else await api.createDb(p.id, c);
            setForm(null);
          }, `${form.c.name} 연결을 저장했습니다.`)} />
        )}
      </section>

      {/* ---------- 도커 ---------- */}
      <DockerBlock data={data} studio={studio} busy={Boolean(busy)} onSave={(stacks) => act('stacks', () => api.saveLocalSetup(p.id, { stacks }), '서버 실행 전에 띄울 도커 서비스를 저장했습니다.')} />

      {/* ---------- 복사할 파일 ---------- */}
      <CopyBlock data={data} busy={Boolean(busy)} onSave={(files) => act('copy', () => api.saveLocalSetup(p.id, { copy_files: files }), '클론에서 복사할 파일을 저장했습니다.')} />
    </div>
  );
}

function DbForm({ form, setForm, busy, onSave }: {
  form: { id?: number; c: DbConnectionInput; mapText: string };
  setForm: (f: { id?: number; c: DbConnectionInput; mapText: string } | null) => void;
  busy: boolean; onSave: () => void;
}) {
  const c = form.c;
  const set = (patch: Partial<DbConnectionInput>) => setForm({ ...form, c: { ...c, ...patch } });
  const [reveal, setReveal] = useState(false);
  return (
    <div className="db-form">
      <div className="pj-grid">
        <label className="field"><span>이름</span><input value={c.name} onChange={(e) => set({ name: e.target.value })} /></label>
        <label className="field"><span>종류</span>
          <select value={c.engine} onChange={(e) => set({ engine: e.target.value as DbEngine })}>
            {ENGINES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
          </select>
        </label>
        <label className="field"><span>호스트</span><input className="mono" value={c.host} onChange={(e) => set({ host: e.target.value })} /></label>
        <label className="field"><span>포트</span><input className="mono" inputMode="numeric" value={c.port ?? ''} onChange={(e) => set({ port: e.target.value ? Number(e.target.value.replace(/\D/g, '')) || null : null })} /></label>
        <label className="field"><span>{c.engine === 'oracle' ? '서비스 이름' : 'DB 이름'}</span><input className="mono" value={c.database} placeholder={c.engine === 'oracle' ? 'FREEPDB1' : 'app'} onChange={(e) => set({ database: e.target.value })} /></label>
        <label className="field"><span>계정</span><input className="mono" value={c.username} onChange={(e) => set({ username: e.target.value })} /></label>
        <label className="field"><span>비밀번호</span>
          <div className="value-cell">
            <input className="mono" type={reveal ? 'text' : 'password'} value={c.password} onChange={(e) => set({ password: e.target.value })} />
            <button type="button" className="icon" onClick={() => setReveal(!reveal)}>{reveal ? '가림' : '보기'}</button>
          </div>
        </label>
      </div>
      <label className="field">
        <span>넣을 환경변수 <span className="muted small">한 줄에 하나, KEY=틀. 틀에 {'{jdbc_url} {url} {host} {port} {database} {username} {password}'}를 씁니다</span></span>
        <textarea className="mono" rows={Math.max(3, form.mapText.split('\n').length)} value={form.mapText} onChange={(e) => setForm({ ...form, mapText: e.target.value })} />
      </label>
      <div className="row">
        <label className="start-check"><input type="checkbox" checked={c.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> 이 연결 사용</label>
        <span className="spacer" />
        <button onClick={() => setForm(null)}>취소</button>
        <button className="primary" disabled={busy || !c.name.trim()} onClick={onSave}>저장</button>
      </div>
    </div>
  );
}

function DockerBlock({ data, studio, busy, onSave }: { data: LocalSetup; studio: (f: string) => boolean; busy: boolean; onSave: (s: DockerStack[]) => void }) {
  const [stacks, setStacks] = useState<DockerStack[]>(data.stacks);
  useEffect(() => setStacks(data.stacks), [data.stacks]);
  const dirty = JSON.stringify(stacks) !== JSON.stringify(data.stacks);
  const on = (file: string, svc: string) => stacks.some((s) => s.file === file && s.services.includes(svc));
  const toggle = (file: string, svc: string, v: boolean) => setStacks((list) => {
    const next = v ? mergeStack(list, { file, services: [svc] }) : list.map((s) => (s.file === file ? { ...s, services: s.services.filter((x) => x !== svc) } : s));
    return next.filter((s) => s.services.length);
  });
  const own = stacks.filter((s) => studio(s.file) && !data.compose.some((c) => c.file === s.file));
  return (
    <section className="local-block" aria-label="도커">
      <div className="local-block-head">
        <strong>서버 앞에 띄울 도커</strong>
        <span className="muted small">고른 서비스를 서버 실행 전에 <code>docker compose up -d --wait</code>로 띄웁니다. 클론 폴더 기준으로 띄워 워크트리마다 컨테이너가 늘지 않습니다.</span>
      </div>
      {data.compose.length === 0 && own.length === 0 && <p className="muted small">저장소에 docker compose 파일이 없습니다. DB가 필요하면 위에서 로컬 도커 DB를 만들 수 있습니다.</p>}
      {data.compose.map((c) => (
        <div key={c.file} className="compose-file">
          <code className="small">{c.file}</code>
          <div className="row wrap">
            {c.services.map((s) => (
              <label key={s.name} className={`start-check small${s.infra ? '' : ' muted'}`} title={s.image ?? '빌드하는 서비스(앱 자신일 수 있음)'}>
                <input type="checkbox" checked={on(c.file, s.name)} onChange={(e) => toggle(c.file, s.name, e.target.checked)} />
                {s.name}{s.infra && s.infra !== 'other' ? ` (${LABEL[s.infra]})` : ''}{s.ports[0] ? ` :${s.ports[0].host}` : ''}
              </label>
            ))}
          </div>
        </div>
      ))}
      {own.map((s) => (
        <div key={s.file} className="compose-file">
          <span className="muted small">Studio가 만든 파일</span> <code className="small">{s.file}</code>
          <div className="row wrap">
            {s.services.map((svc) => (
              <label key={svc} className="start-check small"><input type="checkbox" checked onChange={() => toggle(s.file, svc, false)} /> {svc}</label>
            ))}
          </div>
        </div>
      ))}
      {dirty && <div className="row"><button className="primary" disabled={busy} onClick={() => onSave(stacks)}>저장</button></div>}
    </section>
  );
}

function CopyBlock({ data, busy, onSave }: { data: LocalSetup; busy: boolean; onSave: (files: string[] | null) => void }) {
  const [auto, setAuto] = useState(data.copy_files.auto);
  const [files, setFiles] = useState<string[]>(data.copy_files.files);
  const [extra, setExtra] = useState('');
  useEffect(() => { setAuto(data.copy_files.auto); setFiles(data.copy_files.files); }, [data.copy_files]);
  const all = [...new Set([...data.copy_files.detected, ...files])];
  const dirty = auto !== data.copy_files.auto || (!auto && JSON.stringify(files) !== JSON.stringify(data.copy_files.files));
  return (
    <section className="local-block" aria-label="클론에서 복사할 파일">
      <div className="local-block-head">
        <strong>클론에서 복사할 로컬 설정 파일</strong>
        <span className="muted small">커밋하지 않아 새 워크트리에는 없는 파일입니다. 서버를 띄울 때 워크트리에 없으면 복사합니다(있으면 덮지 않음).</span>
      </div>
      <label className="start-check small"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> 자동으로 찾은 파일 쓰기 (.env, application-local.yml, .npmrc 등 git이 무시하는 파일)</label>
      {all.length === 0 && <p className="muted small">클론에서 복사할 로컬 설정 파일을 찾지 못했습니다.</p>}
      <div className="row wrap">
        {all.map((f) => (
          <label key={f} className="start-check small mono">
            <input type="checkbox" disabled={auto} checked={auto ? data.copy_files.detected.includes(f) : files.includes(f)}
              onChange={(e) => setFiles(e.target.checked ? [...files, f] : files.filter((x) => x !== f))} />
            {f}
          </label>
        ))}
      </div>
      {!auto && (
        <div className="row">
          <input className="mono" placeholder="저장소 기준 경로 (예: src/main/resources/application-local.yml)" value={extra} onChange={(e) => setExtra(e.target.value)} />
          <button disabled={!extra.trim()} onClick={() => { setFiles([...new Set([...files, extra.trim()])]); setExtra(''); }}>추가</button>
        </div>
      )}
      {dirty && <div className="row"><button className="primary" disabled={busy} onClick={() => onSave(auto ? null : files)}>저장</button></div>}
    </section>
  );
}
