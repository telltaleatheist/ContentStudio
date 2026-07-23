/**
 * Analytics Ingest Server
 *
 * Localhost-only HTTP server (bound to 127.0.0.1, never 0.0.0.0) that the
 * companion browser extension posts YouTube Studio analytics to.
 *
 * Endpoints:
 *   GET  /health            -> 200 {"ok":true,"app":"contentstudio"}   (no auth)
 *   POST /analytics/videos  -> body {videos: VideoRecord[]}   -> upsert, 200 {accepted:N}
 *   POST /analytics/ingest  -> body {snapshots: Snapshot[]}   -> validate+append, 200 {accepted:N}
 *
 * Auth: Bearer token (Authorization: Bearer <token>) on the POST endpoints.
 * The token is auto-generated (crypto.randomBytes hex) on first run and
 * persisted at <analytics dir>/ingest-token.
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

export const DEFAULT_INGEST_PORT = 43117;
const MAX_BODY_BYTES = 20 * 1024 * 1024; // 20 MB — a full back-catalog batch fits comfortably

export interface IngestServerStatus {
  running: boolean;
  port: number;
  error: string | null;      // e.g. "Port 43117 is already in use" — surfaced via IPC
  lastIngestAt: string | null;
}

export class IngestServerService {
  private server: http.Server | null = null;
  private store: AnalyticsStoreService;
  private token: string;
  private port: number;
  private status: IngestServerStatus;

  constructor(store: AnalyticsStoreService, port: number) {
    this.store = store;
    this.port = port;
    this.token = this.loadOrCreateToken();
    this.status = { running: false, port, error: null, lastIngestAt: null };
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

  private isAuthorized(req: http.IncomingMessage): boolean {
    const header = req.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      return false;
    }
    const presented = header.slice('Bearer '.length).trim();
    const expected = Buffer.from(this.token);
    const actual = Buffer.from(presented);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = (req.url || '').split('?')[0];

    if (req.method === 'GET' && url === '/health') {
      this.sendJson(res, 200, { ok: true, app: 'contentstudio' });
      return;
    }

    if (req.method === 'POST' && (url === '/analytics/videos' || url === '/analytics/ingest')) {
      if (!this.isAuthorized(req)) {
        this.sendJson(res, 401, { error: 'Missing or invalid bearer token' });
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
