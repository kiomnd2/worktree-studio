import fs from 'node:fs';
import path from 'node:path';

// -p 3000, --port 3000, --port=3000, --server.port=8080, -Dserver.port=8080. {port}·${PORT:-3000}처럼 바꿀 수 있는 자리는 고정이 아니다.
const FLAG = /(?:^|\s)(?:-p|--port)(?:\s+|=)(\d{2,5})(?=\s|$)|(?:^|[\s='"])(?:--|-D)server\.port=(\d{2,5})(?=\s|$)/;
const RUNNER = /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)/;

function portIn(text: string): number | null {
  const m = FLAG.exec(text);
  return m ? Number(m[1] ?? m[2]) : null;
}

/**
 * 실행 명령이 포트를 직접 박아 두었으면 그 번호. `npm run dev`처럼 스크립트를 부르면 package.json 스크립트까지 본다.
 * 이런 앱은 도구가 넘기는 PORT를 무시하므로, 그 포트로 띄우고 헬스체크해야 한다.
 */
export function fixedPort(cwd: string, cmd: string | null | undefined): number | null {
  if (!cmd) return null;
  const last = cmd.split(/&&|;/).pop()!.trim();
  const direct = portIn(last);
  if (direct) return direct;
  const m = RUNNER.exec(last);
  if (!m) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    const script = pkg.scripts?.[m[1]];
    return script ? portIn(script) : null;
  } catch {
    return null;
  }
}
