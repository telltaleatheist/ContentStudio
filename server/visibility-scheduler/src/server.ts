// HTTP: the setup page under /scheduler/, the API under /scheduler/api/, and nothing else.
// Anything unknown gets a bare 404, anything unauthenticated a bare 401.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Config } from './config.js';
import type { DB } from './db.js';
import {
  OAUTH_COOKIE,
  SESSION_COOKIE,
  cookieHeader,
  cookies,
  createDeviceKey,
  createSession,
  deviceCaller,
  endSession,
  randomToken,
  revokeDeviceKey,
  webSession,
  type Caller,
} from './auth.js';
import { GoogleError, authorizeUrl, emailFromIdToken, exchangeCode, forgetAccessToken, myChannel, newVerifier } from './google.js';
import { RequestError, videoNotFound, cancelJob, createJob, findVideo, listJobs, patchJob, warningsFor, type JobFilter, type JobState } from './jobs.js';
import { homePage, messagePage, newKeyPage, signInPage, type ChannelRow, type KeyRow } from './page.js';
import { isVideoId, isVisibility, parseRunAt, type Visibility } from './rules.js';

const BODY_LIMIT = 64 * 1024;
const JOB_STATES: JobState[] = ['pending', 'done', 'failed', 'cancelled'];

const BASE_HEADERS: Record<string, string> = {
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'X-Content-Type-Options': 'nosniff',
  // same-origin, not no-referrer: under no-referrer Chrome sends `Origin: null` on the
  // page's own form posts, which the same-origin check below then refuses.
  'Referrer-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

function send(res: ServerResponse, status: number, headers: Record<string, string | string[]>, body = ''): void {
  res.writeHead(status, { ...BASE_HEADERS, ...headers });
  res.end(body);
}
const bare = (res: ServerResponse, status: number) => send(res, status, { 'Content-Type': 'text/plain' });
const json = (res: ServerResponse, status: number, value: unknown) => send(res, status, { 'Content-Type': 'application/json' }, JSON.stringify(value));
const html = (res: ServerResponse, status: number, body: string, extra: Record<string, string | string[]> = {}) =>
  send(res, status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PAGE_CSP, ...extra }, body);
const redirect = (res: ServerResponse, to: string, extra: Record<string, string | string[]> = {}) => send(res, 302, { Location: to, ...extra });

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_LIMIT) throw new RequestError('request body too large', 413);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readBody(req);
  try {
    const value = JSON.parse(text || '{}') as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    /* falls through to the error below */
  }
  throw new RequestError('body must be a JSON object');
}

export interface Runtime {
  lastTick: number | null;
}

export function startServer(config: Config, db: DB, runtime: Runtime): Server {
  const base = new URL(config.baseUrl);
  const prefix = base.pathname; // "/scheduler"

  /** A browser POST must come from the setup page itself. */
  const sameOrigin = (req: IncomingMessage) => req.headers.origin === base.origin || req.headers['sec-fetch-site'] === 'same-origin';

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', base.origin);
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const now = Date.now();

    if (path === '/robots.txt' && method === 'GET') return send(res, 200, { 'Content-Type': 'text/plain' }, 'User-agent: *\nDisallow: /\n');
    if (path !== prefix && !path.startsWith(`${prefix}/`)) return bare(res, 404);
    const rest = path.slice(prefix.length) || '/';

    // ---- API -----------------------------------------------------------------------------
    if (rest.startsWith('/api/')) {
      const caller = deviceCaller(db, req, now) ?? webSession(db, req, now);
      if (!caller) return bare(res, 401);
      if (caller.kind === 'web' && method !== 'GET' && !sameOrigin(req)) return bare(res, 403);
      return api(rest.slice(4), method, url, req, res, caller, now);
    }

    // ---- setup page ----------------------------------------------------------------------
    if (rest === '/' && method === 'GET') {
      const s = webSession(db, req, now);
      if (!s || s.kind !== 'web') return html(res, 200, signInPage(config));
      const channels = db.prepare('SELECT channel_id, title, connected_at, state, last_error FROM channels ORDER BY title').all() as unknown as ChannelRow[];
      const keys = db.prepare('SELECT id, name, created_at, last_used_at, revoked_at FROM device_keys ORDER BY created_at').all() as unknown as KeyRow[];
      return html(res, 200, homePage(config, s.email, channels, keys, listJobs(db, {}), runtime.lastTick));
    }
    if (rest === '/login' && method === 'GET') return startOAuth(res, 'login', now);
    if (rest === '/connect' && method === 'GET') {
      if (!webSession(db, req, now)) return redirect(res, `${config.baseUrl}/`);
      return startOAuth(res, 'connect', now);
    }
    if (rest === '/oauth/callback' && method === 'GET') return oauthCallback(url, req, res, now);

    if (method === 'POST') {
      const s = webSession(db, req, now);
      if (!s || s.kind !== 'web' || !sameOrigin(req)) return bare(res, s ? 403 : 401);
      const form = new URLSearchParams(await readBody(req));
      if (rest === '/logout') {
        endSession(db, req);
        return redirect(res, `${config.baseUrl}/`, { 'Set-Cookie': cookieHeader(SESSION_COOKIE, '', 0, prefix) });
      }
      if (rest === '/keys') {
        const name = (form.get('name') ?? '').trim().slice(0, 60);
        if (!name) return html(res, 400, messagePage(config, 'No name', 'Give the key a name, so you can tell keys apart when revoking one.'));
        return html(res, 200, newKeyPage(config, name, createDeviceKey(db, name, now)));
      }
      let m = /^\/keys\/([\w-]+)\/revoke$/.exec(rest);
      if (m) {
        revokeDeviceKey(db, m[1]!, now);
        return redirect(res, `${config.baseUrl}/`);
      }
      m = /^\/channels\/([\w-]+)\/disconnect$/.exec(rest);
      if (m) {
        const pending = (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE channel_id = ? AND state = 'pending'").get(m[1]!) as { n: number }).n;
        if (pending) return html(res, 409, messagePage(config, 'Not disconnected', `This channel has ${pending} pending change(s). Cancel them first; they could not run without the channel.`));
        db.prepare('DELETE FROM channels WHERE channel_id = ?').run(m[1]!);
        forgetAccessToken(m[1]!);
        return redirect(res, `${config.baseUrl}/`);
      }
    }
    return bare(res, 404);
  };

  function startOAuth(res: ServerResponse, purpose: 'login' | 'connect', now: number) {
    const state = randomToken();
    const browser = randomToken();
    const { verifier, challenge } = newVerifier();
    db.prepare('INSERT INTO oauth_states (state, purpose, verifier, browser, created_at) VALUES (?, ?, ?, ?, ?)').run(state, purpose, verifier, browser, now);
    // The browser cookie ties the callback to the browser that started it (no login CSRF).
    return redirect(res, authorizeUrl(config, purpose, state, challenge), { 'Set-Cookie': cookieHeader(OAUTH_COOKIE, browser, 900, prefix) });
  }

  async function oauthCallback(url: URL, req: IncomingMessage, res: ServerResponse, now: number) {
    const state = url.searchParams.get('state') ?? '';
    const row = db.prepare('SELECT purpose, verifier, browser, created_at FROM oauth_states WHERE state = ?').get(state) as
      | { purpose: 'login' | 'connect'; verifier: string; browser: string; created_at: number }
      | undefined;
    db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);
    const clear = cookieHeader(OAUTH_COOKIE, '', 0, prefix);
    if (!row || row.browser !== cookies(req)[OAUTH_COOKIE] || now - row.created_at > 15 * 60_000) {
      return html(res, 400, signInPage(config, 'That sign-in link is stale or was started in another browser. Try again.'), { 'Set-Cookie': clear });
    }
    const denied = url.searchParams.get('error');
    if (denied) return html(res, 400, messagePage(config, 'Google said no', `Google returned: ${denied}`), { 'Set-Cookie': clear });
    const code = url.searchParams.get('code') ?? '';
    try {
      const tokens = await exchangeCode(config, code, row.verifier);
      if (row.purpose === 'login') {
        if (!tokens.id_token) throw new Error('Google returned no ID token');
        const email = emailFromIdToken(config, tokens.id_token, now);
        if (email !== config.allowedEmail) {
          console.error(`[auth] refused sign-in from ${email}`);
          return html(res, 403, signInPage(config, `${email} is not allowed here.`), { 'Set-Cookie': clear });
        }
        const session = createSession(db, email, now);
        console.log(`[auth] signed in: ${email}`);
        return redirect(res, `${config.baseUrl}/`, { 'Set-Cookie': [clear, cookieHeader(SESSION_COOKIE, session.token, session.maxAgeSeconds, prefix)] });
      }
      // connect: only a signed-in session may add a channel
      if (!webSession(db, req, now)) return redirect(res, `${config.baseUrl}/`, { 'Set-Cookie': clear });
      if (!tokens.refresh_token) throw new Error('Google returned no refresh token, so the scheduler could not act later. Try connecting again.');
      const channel = await myChannel(tokens.access_token);
      db.prepare(
        `INSERT INTO channels (channel_id, title, refresh_token, connected_at, state, last_error) VALUES (?, ?, ?, ?, 'ok', NULL)
         ON CONFLICT (channel_id) DO UPDATE SET title = excluded.title, refresh_token = excluded.refresh_token, connected_at = excluded.connected_at, state = 'ok', last_error = NULL`,
      ).run(channel.id, channel.title, tokens.refresh_token, now);
      forgetAccessToken(channel.id);
      console.log(`[auth] connected channel ${channel.id} "${channel.title}"`);
      return redirect(res, `${config.baseUrl}/`, { 'Set-Cookie': clear });
    } catch (err) {
      console.error(`[auth] ${row.purpose} failed: ${(err as Error).message}`);
      return html(res, 400, messagePage(config, 'That did not work', (err as Error).message), { 'Set-Cookie': clear });
    }
  }

  async function api(route: string, method: string, url: URL, req: IncomingMessage, res: ServerResponse, caller: Caller, now: number) {
    const who = caller.kind === 'device' ? caller.name : 'web';
    if (route === '/health' && method === 'GET') {
      const next = db.prepare("SELECT MIN(run_at) AS t FROM jobs WHERE state = 'pending'").get() as { t: number | null };
      return json(res, 200, {
        ok: runtime.lastTick !== null && now - runtime.lastTick < 120_000,
        lastTick: runtime.lastTick === null ? null : new Date(runtime.lastTick).toISOString(),
        nextDue: next.t === null ? null : new Date(next.t).toISOString(),
        caller: who,
      });
    }
    if (route === '/channels' && method === 'GET') {
      const rows = db.prepare('SELECT channel_id, title, connected_at, state, last_error FROM channels ORDER BY title').all() as unknown as ChannelRow[];
      return json(res, 200, rows.map((c) => ({ channelId: c.channel_id, title: c.title, connectedAt: new Date(c.connected_at).toISOString(), state: c.state, lastError: c.last_error })));
    }
    let m = /^\/video\/([^/]+)$/.exec(route);
    if (m && method === 'GET') {
      if (!isVideoId(m[1])) throw new RequestError('not a YouTube video id');
      const video = await findVideo(config, db, m[1]);
      if (!video) throw videoNotFound(db);
      return json(res, 200, { videoId: video.id, channelId: video.channelId, title: video.title, privacyStatus: video.status.privacyStatus, publishAt: video.status.publishAt ?? null });
    }
    if (route === '/jobs' && method === 'GET') {
      const q = url.searchParams;
      const f: JobFilter = {};
      if (q.get('videoId')) f.videoId = q.get('videoId')!;
      if (q.get('channelId')) f.channelId = q.get('channelId')!;
      const state = q.get('state');
      if (state) {
        if (!JOB_STATES.includes(state as JobState)) throw new RequestError(`state must be one of ${JOB_STATES.join(', ')}`);
        f.state = state as JobState;
      }
      for (const k of ['from', 'to'] as const) {
        const v = q.get(k);
        if (v) {
          const ms = parseRunAt(v);
          if (typeof ms === 'string') throw new RequestError(`${k}: ${ms}`);
          f[k] = ms;
        }
      }
      return json(res, 200, listJobs(db, f));
    }
    if (route === '/jobs' && method === 'POST') {
      const b = await jsonBody(req);
      if (!isVideoId(b.videoId)) throw new RequestError('videoId must be a YouTube video id');
      if (!isVisibility(b.target)) throw new RequestError('target must be public, unlisted or private');
      const runAt = parseRunAt(b.runAt);
      if (typeof runAt === 'string') throw new RequestError(runAt);
      if (b.note !== undefined && typeof b.note !== 'string') throw new RequestError('note must be a string');
      const video = await findVideo(config, db, b.videoId);
      if (!video) throw videoNotFound(db);
      const out = createJob(db, { video, target: b.target, runAt, note: (b.note ?? '').trim().slice(0, 200), createdBy: who }, now);
      console.log(`[api] ${who} scheduled ${video.id} -> ${b.target} at ${out.job.runAt}`);
      return json(res, 201, out);
    }
    m = /^\/jobs\/([\w-]+)$/.exec(route);
    if (m && method === 'PATCH') {
      const b = await jsonBody(req);
      const patch: { target?: Visibility; runAt?: number; note?: string } = {};
      if (b.target !== undefined) {
        if (!isVisibility(b.target)) throw new RequestError('target must be public, unlisted or private');
        patch.target = b.target;
      }
      if (b.runAt !== undefined) {
        const runAt = parseRunAt(b.runAt);
        if (typeof runAt === 'string') throw new RequestError(runAt);
        patch.runAt = runAt;
      }
      if (b.note !== undefined) {
        if (typeof b.note !== 'string') throw new RequestError('note must be a string');
        patch.note = b.note.trim().slice(0, 200);
      }
      const job = patchJob(db, m[1]!, patch, now);
      const video = await findVideo(config, db, job.videoId);
      console.log(`[api] ${who} edited ${job.id}`);
      return json(res, 200, { job, warnings: video ? warningsFor(video, job.target) : [`the video is no longer visible to its channel; this change will fail when it runs`] });
    }
    if (m && method === 'DELETE') {
      const job = cancelJob(db, m[1]!, now);
      console.log(`[api] ${who} cancelled ${job.id}`);
      return json(res, 200, { job });
    }
    return bare(res, 404);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) return res.end();
      if (err instanceof RequestError) return json(res, err.status, { error: err.message });
      if (err instanceof GoogleError) return json(res, 502, { error: err.message });
      console.error('[http]', err);
      return json(res, 500, { error: 'internal error' });
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.listen(config.port, '127.0.0.1', () => console.log(`[http] listening on 127.0.0.1:${config.port} for ${config.baseUrl}`));
  return server;
}
