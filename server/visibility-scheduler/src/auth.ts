// Who is asking: a device key (ContentStudio, the extension) or a signed-in browser
// session (the setup page). There are no passwords; a session only ever comes from
// Google sign-in for the allowed account, and only a session can make a device key.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { DB } from './db.js';

export const SESSION_COOKIE = 'cs_session';
export const OAUTH_COOKIE = 'cs_oauth';
/** Set when a sign-in started from the extension, so it goes back there rather than home. */
export const AFTER_LOGIN_COOKIE = 'cs_after_login';
const SESSION_MS = 30 * 24 * 3600_000;
const KEY_PREFIX = 'csk_';

export type Caller = { kind: 'device'; name: string } | { kind: 'web'; email: string };

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookieHeader(name: string, value: string, maxAgeSeconds: number, path: string): string {
  return `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

export function webSession(db: DB, req: IncomingMessage, now: number): Caller | null {
  const token = cookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const row = db.prepare('SELECT email, expires_at FROM sessions WHERE token_hash = ?').get(sha256(token)) as
    | { email: string; expires_at: number }
    | undefined;
  if (!row || row.expires_at < now) return null;
  return { kind: 'web', email: row.email };
}

export function deviceCaller(db: DB, req: IncomingMessage, now: number): Caller | null {
  const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
  if (!m || !m[1]!.startsWith(KEY_PREFIX)) return null;
  const row = db.prepare('SELECT id, name FROM device_keys WHERE key_hash = ? AND revoked_at IS NULL').get(sha256(m[1]!)) as
    | { id: string; name: string }
    | undefined;
  if (!row) return null;
  db.prepare('UPDATE device_keys SET last_used_at = ? WHERE id = ?').run(now, row.id);
  return { kind: 'device', name: row.name };
}

export function createSession(db: DB, email: string, now: number): { token: string; maxAgeSeconds: number } {
  const token = randomToken();
  db.prepare('INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(token), email, now, now + SESSION_MS);
  return { token, maxAgeSeconds: SESSION_MS / 1000 };
}

export function endSession(db: DB, req: IncomingMessage): void {
  const token = cookies(req)[SESSION_COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

/** Makes a key and returns it. Only its hash is stored, so this is the one time it exists in full. */
export function createDeviceKey(db: DB, name: string, now: number): string {
  const key = KEY_PREFIX + randomToken();
  db.prepare('INSERT INTO device_keys (id, name, key_hash, created_at) VALUES (?, ?, ?, ?)').run(randomUUID(), name, sha256(key), now);
  return key;
}

export function revokeDeviceKey(db: DB, id: string, now: number): boolean {
  return db.prepare('UPDATE device_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, id).changes === 1;
}

export function pruneExpired(db: DB, now: number): void {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM oauth_states WHERE created_at < ?').run(now - 15 * 60_000);
}
