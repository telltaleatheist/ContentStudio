/**
 * YouTube OAuth Service
 *
 * OAuth 2.0 for **Desktop apps** (installed application flow) against Google,
 * used to authorize each of the user's brand-account YouTube channels for
 * analytics collection (and, later, publishing).
 *
 * Flow (per channel):
 *   1. Load Desktop-app credentials from <userData>/youtube-oauth.json
 *      ({clientId, clientSecret, youtubeApiKey}). Missing file or a leftover
 *      PASTE_ placeholder throws YouTubeCredentialsError with a fix-it message.
 *   2. Generate a PKCE verifier/challenge (S256) and a CSRF `state`.
 *   3. Spin up a one-shot loopback HTTP server on an ephemeral 127.0.0.1 port;
 *      its address IS the redirect_uri (loopback redirects need no pre-registration
 *      for Desktop-app clients).
 *   4. Open Google's consent screen via shell.openExternal. Scopes requested:
 *        - https://www.googleapis.com/auth/youtube            (publish, future)
 *        - https://www.googleapis.com/auth/yt-analytics.readonly (this collector)
 *      access_type=offline + prompt=consent guarantee a refresh_token.
 *   5. Google redirects to the loopback server with ?code=... ; we validate
 *      `state`, exchange the code (+ code_verifier + client_secret) for tokens.
 *   6. channels.list(part=snippet, mine=true) tells us WHICH brand channel the
 *      user picked on Google's account chooser.
 *   7. Persist a per-channel bundle in <userData>/youtube-tokens.json (mode 600),
 *      keyed by channelId, and upsert the channel into the analytics registry
 *      (preserving any existing promptSets mapping).
 *
 * Tokens NEVER leave the main process except via listConnections(), which strips
 * every secret. Credential VALUES are never logged — only field names.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as crypto from 'crypto';
import { AddressInfo } from 'net';
import axios from 'axios';
import { AnalyticsStoreService } from '../analytics/analytics-store.service';
import { ChannelRegistryEntry } from '../analytics/analytics-types';

// Both scopes are requested now: the youtube scope is for the upcoming publish
// feature — requesting it here avoids a second consent for all three channels.
export const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
];

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const CHANNELS_LIST_ENDPOINT = 'https://www.googleapis.com/youtube/v3/channels';

// How long we wait for the user to complete the browser consent before giving up.
// First-run consent for an unverified app is slow: the "Google hasn't verified
// this app" warning, the Advanced expand, and the scope-grant screen can easily
// take several minutes, so keep this generous or the loopback listener closes
// before Google redirects back (ERR_CONNECTION_REFUSED).
const CONSENT_TIMEOUT_MS = 15 * 60 * 1000;
// Refresh the access token this long before its real expiry to avoid races.
const TOKEN_EXPIRY_SKEW_MS = 60 * 1000;

/** Thrown when youtube-oauth.json is missing or still holds PASTE_ placeholders. */
export class YouTubeCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YouTubeCredentialsError';
  }
}

/** Thrown when the OAuth consent/exchange flow fails (denied, timeout, bad state, token error). */
export class YouTubeAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YouTubeAuthError';
  }
}

/** Thrown when an operation needs a channel that has no stored token bundle. */
export class YouTubeNotConnectedError extends Error {
  constructor(channelId: string) {
    super(`Channel ${channelId} is not connected — run Connect Channel first`);
    this.name = 'YouTubeNotConnectedError';
  }
}

/** Desktop-app OAuth client credentials (values NEVER logged). */
export interface YouTubeOAuthCredentials {
  clientId: string;
  clientSecret: string;
  youtubeApiKey: string;
}

/** Per-channel persisted token bundle. Secrets stay in the main process. */
export interface YouTubeTokenBundle {
  channelId: string;
  channelTitle: string;
  refreshToken: string;
  accessToken: string;
  accessTokenExpiry: string; // ISO
  scopes: string[];
  connectedAt: string;       // ISO
}

/** A connection with every secret stripped — safe to hand to the renderer. */
export interface YouTubeConnectionInfo {
  channelId: string;
  channelTitle: string;
  scopes: string[];
  connectedAt: string;
  accessTokenExpiry: string;
}

/** Result of a successful connect: which brand channel the user authorized. */
export interface YouTubeConnectResult {
  channelId: string;
  channelTitle: string;
}

/** base64url of `buf` (no padding) — the encoding PKCE + Google both expect. */
function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Generate a PKCE (S256) verifier + challenge pair. Exported for smoke testing. */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(32)); // 43 chars, within 43..128
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/**
 * Build the Google consent URL. PURE (no I/O) so the smoke test can assert the
 * scopes / PKCE params / loopback redirect without a live flow.
 */
export function buildAuthUrl(params: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scopes?: string[];
}): string {
  const query = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: 'code',
    scope: (params.scopes ?? YOUTUBE_SCOPES).join(' '),
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
    state: params.state,
  });
  return `${AUTH_ENDPOINT}?${query.toString()}`;
}

export class YouTubeAuthService {
  private userDataPath: string;
  private store: AnalyticsStoreService;
  private credsPath: string;
  private tokensPath: string;
  // Serialize token-file mutations so a refresh during a connect can't clobber.
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(userDataPath: string, store: AnalyticsStoreService) {
    this.userDataPath = userDataPath;
    this.store = store;
    this.credsPath = path.join(userDataPath, 'youtube-oauth.json');
    this.tokensPath = path.join(userDataPath, 'youtube-tokens.json');
  }

  private enqueue<T>(task: () => T): Promise<T> {
    const run = this.writeQueue.then(() => task());
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  // ==================== CREDENTIALS ====================

  /**
   * Load + validate the Desktop-app OAuth credentials. Throws
   * YouTubeCredentialsError (with a precise fix-it message) when the file is
   * missing or any required field is empty / still a PASTE_ placeholder.
   * NEVER logs or returns credential values to the caller's logs.
   */
  loadCredentials(): YouTubeOAuthCredentials {
    if (!fs.existsSync(this.credsPath)) {
      throw new YouTubeCredentialsError(
        `YouTube OAuth credentials not found at ${this.credsPath}. Create it with your Google ` +
        `Cloud "Desktop app" OAuth client as {"clientId":"…","clientSecret":"…","youtubeApiKey":"…"}.`
      );
    }
    let parsed: any;
    try {
      parsed = JSON.parse(fs.readFileSync(this.credsPath, 'utf-8'));
    } catch {
      throw new YouTubeCredentialsError(
        `YouTube OAuth credentials file at ${this.credsPath} is not valid JSON — fix or recreate it.`
      );
    }
    const missing: string[] = [];
    for (const field of ['clientId', 'clientSecret', 'youtubeApiKey'] as const) {
      const value = parsed?.[field];
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('PASTE_')) {
        missing.push(field);
      }
    }
    if (missing.length > 0) {
      throw new YouTubeCredentialsError(
        `YouTube OAuth credentials at ${this.credsPath} are incomplete: ${missing.join(', ')} ` +
        `${missing.length === 1 ? 'is' : 'are'} empty or still a PASTE_ placeholder. ` +
        `Fill in the real value(s) from your Google Cloud Desktop-app OAuth client.`
      );
    }
    return { clientId: parsed.clientId, clientSecret: parsed.clientSecret, youtubeApiKey: parsed.youtubeApiKey };
  }

  // ==================== TOKEN STORE ====================

  private readBundles(): Record<string, YouTubeTokenBundle> {
    if (!fs.existsSync(this.tokensPath)) {
      return {};
    }
    try {
      return JSON.parse(fs.readFileSync(this.tokensPath, 'utf-8')) as Record<string, YouTubeTokenBundle>;
    } catch {
      throw new YouTubeAuthError(`youtube-tokens.json at ${this.tokensPath} is corrupt — delete it and reconnect.`);
    }
  }

  private writeBundles(bundles: Record<string, YouTubeTokenBundle>): void {
    fs.writeFileSync(this.tokensPath, JSON.stringify(bundles, null, 2), { encoding: 'utf-8', mode: 0o600 });
    // Ensure mode is 600 even if the file pre-existed with looser perms.
    try { fs.chmodSync(this.tokensPath, 0o600); } catch { /* best-effort on platforms without chmod */ }
  }

  /** channelIds that currently have a token bundle. */
  listConnectedChannelIds(): string[] {
    return Object.keys(this.readBundles());
  }

  /** Connections with secrets stripped — the ONLY shape allowed to reach the renderer. */
  listConnections(): YouTubeConnectionInfo[] {
    return Object.values(this.readBundles()).map((b) => ({
      channelId: b.channelId,
      channelTitle: b.channelTitle,
      scopes: b.scopes,
      connectedAt: b.connectedAt,
      accessTokenExpiry: b.accessTokenExpiry,
    }));
  }

  // ==================== CONNECT ====================

  /**
   * Run the full interactive OAuth flow for one channel. Resolves with the
   * discovered {channelId, channelTitle}. The caller (IPC) surfaces the named
   * error message verbatim on failure. Requires the user to complete Google's
   * consent in the browser — cannot be exercised headlessly.
   */
  async connectChannel(): Promise<YouTubeConnectResult> {
    // Credential check happens FIRST — before any server/browser — so bad creds
    // fail fast with the named error and nothing is opened.
    const creds = this.loadCredentials();
    const { verifier, challenge } = generatePkce();
    const state = base64url(crypto.randomBytes(16));

    const { code, redirectUri } = await this.runLoopbackConsent(creds.clientId, challenge, state);
    const tokens = await this.exchangeCode(creds, code, verifier, redirectUri);
    const channel = await this.discoverChannel(tokens.accessToken);

    const bundle: YouTubeTokenBundle = {
      channelId: channel.channelId,
      channelTitle: channel.channelTitle,
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      accessTokenExpiry: tokens.accessTokenExpiry,
      scopes: tokens.scopes,
      connectedAt: new Date().toISOString(),
    };

    await this.enqueue(() => {
      const bundles = this.readBundles();
      bundles[channel.channelId] = bundle; // reconnect overwrites
      this.writeBundles(bundles);
    });

    await this.upsertRegistry(channel.channelId, channel.channelTitle);

    console.log(`[YouTubeAuth] Connected channel "${channel.channelTitle}" (${channel.channelId})`);
    return { channelId: channel.channelId, channelTitle: channel.channelTitle };
  }

  /**
   * Start a one-shot loopback server, open the consent URL, and resolve with the
   * authorization code once Google redirects back. Rejects on denial, timeout,
   * or state mismatch. The server is always closed before resolving/rejecting.
   */
  private runLoopbackConsent(
    clientId: string,
    codeChallenge: string,
    state: string
  ): Promise<{ code: string; redirectUri: string }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const server = http.createServer();

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        server.close(() => fn());
      };

      const timer = setTimeout(() => {
        finish(() => reject(new YouTubeAuthError('Timed out waiting for Google consent (15 minutes).')));
      }, CONSENT_TIMEOUT_MS);

      server.on('request', (req, res) => {
        const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
        // Ignore favicon / other stray requests the browser may make.
        if (reqUrl.pathname !== '/') {
          res.writeHead(404).end();
          return;
        }
        const params = reqUrl.searchParams;
        const returnedState = params.get('state');
        const error = params.get('error');
        const code = params.get('code');

        const respond = (title: string, body: string) => {
          const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
            `<body style="font-family:-apple-system,system-ui,sans-serif;padding:3rem;text-align:center">` +
            `<h2>${title}</h2><p>${body}</p><p>You can close this window and return to ContentStudio.</p></body></html>`;
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(html);
        };

        if (error) {
          respond('Authorization failed', `Google returned: ${error}`);
          finish(() => reject(new YouTubeAuthError(`Google consent was denied or failed: ${error}`)));
          return;
        }
        if (!returnedState || returnedState !== state) {
          respond('Authorization failed', 'State mismatch — possible CSRF. Please try again.');
          finish(() => reject(new YouTubeAuthError('OAuth state mismatch — aborting for safety.')));
          return;
        }
        if (!code) {
          respond('Authorization failed', 'No authorization code was returned.');
          finish(() => reject(new YouTubeAuthError('No authorization code returned by Google.')));
          return;
        }
        respond('Channel connected', 'ContentStudio has your authorization.');
        finish(() => resolve({ code, redirectUri }));
      });

      server.on('error', (err) => {
        finish(() => reject(new YouTubeAuthError(`Loopback server error: ${err.message}`)));
      });

      // Ephemeral port on loopback only.
      let redirectUri = '';
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as AddressInfo).port;
        redirectUri = `http://127.0.0.1:${port}`;
        const url = buildAuthUrl({ clientId, redirectUri, codeChallenge, state });
        // Lazy-require electron so this module imports cleanly under plain node
        // (the smoke script imports it without an Electron runtime).
        try {
          const { shell } = require('electron');
          shell.openExternal(url);
        } catch (e) {
          finish(() => reject(new YouTubeAuthError(
            `Could not open the browser for consent: ${e instanceof Error ? e.message : String(e)}`
          )));
          return;
        }
        console.log(`[YouTubeAuth] Opened consent screen; awaiting redirect on ${redirectUri}`);
      });
    });
  }

  /** Exchange an authorization code (+ PKCE verifier) for tokens. */
  private async exchangeCode(
    creds: YouTubeOAuthCredentials,
    code: string,
    codeVerifier: string,
    redirectUri: string
  ): Promise<{ accessToken: string; refreshToken: string; accessTokenExpiry: string; scopes: string[] }> {
    const form = new URLSearchParams({
      code,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    });
    let data: any;
    try {
      const resp = await axios.post(TOKEN_ENDPOINT, form.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      data = resp.data;
    } catch (e) {
      throw new YouTubeAuthError(`Token exchange failed: ${this.describeAxiosError(e)}`);
    }
    if (!data.refresh_token) {
      // access_type=offline + prompt=consent should always yield one; if not,
      // surface it rather than silently storing a bundle that can't refresh.
      throw new YouTubeAuthError(
        'Google did not return a refresh token. Revoke ContentStudio access in your Google account, then reconnect.'
      );
    }
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      accessTokenExpiry: new Date(Date.now() + Number(data.expires_in) * 1000).toISOString(),
      scopes: typeof data.scope === 'string' ? data.scope.split(' ') : YOUTUBE_SCOPES,
    };
  }

  /** channels.list(part=snippet, mine=true) to discover the authorized brand channel. */
  private async discoverChannel(accessToken: string): Promise<{ channelId: string; channelTitle: string }> {
    let data: any;
    try {
      const resp = await axios.get(CHANNELS_LIST_ENDPOINT, {
        params: { part: 'snippet', mine: 'true' },
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      data = resp.data;
    } catch (e) {
      throw new YouTubeAuthError(`Could not read the authorized channel: ${this.describeAxiosError(e)}`);
    }
    const item = data?.items?.[0];
    if (!item?.id) {
      throw new YouTubeAuthError(
        'No YouTube channel is associated with the Google account you chose. Pick a brand account with a channel.'
      );
    }
    return { channelId: item.id, channelTitle: item.snippet?.title || item.id };
  }

  /** Upsert the channel into the analytics registry, preserving existing promptSets. */
  private async upsertRegistry(channelId: string, name: string): Promise<void> {
    const channels = this.store.listChannels();
    const existing = channels.find((c) => c.channelId === channelId);
    if (existing) {
      existing.name = name; // refresh the display name; keep promptSets mapping
      await this.store.saveChannels(channels);
      return;
    }
    const entry: ChannelRegistryEntry = { channelId, name, promptSets: [] };
    await this.store.saveChannels([...channels, entry]);
  }

  // ==================== TOKEN LIFECYCLE ====================

  /**
   * Return a currently-valid access token for `channelId`, refreshing it via the
   * refresh_token grant when it is within the skew window of expiry. Throws
   * YouTubeNotConnectedError when the channel has no bundle, or YouTubeAuthError
   * when the refresh token is no longer valid (user must reconnect).
   */
  async getAccessToken(channelId: string): Promise<string> {
    const bundles = this.readBundles();
    const bundle = bundles[channelId];
    if (!bundle) {
      throw new YouTubeNotConnectedError(channelId);
    }
    const expiresAt = Date.parse(bundle.accessTokenExpiry);
    if (Number.isFinite(expiresAt) && expiresAt - TOKEN_EXPIRY_SKEW_MS > Date.now()) {
      return bundle.accessToken;
    }
    return this.refreshAccessToken(channelId);
  }

  private async refreshAccessToken(channelId: string): Promise<string> {
    const creds = this.loadCredentials();
    const bundle = this.readBundles()[channelId];
    if (!bundle) {
      throw new YouTubeNotConnectedError(channelId);
    }
    const form = new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: bundle.refreshToken,
      grant_type: 'refresh_token',
    });
    let data: any;
    try {
      const resp = await axios.post(TOKEN_ENDPOINT, form.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      data = resp.data;
    } catch (e) {
      const detail = this.describeAxiosError(e);
      if (detail.includes('invalid_grant')) {
        throw new YouTubeAuthError(
          `The saved authorization for channel ${channelId} was revoked or expired. Reconnect the channel.`
        );
      }
      throw new YouTubeAuthError(`Token refresh failed for channel ${channelId}: ${detail}`);
    }
    const accessToken = data.access_token as string;
    const updated: YouTubeTokenBundle = {
      ...bundle,
      accessToken,
      accessTokenExpiry: new Date(Date.now() + Number(data.expires_in) * 1000).toISOString(),
      // A refresh response may omit refresh_token; keep the existing one.
      refreshToken: data.refresh_token || bundle.refreshToken,
      scopes: typeof data.scope === 'string' ? data.scope.split(' ') : bundle.scopes,
    };
    await this.enqueue(() => {
      const bundles = this.readBundles();
      bundles[channelId] = updated;
      this.writeBundles(bundles);
    });
    return accessToken;
  }

  // ==================== DISCONNECT ====================

  /**
   * Revoke the channel's refresh token at Google and remove its bundle. Removing
   * the local bundle succeeds even if the network revoke fails (the credential is
   * already useless to us once removed); the revoke error is logged, not thrown.
   */
  async disconnect(channelId: string): Promise<void> {
    const bundle = this.readBundles()[channelId];
    if (!bundle) {
      throw new YouTubeNotConnectedError(channelId);
    }
    try {
      await axios.post(REVOKE_ENDPOINT, new URLSearchParams({ token: bundle.refreshToken }).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      console.log(`[YouTubeAuth] Revoked token for channel ${channelId}`);
    } catch (e) {
      console.warn(`[YouTubeAuth] Revoke request failed for ${channelId} (removing local bundle anyway): ${this.describeAxiosError(e)}`);
    }
    await this.enqueue(() => {
      const bundles = this.readBundles();
      delete bundles[channelId];
      this.writeBundles(bundles);
    });
  }

  /** Compact axios error description WITHOUT ever including credential values. */
  private describeAxiosError(e: unknown): string {
    if (axios.isAxiosError(e)) {
      const status = e.response?.status;
      const err = (e.response?.data as any)?.error;
      const desc = (e.response?.data as any)?.error_description;
      const code = typeof err === 'string' ? err : err?.message || err?.status;
      return [status ? `HTTP ${status}` : null, code, desc].filter(Boolean).join(' — ') || e.message;
    }
    return e instanceof Error ? e.message : String(e);
  }
}
