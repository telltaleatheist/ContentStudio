// Google OAuth and the three YouTube Data API calls this service makes, over plain fetch.

import { createHash, randomBytes } from 'node:crypto';
import type { Config } from './config.js';
import type { DB } from './db.js';
import { isTransientStatus } from './rules.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const YT = 'https://www.googleapis.com/youtube/v3';

export const LOGIN_SCOPE = 'openid email';
export const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube';

export class GoogleError extends Error {
  constructor(
    message: string,
    /** HTTP status, or undefined when the request never got an answer. */
    readonly status: number | undefined,
    /** Google refused the refresh token: the channel has to be connected again. */
    readonly needsReconnect = false,
  ) {
    super(message);
  }
  get transient(): boolean {
    return !this.needsReconnect && isTransientStatus(this.status);
  }
}

export function newVerifier(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function redirectUri(config: Config): string {
  return `${config.baseUrl}/oauth/callback`;
}

export function authorizeUrl(config: Config, purpose: 'login' | 'connect', state: string, challenge: string): string {
  const p = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: redirectUri(config),
    response_type: 'code',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  if (purpose === 'login') {
    p.set('scope', LOGIN_SCOPE);
    p.set('prompt', 'select_account');
    p.set('login_hint', config.allowedEmail);
  } else {
    // offline + consent is what makes Google return a refresh token every time;
    // select_account shows the brand-channel chooser.
    p.set('scope', YOUTUBE_SCOPE);
    p.set('access_type', 'offline');
    p.set('prompt', 'consent select_account');
  }
  return `${AUTH_URL}?${p}`;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
}

async function postToken(params: Record<string, string>): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, { method: 'POST', body: new URLSearchParams(params) });
  } catch (err) {
    throw new GoogleError(`Google's token endpoint did not answer: ${(err as Error).message}`, undefined);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code = String(body.error ?? res.status);
    throw new GoogleError(`Google refused the token request: ${code}${body.error_description ? ` (${body.error_description})` : ''}`, res.status, code === 'invalid_grant');
  }
  return body as unknown as TokenResponse;
}

export function exchangeCode(config: Config, code: string, verifier: string): Promise<TokenResponse> {
  return postToken({
    code,
    code_verifier: verifier,
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
    redirect_uri: redirectUri(config),
    grant_type: 'authorization_code',
  });
}

/**
 * The email in an ID token that came straight from Google's token endpoint over TLS.
 * OpenID Connect Core 3.1.3.7 lets a client skip the signature check for a token received
 * that way; the claims are still checked.
 */
export function emailFromIdToken(config: Config, idToken: string, now: number): string {
  const part = idToken.split('.')[1];
  if (!part) throw new Error('Google returned a malformed ID token');
  const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
  if (claims.iss !== 'https://accounts.google.com' && claims.iss !== 'accounts.google.com') throw new Error(`ID token issuer is ${String(claims.iss)}`);
  if (claims.aud !== config.googleClientId) throw new Error('ID token was issued to a different client');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < now) throw new Error('ID token has expired');
  if (claims.email_verified !== true || typeof claims.email !== 'string') throw new Error('Google did not return a verified email');
  return claims.email.toLowerCase();
}

// ---- access tokens per channel ----------------------------------------------------------

const accessTokens = new Map<string, { token: string; expiresAt: number }>();

export function forgetAccessToken(channelId: string): void {
  accessTokens.delete(channelId);
}

export async function accessTokenFor(config: Config, db: DB, channelId: string): Promise<string> {
  const cached = accessTokens.get(channelId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const row = db.prepare('SELECT refresh_token, state, title FROM channels WHERE channel_id = ?').get(channelId) as
    | { refresh_token: string; state: string; title: string }
    | undefined;
  if (!row) throw new GoogleError(`channel ${channelId} is not connected to the scheduler`, 400);
  if (row.state === 'reconnect') throw new GoogleError(`channel "${row.title}" needs reconnecting on the setup page`, 401, true);
  try {
    const t = await postToken({
      refresh_token: row.refresh_token,
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      grant_type: 'refresh_token',
    });
    accessTokens.set(channelId, { token: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 });
    return t.access_token;
  } catch (err) {
    if (err instanceof GoogleError && err.needsReconnect) {
      db.prepare("UPDATE channels SET state = 'reconnect', last_error = ? WHERE channel_id = ?").run(err.message, channelId);
      throw new GoogleError(`channel "${row.title}" needs reconnecting on the setup page (${err.message})`, 401, true);
    }
    throw err;
  }
}

// ---- YouTube ----------------------------------------------------------------------------

async function yt(token: string, method: 'GET' | 'PUT', path: string, body?: unknown): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${YT}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new GoogleError(`YouTube did not answer: ${(err as Error).message}`, undefined);
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const e = json.error as { message?: string; errors?: { reason?: string }[] } | undefined;
    const reason = e?.errors?.[0]?.reason;
    throw new GoogleError(`YouTube ${method} ${path.split('?')[0]} failed (${res.status}${reason ? ` ${reason}` : ''}): ${e?.message ?? 'no message'}`, res.status);
  }
  return json;
}

export async function myChannel(token: string): Promise<{ id: string; title: string }> {
  const json = await yt(token, 'GET', '/channels?part=snippet&mine=true');
  const item = (json.items as { id: string; snippet: { title: string } }[] | undefined)?.[0];
  if (!item) throw new GoogleError('that Google account has no YouTube channel', 400);
  return { id: item.id, title: item.snippet.title };
}

export interface VideoInfo {
  id: string;
  channelId: string;
  title: string;
  status: Record<string, unknown>;
}

/** The video as its owner's token sees it, or null when this token cannot see it. */
export async function getVideo(token: string, videoId: string): Promise<VideoInfo | null> {
  const json = await yt(token, 'GET', `/videos?part=snippet,status&id=${encodeURIComponent(videoId)}`);
  const item = (json.items as { id: string; snippet: { channelId: string; title: string }; status: Record<string, unknown> }[] | undefined)?.[0];
  if (!item) return null;
  return { id: item.id, channelId: item.snippet.channelId, title: item.snippet.title, status: item.status };
}

export async function updateStatus(token: string, videoId: string, status: Record<string, unknown>): Promise<void> {
  await yt(token, 'PUT', '/videos?part=status', { id: videoId, status });
}
