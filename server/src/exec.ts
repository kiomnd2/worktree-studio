import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** 실행 파일을 직접 부른다. 실패하면 stderr를 메시지로 담아 던진다. */
export async function runFile(file: string, args: string[], cwd: string, timeoutMs = 120_000): Promise<string> {
  try {
    const { stdout } = await execFileP(file, args, { cwd, maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs });
    return stdout.trim();
  } catch (err) {
    const e = err as Error & { stderr?: string; stdout?: string };
    const detail = (e.stderr || e.stdout || e.message).trim().split('\n').slice(-8).join('\n');
    throw new Error(`${file} ${args[0] ?? ''} 실패: ${detail}`);
  }
}

export type ShellResult = { code: number | null; output: string; timedOut: boolean };

/** 셸 명령을 돌리고 출력 끝부분을 모은다. 빌드·테스트처럼 오래 걸리고 출력이 많은 명령용. */
export function runShell(cmd: string, cwd: string, opts: { timeoutMs?: number; onLine?: (line: string) => void } = {}): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd, shell: true, detached: process.platform !== 'win32', env: { ...process.env, FORCE_COLOR: '0', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines: string[] = [];
    let buf = '';
    let timedOut = false;
    const push = (raw: string) => {
      const line = raw.replace(ANSI, '').replace(/\r$/, '');
      lines.push(line);
      if (lines.length > 400) lines.splice(0, lines.length - 400);
      opts.onLine?.(line);
    };
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      parts.forEach(push);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = opts.timeoutMs ? setTimeout(() => {
      timedOut = true;
      try { if (child.pid) process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch { /* gone */ }
    }, opts.timeoutMs) : null;
    child.on('error', (err) => push(`실행 실패: ${err.message}`));
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (buf) push(buf);
      resolve({ code, output: lines.join('\n'), timedOut });
    });
  });
}
