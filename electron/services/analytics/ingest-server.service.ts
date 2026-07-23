/**
 * Analytics Ingest Server
 *
 * Localhost-only HTTP server (bound to 127.0.0.1, never 0.0.0.0) that the
 * companion browser extension posts YouTube Studio analytics to.
 *
 * Endpoints:
 *   GET  /health             -> 200 {"ok":true,"app":"contentstudio"}
 *   GET  /analytics/channels -> 200 {channels: [{channelId,name}]}
 *   POST /analytics/videos   -> body {videos: VideoRecord[]}   -> upsert, 200 {accepted:N}
 *   POST /analytics/ingest   -> body {snapshots: Snapshot[]}   -> validate+append, 200 {accepted:N}
 *
 * Auth: NONE — there is no token to configure. Because the server is bound to
 * 127.0.0.1, the only realistic attacker is a malicious web page the user
 * visits that tries to POST to 127.0.0.1. Such cross-site browser requests
 * ALWAYS carry an `Origin: http(s)://…` header, so /analytics/channels,
 * /analytics/videos and /analytics/ingest reject any request whose Origin
 * starts with http:// or https:// (403) as a zero-config CSRF safeguard.
 * Requests with no Origin (curl / local tools) or a chrome-extension:// Origin
 * (the companion extension) are allowed. GET /health is fully open.
 *
 * A random token is still generated and persisted at <analytics dir>/ingest-token
 * and exposed via getToken() for the ContentStudio frontend to display, but it
 * is VESTIGIAL — no endpoint enforces it.
 *
 * Port: default 43117, overridable via the `analyticsIngestPort` settings key.
 * If the port is already taken the server does NOT silently pick another one —
 * it records an error state that IPC (`analytics-get-ingest-info`) surfaces.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import {
  Snapshot,
  SnapshotValidationError,
  VideoRecord,
  VideoRecordValidationError,
} from './analytics-types';
import { AnalyticsStoreService } from './analytics-store.service';
import { DistillationService } from './distillation.service';

export const DEFAULT_INGEST_PORT = 43117;
const MAX_BODY_BYTES = 20 * 1024 * 1024; // 20 MB — a full back-catalog batch fits comfortably
const REDISTILL_DEBOUNCE_MS = 4000; // let a burst of per-channel ingest batches settle before re-distilling

export interface IngestServerStatus {
  running: boolean;
  port: number;
  error: string | null;      // e.g. "Port 43117 is already in use" — surfaced via IPC
  lastIngestAt: string | null;
}

export class IngestServerService {
  private server: http.Server | null = null;
  private store: AnalyticsStoreService;
  private distillation: DistillationService;
  // Vestigial: kept only so getToken() can feed the ContentStudio frontend's
  // (now cosmetic) token display. No endpoint enforces it — see file header.
  private token: string;
  private port: number;
  private status: IngestServerStatus;
  private redistillTimer: NodeJS.Timeout | null = null;

  constructor(store: AnalyticsStoreService, port: number, distillation: DistillationService) {
    this.store = store;
    this.distillation = distillation;
    this.port = port;
    this.token = this.loadOrCreateToken();
    this.status = { running: false, port, error: null, lastIngestAt: null };
  }

  /**
   * The extension pushes snapshots in per-channel batches. Re-distill once the
   * pushes settle (debounced) so verdicts/insights reflect the new data with no
   * manual "Run Distillation" — a burst of batches coalesces into a single run.
   */
  private scheduleRedistill(): void {
    if (this.redistillTimer) clearTimeout(this.redistillTimer);
    this.redistillTimer = setTimeout(() => {
      this.redistillTimer = null;
      this.distillation.runDistillation().catch((err) => {
        console.error('[IngestServer] auto-distillation after ingest failed:', err);
      });
    }, REDISTILL_DEBOUNCE_MS);
  }

  /**
   * Load the persisted ingest token, generating + persisting one on first run.
   */
  private loadOrCreateToken(): string {
    const tokenPath = path.join(this.store.getBaseDir(), 'ingest-token');
    if (fs.existsSync(tokenPath)) {
      const existing = fs.readFileSync(tokenPath, 'utf-8').trim();
      if (existing.length > 0) {
        return existing;
      }
    }
    const token = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, token, { encoding: 'utf-8', mode: 0o600 });
    console.log('[IngestServer] Generated new ingest token');
    return token;
  }

  /**
   * Returns the vestigial ingest token. Endpoints no longer enforce it; this
   * exists only so IPC can surface it on ContentStudio's Analytics page.
   */
  getToken(): string {
    return this.token;
  }

  getStatus(): IngestServerStatus {
    return { ...this.status };
  }

  /**
   * Start listening on 127.0.0.1:<port>. Resolves once listening; if the port
   * is taken (EADDRINUSE) or any other listen error occurs, the error state is
   * recorded on `status` and the promise resolves (startup continues, the UI
   * surfaces the error via analytics-get-ingest-info).
   */
  start(): Promise<void> {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((error) => {
          // Any handler exception -> 500 with the message, and log it.
          const message = error instanceof Error ? error.message : String(error);
          console.error('[IngestServer] Handler exception:', error);
          if (!res.headersSent) {
            this.sendJson(res, 500, { error: message });
          } else {
            res.end();
          }
        });
      });

      server.on('error', (error: NodeJS.ErrnoException) => {
        const message = error.code === 'EADDRINUSE'
          ? `Port ${this.port} is already in use — analytics ingest server not started`
          : `Ingest server error: ${error.message}`;
        console.error(`[IngestServer] ${message}`);
        this.status = { ...this.status, running: false, error: message };
        this.server = null;
        resolve();
      });

      server.listen(this.port, '127.0.0.1', () => {
        this.server = server;
        this.status = { ...this.status, running: true, error: null };
        console.log(`[IngestServer] Listening on http://127.0.0.1:${this.port}`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        this.status = { ...this.status, running: false };
        this.server = null;
        console.log('[IngestServer] Stopped');
        resolve();
      });
    });
  }

  private sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
          reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      req.on('error', reject);
    });
  }

  /**
   * Zero-config CSRF safeguard for the /analytics/* endpoints.
   *
   * The server is localhost-bound (127.0.0.1), so the only realistic attacker
   * is a malicious web page the user visits that tries to POST to 127.0.0.1.
   * A browser ALWAYS attaches an `Origin: http(s)://…` header to such a
   * cross-site request, so rejecting any http/https Origin blocks the CSRF
   * vector. The companion extension sends `Origin: chrome-extension://…` (or no
   * Origin at all) and local tools (curl) send no Origin — both are allowed.
   *
   * Returns true only when the request looks like a cross-origin WEB request
   * (Origin present and http:// or https://); such requests must be rejected
   * with 403 before their body is read.
   */
  private isCrossOriginWebRequest(req: http.IncomingMessage): boolean {
    const header = req.headers['origin']; // Node lowercases header names, so this is case-insensitive.
    const origin = Array.isArray(header) ? header[0] : header;
    // WHITELIST (not blacklist): allow ONLY the two shapes we actually expect —
    //   (a) no Origin header at all (curl / local tools / the extension SW), or
    //   (b) the companion extension (chrome-extension://…).
    // Everything else is rejected, including the opaque `null` origin that a
    // sandboxed iframe / data: URL sends — otherwise a malicious page could use
    // one to bypass an http(s)-only check. Node only ever exposes one Origin.
    if (typeof origin !== 'string' || origin === '') {
      return false; // no Origin -> allow
    }
    if (origin.toLowerCase().startsWith('chrome-extension://')) {
      return false; // the companion extension -> allow
    }
    return true; // any other Origin (http/https/null/…) -> reject as cross-origin web
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = (req.url || '').split('?')[0];

    if (req.method === 'GET' && url === '/health') {
      this.sendJson(res, 200, { ok: true, app: 'contentstudio' });
      return;
    }

    // The companion extension pulls its channel list from here instead of being
    // configured by hand — the channels ContentStudio already has registered
    // (with OAuth) are the single source of truth. CSRF-guarded like the POSTs.
    if (req.method === 'GET' && url === '/analytics/channels') {
      if (this.isCrossOriginWebRequest(req)) {
        this.sendJson(res, 403, { error: 'cross-origin web requests are not allowed' });
        return;
      }
      const channels = this.store.listChannels().map((c) => ({ channelId: c.channelId, name: c.name }));
      this.sendJson(res, 200, { channels });
      return;
    }

    if (req.method === 'POST' && (url === '/analytics/videos' || url === '/analytics/ingest')) {
      // CSRF guard: reject cross-origin web requests BEFORE reading the body.
      if (this.isCrossOriginWebRequest(req)) {
        this.sendJson(res, 403, { error: 'cross-origin web requests are not allowed' });
        return;
      }

      const rawBody = await this.readBody(req);
      let body: any;
      try {
        body = JSON.parse(rawBody);
      } catch {
        this.sendJson(res, 400, { error: 'Body is not valid JSON', details: [] });
        return;
      }

      try {
        if (url === '/analytics/videos') {
          if (!body || !Array.isArray(body.videos)) {
            this.sendJson(res, 400, { error: 'Body must be {videos: VideoRecord[]}', details: [] });
            return;
          }
          const accepted = await this.store.upsertVideos(body.videos as VideoRecord[]);
          console.log(`[IngestServer] Accepted ${accepted} video record(s)`);
          this.sendJson(res, 200, { accepted });
        } else {
          if (!body || !Array.isArray(body.snapshots)) {
            this.sendJson(res, 400, { error: 'Body must be {snapshots: Snapshot[]}', details: [] });
            return;
          }
          const accepted = await this.store.appendSnapshots(body.snapshots as Snapshot[]);
          this.status = { ...this.status, lastIngestAt: new Date().toISOString() };
          console.log(`[IngestServer] Accepted ${accepted} snapshot(s)`);
          if (accepted > 0) this.scheduleRedistill();
          this.sendJson(res, 200, { accepted });
        }
      } catch (error) {
        if (error instanceof SnapshotValidationError || error instanceof VideoRecordValidationError) {
          console.error(`[IngestServer] Validation failed: ${error.message}`);
          this.sendJson(res, 400, { error: error.name, details: error.reasons });
          return;
        }
        throw error; // handled by the outer catch -> 500
      }
      return;
    }

    this.sendJson(res, 404, { error: `No such endpoint: ${req.method} ${url}` });
  }
}
