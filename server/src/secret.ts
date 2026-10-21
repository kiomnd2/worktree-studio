import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

// 환경값과 계정 비밀번호는 데이터 폴더의 키로 암호화해 DB에 넣는다.
// 키 파일은 사용자만 읽을 수 있게(0600) 만든다.
const KEY_PATH = path.join(DATA_DIR, 'secret.key');

function loadKey(): Buffer {
  if (fs.existsSync(KEY_PATH)) return Buffer.from(fs.readFileSync(KEY_PATH, 'utf8').trim(), 'base64');
  const key = crypto.randomBytes(32);
  fs.writeFileSync(KEY_PATH, key.toString('base64'), { mode: 0o600 });
  return key;
}
const KEY = loadKey();

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64')}`;
}

export function decrypt(stored: string | null): string {
  if (!stored) return '';
  if (!stored.startsWith('v1:')) return stored;
  const raw = Buffer.from(stored.slice(3), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

const SECRET_HINT = /(SECRET|PASSWORD|PASSWD|PWD|TOKEN|API_?KEY|PRIVATE|CREDENTIAL|DSN|AUTH)/i;
export const looksSecret = (key: string) => SECRET_HINT.test(key);

/** 로그와 PR 본문에 섞이지 않도록 알려진 비밀값을 가린다. */
export function maskSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('••••');
  return out;
}
