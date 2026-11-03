import { getProject, projectUrl } from './projects.js';
import type { SessionView } from './sessions.js';

/**
 * 환경값 안의 포트 자리. 프로필에는 자리로 저장해 두고, 서버를 띄울 때 그 세션의 FE·BE 주소로 채운다.
 * 예: CERT_AUTH_CALLBACK_URL={be_url}/auth/callback → http://localhost:8083/auth/callback
 * 세션이 바뀌어 포트가 달라져도 다시 맞출 필요가 없다.
 */
export type SessionAddrs = { fe_url: string | null; be_url: string | null; fe_port: number | null; be_port: number | null };

// ${...}는 Spring·셸 변수라 건드리지 않는다.
const SLOT = /(?<!\$)\{(fe_url|be_url|fe_port|be_port|port)\}/g;

export const hasPortVar = (v: string) => new RegExp(SLOT.source).test(v);

/** 세션의 FE·BE 주소. ports에 워크트리 ID별 포트가 있으면 그것, 없으면 워크트리에 잡아 둔 포트. */
export function sessionAddrs(session: SessionView, ports: Record<number, number> = {}): SessionAddrs {
  const at = (fe: boolean) => {
    const w = session.worktrees.find((x) => (x.project_kind === 'fe') === fe);
    const port = w ? ports[w.id] ?? w.port ?? null : null;
    return { port, url: w && port ? projectUrl(getProject(w.project_id), port) : null };
  };
  const fe = at(true), be = at(false);
  return { fe_url: fe.url, be_url: be.url, fe_port: fe.port, be_port: be.port };
}

/** 값의 포트 자리를 채운다. 채울 수 없는 자리(세션에 그 앱이 없음)는 unresolved로 알려 준다. */
export function renderPorts(env: Record<string, string>, a: SessionAddrs, ownPort: number | null): { env: Record<string, string>; unresolved: string[] } {
  const vals: Record<string, string | null> = { ...a, fe_port: a.fe_port ? String(a.fe_port) : null, be_port: a.be_port ? String(a.be_port) : null, port: ownPort ? String(ownPort) : null };
  const out: Record<string, string> = {};
  const unresolved: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    out[k] = v.replace(SLOT, (m, name: string) => {
      const x = vals[name];
      if (x === null) { unresolved.push(k); return m; }
      return x;
    });
  }
  return { env: out, unresolved: [...new Set(unresolved)] };
}

const LOOPBACK = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]'];
const portOf = (u: URL) => u.port || (/^(https|wss):$/.test(u.protocol) ? '443' : '80');

/** 같은 서버를 가리키는지. localhost와 127.0.0.1은 같게 본다. */
export function sameServer(a: URL, b: URL): boolean {
  return portOf(a) === portOf(b) && (a.hostname === b.hostname || (LOOPBACK.includes(a.hostname) && LOOPBACK.includes(b.hostname)));
}

/** 이 세션 주소·포트가 들어간 값을 포트 자리로 바꾼다. 바꿀 수 없으면 그대로 돌려준다. */
export function toTemplate(value: string, a: SessionAddrs): string {
  const v = value.trim();
  if (/^\d+$/.test(v)) return v === String(a.be_port) ? '{be_port}' : v === String(a.fe_port) ? '{fe_port}' : v;
  const origin = /^[a-z][a-z0-9+.-]*:\/\/[^/?#\s]+/i.exec(v)?.[0];
  if (!origin) return v;
  for (const name of ['be_url', 'fe_url'] as const) {
    const base = a[name];
    if (!base) continue;
    try {
      const u = new URL(origin), b = new URL(base);
      // 경로가 붙은 주소(https://host/app)는 경로까지 같아야 하고, 프로토콜이 다르면(ws://) 자리로 바꿀 수 없다.
      if (u.protocol === b.protocol && sameServer(u, b) && b.pathname.replace(/\/+$/, '') === '') return `{${name}}${v.slice(origin.length)}`;
    } catch { /* 주소가 아니면 그대로 */ }
  }
  return v;
}
