import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function githubStatus(): Promise<{ installed: boolean; loggedIn: boolean; account: string | null }> {
  try {
    await run('gh', ['--version']);
  } catch {
    return { installed: false, loggedIn: false, account: null };
  }
  try {
    const { stdout, stderr } = await run('gh', ['auth', 'status']);
    const text = `${stdout}\n${stderr}`;
    const m = text.match(/account\s+(\S+)/) ?? text.match(/as\s+(\S+)/);
    return { installed: true, loggedIn: true, account: m?.[1]?.replace(/[()]/g, '') ?? null };
  } catch {
    return { installed: true, loggedIn: false, account: null };
  }
}
