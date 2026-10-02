/**
 * THE ONLY PLACE A CRUCIBLE TOKEN MEETS THE SDK.
 *
 * Ported from Briefcase's backend/src/crucible/client-factory.ts. Every
 * `CrucibleClient` in the main process is built by {@link makeClient} below,
 * and tools/test-crucible-connections.js greps the source to keep it that way.
 * Callers hold a server NAME; the factory reads the token from the registry at
 * call time, so a token never sits in a service field, a cache or a log line,
 * and nothing that answers the renderer can reach it.
 *
 * `clientName` is `contentstudio@<this computer's host name>` on every client
 * ({@link CRUCIBLE_CLIENT_NAME}). It lands in the User-Agent and
 * `X-Crucible-Client`, which is what `/v1/activity` reports as a job's `client`,
 * so a Crucible shared with BookForge, Foundry and Briefcase can say whose work is
 * on the card. Since Crucible 1.0.76 it is also what a QUEUE SESSION is matched
 * on: every request from the client holding the open session is an item of it,
 * header or not (MIGRATION.md, "Same-client membership"). Two installs sharing a
 * name would ride each other's sessions, so the name is unique per install and
 * the same across restarts (Crucible's requirement, LEDGER #255). One name,
 * declared once.
 */
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import { Readable, Transform } from 'stream';
import { API_VERSION, CrucibleClient, SDK_VERSION } from '@crucible/client';
import type { CrucibleServers } from './servers';
import { EngineResolver, type ClientMaker, type ResolvedEngine } from './engine-resolve';

/**
 * `contentstudio@<host>`: the host name lower-cased, macOS's `.local` suffix dropped (it comes and
 * goes with the network on a Mac, and the name must not), and anything outside `[a-z0-9.-]` turned
 * into `-` so it travels in a header unchanged. A host that names nothing is refused by name: a
 * shared name is exactly the failure this exists to prevent.
 */
export function clientNameFor(hostname: string): string {
  const host = hostname.trim().toLowerCase().replace(/\.local$/, '').replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '');
  if (host === '') {
    throw new Error(`This computer's host name (${JSON.stringify(hostname)}) names nothing ContentStudio can use in its Crucible client name, which must be unique per install.`);
  }
  return `contentstudio@${host}`;
}

export const CRUCIBLE_CLIENT_NAME = clientNameFor(os.hostname());

/** Is this client name (as a server reports `client`) THIS install? Exact: another install's ContentStudio is another app. */
export function isOurClient(client: string | null | undefined): boolean {
  return typeof client === 'string' && client.trim() === CRUCIBLE_CLIENT_NAME;
}

export interface ClientOptions {
  /**
   * A deadline on EVERY call the client makes. For probes only: it would also
   * cut off an SSE stream or a long chat, so work clients are built without it.
   */
  timeoutMs?: number;
}

/** The single `new CrucibleClient` in the main process. */
const makeClient: ClientMaker = (url, token, options) =>
  new CrucibleClient({
    url,
    token,
    clientName: CRUCIBLE_CLIENT_NAME,
    ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });

export class CrucibleClientFactory {
  private readonly resolver = new EngineResolver(makeClient);

  constructor(private readonly servers: CrucibleServers) {
    // A removed or re-added server must never be answered from a stale hop.
    servers.onChange((change) => this.resolver.forget(change.server ?? undefined));
  }

  /**
   * A client bound to the ENGINE behind a registered server: the one to send
   * work, settings and activity reads to. Follows an orchestrator's hop once.
   */
  async clientFor(name: string, options?: ClientOptions): Promise<CrucibleClient> {
    return this.resolver.engineClientFor(this.servers.getWithToken(name), options);
  }

  /** The engine a registered address resolves to (cached 60 s). */
  async resolve(name: string): Promise<ResolvedEngine> {
    return this.resolver.resolve(this.servers.getWithToken(name));
  }

  /** A client at the address the user registered, with no hop. For probing that address itself. */
  addressClientFor(name: string, options?: ClientOptions): CrucibleClient {
    const entry = this.servers.getWithToken(name);
    return makeClient(entry.url, entry.token, options);
  }

  /**
   * A client for credentials that are not registered yet: a pairing file, a
   * pasted connect code or an approved device-code pairing, probed BEFORE the
   * registry is written. The credentials come from main's own reads, never
   * from the renderer.
   */
  clientForCredentials(url: string, token: string, options?: ClientOptions): CrucibleClient {
    return makeClient(url, token, options);
  }

  /** Engine resolution for unregistered credentials, uncached. */
  async resolveCredentials(url: string, token: string): Promise<ResolvedEngine> {
    return new EngineResolver(makeClient).resolve({ name: url, url, token });
  }

  /**
   * THE ONE RAW DOOR: an authenticated `fetch` to the ENGINE behind a registered server, for
   * the one route the SDK does not give ContentStudio enough of. Ported from Briefcase's
   * `engineFetch` (client-factory.ts). The SDK's `chatStream()` yields content only and drops
   * `finish_reason` and usage, and a streamed answer's `length` stop is the hard failure LEDGER
   * #112 is built on; so the transport streams the chat door itself (P2) and reaches it here,
   * where the token already lives. The headers are the SDK's own (`#fetch`): the bearer, the
   * API version, the client name in `X-Crucible-Client` and the User-Agent the SDK composes,
   * so a streamed chat is filed under the same client on a shared server's bench. The token is
   * read from the registry at call time and never leaves this method.
   */
  async engineFetch(name: string, path: string, init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; session?: string }): Promise<{ response: Response; url: string }> {
    const entry = this.servers.getWithToken(name);
    const engine = await this.resolver.resolve(entry);
    const headers = new Headers(init.headers ?? {});
    headers.set('User-Agent', `${CRUCIBLE_CLIENT_NAME} crucible-client/${SDK_VERSION}`);
    headers.set('X-Crucible-Client', CRUCIBLE_CLIENT_NAME);
    // The queue session the request is an item of, named as the SDK's CrucibleSession names it,
    // so a session the server has ended answers `409 session_closed` rather than letting the
    // request run as a plain one (session.ts).
    if (init.session !== undefined) headers.set('X-Crucible-Session', init.session);
    headers.set('Authorization', `Bearer ${entry.token}`);
    headers.set('X-Crucible-Api', String(API_VERSION));
    const url = `${engine.url.replace(/\/+$/, '')}${path}`;
    const response = await unclockedFetch(url, { method: init.method, headers, body: init.body, signal: init.signal });
    return { response, url: engine.url };
  }

  /** Drop every cached hop (a keeper, or a Re-check button). */
  forgetResolved(name?: string): void {
    this.resolver.forget(name);
  }
}

/**
 * `fetch` without undici's two 300-second clocks (P8b).
 *
 * Node's fetch ends a response whose body sends no bytes for 300 s (`UND_ERR_BODY_TIMEOUT`) and a
 * request whose headers take 300 s. A thinking-on title (LEDGER #208) on the Mac's 27B streams
 * almost none of its reasoning: measured 2026-09-25, a 400-token thinking answer carried 227
 * characters of it. So a title that thought for five minutes was cut off as "not answering"
 * (twice on the Duffy chapter run), with the server still working and nothing wrong. Silence on a
 * job's stream is the job's stall clock's to judge (10 minutes, P3, electron/crucible/
 * stream-stall.ts), and a caller's own `timeoutMs` is still honoured by the transport; a clock
 * nobody chose is not.
 *
 * Errors keep undici's shape, because transport-failure.ts reads them by it: a request that never
 * got an answer is a TypeError 'fetch failed', a body that died mid-stream a TypeError
 * 'terminated', each with the socket's error as its `cause` (its errno in `cause.code`). An abort
 * is the AbortError Node raises for the signal.
 */
function unclockedFetch(
  url: string,
  init: { method: string; headers: Headers; body?: string; signal?: AbortSignal },
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const headers: Record<string, string> = {};
    init.headers.forEach((value, key) => {
      headers[key] = value;
    });
    if (init.body !== undefined) headers['content-length'] = String(Buffer.byteLength(init.body));
    const wrap = (message: 'fetch failed' | 'terminated', err: unknown): unknown =>
      err instanceof Error && err.name === 'AbortError' ? err : Object.assign(new TypeError(message), { cause: err });
    const request = lib.request(target, { method: init.method, headers, ...(init.signal === undefined ? {} : { signal: init.signal }) }, (res) => {
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      // A body that dies mid-stream surfaces as undici's 'terminated', its errno kept as the cause.
      const body = res.pipe(new Transform({ transform: (chunk, _enc, done) => done(null, chunk) }));
      res.on('error', (err) => body.destroy(wrap('terminated', err) as Error));
      res.on('aborted', () => body.destroy(wrap('terminated', Object.assign(new Error('aborted'), { code: 'ECONNRESET' })) as Error));
      const status = res.statusCode ?? 0;
      const noBody = status === 204 || status === 304 || init.method === 'HEAD';
      resolve(new Response(noBody ? null : (Readable.toWeb(body) as unknown as ReadableStream<Uint8Array>), {
        status,
        statusText: res.statusMessage ?? '',
        headers: responseHeaders,
      }));
    });
    request.on('error', (err) => reject(wrap('fetch failed', err)));
    if (init.body !== undefined) request.write(init.body);
    request.end();
  });
}
