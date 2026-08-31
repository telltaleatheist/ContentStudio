/**
 * Spreaker API Client
 *
 * The one call this app makes to Spreaker: create an episode on a show, with its audio.
 *
 * `POST https://api.spreaker.com/v2/shows/{SHOW_ID}/episodes`, `multipart/form-data`,
 * `Authorization: Bearer <token>`. The full API notes — auth model, every parameter, the
 * response envelope, the limits and where each fact was read — live in the header of
 * electron/services/publish/spreaker-push.ts, next to the rules that act on them. This
 * file is the transport and nothing else: it decides no policy, validates no file and
 * reads no record.
 *
 * ── Why multipart is written out by hand ─────────────────────────────────────────────
 *
 * The episode audio is up to 300 MB. `FormData` + `fetch` would need the whole file as a
 * Blob or a Buffer in memory, and `form-data` is not a dependency of this app (deps:
 * anthropic, axios, electron-log, electron-store, js-yaml, openai). A multipart body is
 * a preamble, some bytes, and a closing delimiter — so the preamble and the closing are
 * built as Buffers, the file is a read STREAM piped between them, and Content-Length is
 * the arithmetic of the three. Constant memory, no dependency, and a body whose exact
 * bytes are computed by a pure function that can be read against RFC 7578.
 *
 * ── Why nothing here retries ─────────────────────────────────────────────────────────
 *
 * A retry of a CREATE is a second episode in a live podcast feed. Spreaker's own docs
 * warn that exceeding the rate limit can get the IP "temporarily blacklisted", and a
 * timeout on a 132 MB upload says nothing about whether the server finished reading it.
 * Every failure comes back verbatim, with the status code, for a human to decide about.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import * as log from 'electron-log';
import type {
  SpreakerEpisodeCreated,
  SpreakerEpisodeRequest,
  SpreakerUploadApi,
} from '../publish/spreaker-push';
import type { SpreakerCredentials } from './spreaker-config.service';

/** Base URL of the API this client was built against. v2, read 2026-08-22. */
export const SPREAKER_API_BASE = 'https://api.spreaker.com/v2';

/**
 * Content types for the extensions Spreaker accepts.
 *
 * Sent on the file part because a multipart part with no Content-Type defaults to
 * `text/plain`, which is a claim about a 132 MB MP3 that no server should have to
 * disbelieve. An extension not in this table gets `application/octet-stream` — accurate
 * ("bytes"), rather than a guess at which audio format it is.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.3gp': 'audio/3gpp',
  '.amr': 'audio/amr',
  '.asf': 'video/x-ms-asf',
  '.wma': 'audio/x-ms-wma',
  '.ra': 'audio/vnd.rn-realaudio',
};

/** The exact bytes of a multipart body, minus the file's own contents. */
export interface MultipartBody {
  /** Every text field plus the file part's headers — everything before the file bytes. */
  preamble: Buffer;
  /** The closing delimiter — everything after them. */
  closing: Buffer;
  /** The value for the Content-Type request header, boundary included. */
  contentType: string;
  /** preamble + the file's size + closing. */
  contentLength: number;
}

/**
 * A filename as a Content-Disposition parameter can carry it.
 *
 * Quotes are escaped and CR/LF are removed rather than encoded: a newline in a header
 * parameter is a header injection, and there is no filename for which the right answer is
 * to pass one through. Non-ASCII characters are left as UTF-8 bytes, which is what every
 * current server reads them as.
 */
function quoteFilename(name: string): string {
  return name.replace(/[\r\n]/g, '').replace(/"/g, '\\"');
}

/**
 * Build the multipart body for a create-episode request, minus the file's bytes.
 *
 * PURE, and exported for that reason: it is the only place the wire format is decided, so
 * it is the only place that has to be checked against the API docs — and it can be, with
 * no token, no network and no 132 MB file.
 */
export function buildMultipartBody(
  request: SpreakerEpisodeRequest,
  boundary: string,
  fileSize: number
): MultipartBody {
  const parts: Buffer[] = [];

  for (const [name, value] of Object.entries(request.fields)) {
    if (value === undefined) continue;
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
        `${value}\r\n`,
        'utf8'
      )
    );
  }

  const filename = path.basename(request.mediaFilePath);
  const extension = path.extname(filename).toLowerCase();
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="media_file"; filename="${quoteFilename(filename)}"\r\n` +
      `Content-Type: ${CONTENT_TYPES[extension] ?? 'application/octet-stream'}\r\n\r\n`,
      'utf8'
    )
  );

  const preamble = Buffer.concat(parts);
  const closing = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');

  return {
    preamble,
    closing,
    contentType: `multipart/form-data; boundary=${boundary}`,
    contentLength: preamble.length + fileSize + closing.length,
  };
}

/**
 * The episode object out of Spreaker's envelope, reduced to what this app reads.
 *
 * Exported and pure so the response shape is checked against a captured body rather than
 * against a live upload. Everything is defensive about ABSENCE and about nothing else: a
 * field that is missing becomes null and is reported as null, never invented.
 */
export function readEpisodeResponse(body: unknown): SpreakerEpisodeCreated {
  const envelope = body as any;
  const episode = envelope?.response?.episode;
  if (!episode || typeof episode !== 'object') {
    throw new Error(
      `Spreaker's reply had no response.episode in it: ${JSON.stringify(body).slice(0, 400)}`
    );
  }

  const episodeId = Number(episode.episode_id);
  if (!Number.isFinite(episodeId)) {
    throw new Error(
      `Spreaker's reply carried episode_id ${JSON.stringify(episode.episode_id)}, which is ` +
      `not a number.`
    );
  }

  return {
    episodeId,
    title: typeof episode.title === 'string' ? episode.title : null,
    showId: Number.isFinite(Number(episode.show_id)) ? Number(episode.show_id) : null,
    // The show object rides along on a create; when it does not, the caller falls back to
    // the operator's own label for the show (see spreaker-push's receipt).
    showTitle: typeof episode.show?.title === 'string' ? episode.show.title : null,
    siteUrl: typeof episode.site_url === 'string' ? episode.site_url : null,
    encodingStatus: typeof episode.encoding_status === 'string' ? episode.encoding_status : null,
  };
}

/**
 * Spreaker's error envelope as a sentence, or null when the body is not one.
 *
 * `{"response":{"error":{"messages":[…],"code":N}}}`. The messages are Spreaker's own
 * words about what is wrong with the request, and they are the operator's next action —
 * summarising them into "upload failed" would delete the only useful part.
 */
export function readErrorResponse(body: unknown): string | null {
  const error = (body as any)?.response?.error;
  if (!error || typeof error !== 'object') return null;
  const messages = Array.isArray(error.messages)
    ? error.messages.filter((m: unknown) => typeof m === 'string')
    : [];
  const code = typeof error.code === 'number' ? ` (code ${error.code})` : '';
  return messages.length ? `${messages.join('; ')}${code}` : `Spreaker reported an error${code}.`;
}

/** What the client needs to authenticate. Injected so it is re-read on every call. */
export interface SpreakerApiDeps {
  /**
   * Throws, naming what is missing, when the app is not configured.
   *
   * ASYNC because renewing an access token that is close to expiry happens inside it — an
   * upload of a 132 MB file is exactly the wrong place to discover that a token lapsed.
   * A renewal that fails throws here, and the upload never starts.
   */
  requireCredentials: () => Promise<SpreakerCredentials>;
  /** Override for the harness. Defaults to the real v2 base. */
  baseUrl?: string;
}

export class SpreakerApiService implements SpreakerUploadApi, SpreakerScheduleReader {
  private readonly deps: SpreakerApiDeps;
  private readonly baseUrl: string;

  constructor(deps: SpreakerApiDeps) {
    if (!deps || typeof deps.requireCredentials !== 'function') {
      throw new Error(
        'SpreakerApiService requires requireCredentials — credentials are read fresh on ' +
        'every call so a token saved in Settings takes effect without a restart.'
      );
    }
    this.deps = deps;
    this.baseUrl = (deps.baseUrl ?? SPREAKER_API_BASE).replace(/\/$/, '');
  }

  /**
   * Create one episode. One request, no retries, no redirect following.
   *
   * The token is read HERE and nowhere else, and it is never logged: the log line below
   * names the show, the file and its size, which is everything useful about an upload
   * that goes wrong. That read is awaited because it may renew the token first — see
   * SpreakerApiDeps.requireCredentials.
   */
  async createEpisode(request: SpreakerEpisodeRequest): Promise<SpreakerEpisodeCreated> {
    const { accessToken } = await this.deps.requireCredentials();

    const stat = fs.statSync(request.mediaFilePath);
    if (!stat.isFile()) {
      throw new Error(`${request.mediaFilePath} is not a file, so there is nothing to upload.`);
    }

    const boundary = `----ContentStudio${crypto.randomBytes(16).toString('hex')}`;
    const body = buildMultipartBody(request, boundary, stat.size);
    const url = new URL(`${this.baseUrl}/shows/${encodeURIComponent(request.showId)}/episodes`);

    log.info(
      `[Spreaker] POST ${url.pathname} — "${request.fields.title}", ` +
      `${path.basename(request.mediaFilePath)} (${stat.size} bytes)` +
      `${request.fields.auto_published_at ? `, scheduled ${request.fields.auto_published_at} UTC` : ''}`
    );

    const { status, text } = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = https.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || undefined,
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': body.contentType,
            'Content-Length': String(body.contentLength),
            Accept: 'application/json',
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              text: Buffer.concat(chunks).toString('utf8'),
            })
          );
          res.on('error', reject);
        }
      );

      req.on('error', reject);

      req.write(body.preamble);

      const file = fs.createReadStream(request.mediaFilePath);
      // A read error mid-upload aborts the request rather than closing it cleanly: a
      // truncated body that ended at a boundary would be a VALID multipart message with
      // half an episode in it, and Spreaker would have no way to know.
      file.on('error', (err) => {
        req.destroy();
        reject(new Error(`Reading ${request.mediaFilePath} failed mid-upload: ${err.message}`));
      });
      file.on('end', () => req.end(body.closing));
      file.pipe(req, { end: false });
    });

    let parsed: unknown = null;
    if (text.trim()) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // Left null. A non-JSON body is reported as itself below rather than as a parse
        // error about a body the operator cannot see.
        parsed = null;
      }
    }

    if (status < 200 || status >= 300) {
      const detail = (parsed && readErrorResponse(parsed)) ?? text.trim().slice(0, 400);
      const hint =
        status === 401
          ? ' The stored access token was rejected — Spreaker tokens expire. Settings → ' +
            'Spreaker will renew it in one press when a client id, client secret and refresh ' +
            'token are stored; otherwise authorize there again.'
          : status === 404
            ? ` No show ${request.showId} is reachable with this token — check the show id.`
            : status === 429
              ? ' Rate limited. Nothing is retried automatically; wait before trying again.'
              : '';
      throw new Error(
        `Spreaker refused the upload (HTTP ${status}): ${detail || 'no detail given'}.${hint}`
      );
    }

    if (parsed === null) {
      throw new Error(
        `Spreaker returned HTTP ${status} with a body this app could not parse as JSON: ` +
        `${text.trim().slice(0, 400)}. The episode may exist — check the show before ` +
        `uploading again.`
      );
    }

    return readEpisodeResponse(parsed);
  }

  /**
   * Every episode Spreaker itself says is scheduled and not yet out.
   *
   * The read half of this client, and the calendar's Spreaker mirror. `createEpisode`
   * answers "what did this app send"; this answers "what is the show actually holding" —
   * including episodes whose date was changed in Spreaker's own web UI afterwards, which
   * is the case the app cannot otherwise see at all. Its records keep the date they were
   * pushed with, and that date stops being true the moment it is edited over there.
   *
   * `filter=editable` IS THE ONLY ROUTE. Spreaker supports exactly two filters on this
   * endpoint — `listenable` and `editable`, it says so in the 400 it returns for any other
   * — and `listenable` is the public feed, where a scheduled episode does not appear at
   * all. There is no server-side "just the scheduled ones", so the listing is walked.
   *
   * IT STOPS WHEN THE SCHEDULED ONES RUN OUT, not at a date. The listing comes back newest
   * episode first and unpublished episodes are the newest, so a whole page of released
   * episodes means the archive has been reached — normally one or two requests, not a
   * crawl of a show with hundreds of episodes in it. The window is a backstop on that, and
   * `stoppedAt` says which of the three endings happened so the caller can be honest about
   * how complete the answer is. A show holding an OLD episode with a far-future date is
   * the case this misses, and it is missed loudly rather than silently: `dry` names the
   * rule, and it is the reason the calendar's lane says how far it looked.
   *
   * Paged by `last_id` computed here rather than by following the `next_url` Spreaker
   * hands back: the cursor is one number this code already has, and a URL taken from a
   * response is a URL this client would be fetching on someone else's say-so.
   */
  async listScheduledEpisodes(
    showId: string,
    windowSize: number = SPREAKER_SCHEDULE_WINDOW
  ): Promise<SpreakerShowSweep> {
    if (typeof showId !== 'string' || !showId.trim()) {
      throw new Error(`listScheduledEpisodes needs a show id; got ${JSON.stringify(showId)}.`);
    }
    if (!Number.isFinite(windowSize) || windowSize < 1) {
      throw new Error(
        `listScheduledEpisodes needs a positive window; got ${JSON.stringify(windowSize)}.`
      );
    }
    const { accessToken, showName } = await this.deps.requireCredentials();

    const episodes: SpreakerScheduledEpisode[] = [];
    let scanned = 0;
    let lastId: number | null = null;
    let stoppedAt: 'dry' | 'end' | 'window' = 'window';

    while (scanned < windowSize) {
      const limit = Math.min(SPREAKER_PAGE_SIZE, windowSize - scanned);
      const url = new URL(
        `${this.baseUrl}/shows/${encodeURIComponent(showId.trim())}/episodes`
      );
      url.searchParams.set('filter', 'editable');
      url.searchParams.set('limit', String(limit));
      if (lastId !== null) url.searchParams.set('last_id', String(lastId));

      const page = readEpisodesPage(await this.getJson(url, accessToken));
      episodes.push(...page.episodes);
      scanned += page.count;

      // A short page is the end of the show: Spreaker gave back fewer than it was asked
      // for, so there is nothing behind it at all.
      if (page.count < limit || page.lastId === null) {
        stoppedAt = 'end';
        break;
      }
      // A page with nothing scheduled on it is the released archive. Past this point the
      // read is spending requests on episodes that went out months ago.
      if (page.episodes.length === 0) {
        stoppedAt = 'dry';
        break;
      }
      lastId = page.lastId;
    }

    episodes.sort((a, b) => a.publishAt.localeCompare(b.publishAt));

    log.info(
      `[Spreaker] read show ${showId}: ${episodes.length} scheduled in ${scanned} episodes ` +
      `(stopped at ${stoppedAt})`
    );

    return {
      showId: showId.trim(),
      showName: showName ?? null,
      episodes,
      sweptAt: new Date().toISOString(),
      scanned,
      windowSize,
      stoppedAt,
    };
  }

  /**
   * One authenticated GET, parsed as JSON.
   *
   * Its own small transport rather than axios, for the same reason createEpisode has one:
   * this file speaks https directly and owes no other module a dependency. No retries
   * here either — a failed read leaves the previous answer on the board and says it
   * failed, which is what the calendar's YouTube sweep already does.
   */
  private async getJson(url: URL, accessToken: string): Promise<unknown> {
    const { status, text } = await new Promise<{ status: number; text: string }>(
      (resolve, reject) => {
        const req = https.request(
          {
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || undefined,
            path: `${url.pathname}${url.search}`,
            method: 'GET',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: 'application/json',
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () =>
              resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') })
            );
            res.on('error', reject);
          }
        );
        req.on('error', reject);
        req.end();
      }
    );

    let parsed: unknown = null;
    if (text.trim()) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    if (status < 200 || status >= 300) {
      const detail = (parsed && readErrorResponse(parsed)) ?? text.trim().slice(0, 400);
      const hint =
        status === 401
          ? ' The stored access token was rejected — Spreaker tokens expire. Settings → ' +
            'Spreaker will renew it in one press when a client id, client secret and refresh ' +
            'token are stored; otherwise authorize there again.'
          : status === 404
            ? ` No show ${url.pathname.split('/')[3] ?? ''} is reachable with this token — ` +
              `check the show id in Settings → Spreaker.`
            : status === 429
              ? ' Rate limited. Nothing is retried automatically; wait before trying again.'
              : '';
      throw new Error(
        `Spreaker refused the read (HTTP ${status}): ${detail || 'no detail given'}.${hint}`
      );
    }

    if (parsed === null) {
      throw new Error(
        `Spreaker returned HTTP ${status} with a body this app could not parse as JSON: ` +
        `${text.trim().slice(0, 400)}`
      );
    }
    return parsed;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Reading the show back
//
// `GET /v2/shows/{SHOW_ID}/episodes?filter=editable`, same bearer token as the create.
//
// WHY `filter=editable` AND NOT THE PLAIN LISTING. The plain listing is the PUBLIC feed:
// every item comes back with `published_at` set and `auto_published_at` null, so a
// scheduled episode — the only kind this read exists to find — is absent from it
// entirely. `filter=editable` is the author's view and includes the not-yet-released
// ones. (`filter=unpublished` returns nothing on this account and is not used.)
//
// A SCHEDULED EPISODE IS `published_at === null` AND `auto_published_at` SET. Both halves
// are load-bearing: a null `auto_published_at` on an unpublished episode is a draft with
// no date, and this app never creates one — an episode with no date goes live on contact,
// which is the whole reason spreaker-push demands a date.
//
// `auto_published_at` IS UTC WALL TIME, `YYYY-MM-DD HH:MM:SS`, with no zone marker on it.
// That is the same shape spreaker-push SENDS (see its header), so the round trip is
// symmetrical. It is converted to a real instant here rather than in the renderer,
// because a bare stamp handed to `new Date()` in a browser is parsed as LOCAL time and
// would silently move every episode by the machine's offset.
// ─────────────────────────────────────────────────────────────────────────────────────

/** One episode Spreaker itself says is scheduled and not yet out. */
export interface SpreakerScheduledEpisode {
  episodeId: number;
  title: string;
  /** RFC-3339 instant, converted from Spreaker's UTC wall-clock stamp. */
  publishAt: string;
  /** Spreaker's own stamp, verbatim, for when the exact stored value matters. */
  autoPublishedAt: string;
  siteUrl: string | null;
  /** Whole seconds, from Spreaker's milliseconds. Null when it reports none. */
  durationSec: number | null;
}

/** What one read of the show found, and how far it looked to find it. */
export interface SpreakerShowSweep {
  showId: string;
  showName: string | null;
  episodes: SpreakerScheduledEpisode[];
  sweptAt: string;
  /** How many episodes were actually read. */
  scanned: number;
  /** The cap on that. Returned, not just used — see listScheduledEpisodes. */
  windowSize: number;
  /**
   * Why the read stopped, which is the only honest way to say how complete it is.
   *
   *   dry    — a whole page came back with no scheduled episode on it. The normal ending:
   *            the listing is newest-first and the unpublished block sits at the front of
   *            it, so a page of nothing but released episodes is the archive.
   *   end    — the show ran out of episodes entirely. Complete, with no caveat at all.
   *   window — the cap was reached while episodes were STILL being found. The only one
   *            that means something is missing, and the only one worth saying out loud.
   */
  stoppedAt: 'dry' | 'end' | 'window';
}

/** The narrow read the calendar needs, so it can be bound without the whole client. */
export interface SpreakerScheduleReader {
  listScheduledEpisodes(showId: string, windowSize?: number): Promise<SpreakerShowSweep>;
}

/** Episodes per request. Spreaker's own maximum for this endpoint. */
export const SPREAKER_PAGE_SIZE = 50;
/** How many episodes one sweep will read before it stops and says so. */
export const SPREAKER_SCHEDULE_WINDOW = 200;

/**
 * `2026-09-03 09:00:00` (UTC, as Spreaker stores it) as an RFC-3339 instant.
 *
 * STRICT, AND IT THROWS. A stamp in a shape this does not recognise is a change in the
 * API, and the one thing that must not happen is a guess that lands an episode on the
 * wrong day — the operator reads these dates to decide where the next release goes.
 */
export function utcStampToIso(stamp: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(stamp.trim());
  if (!match) {
    throw new Error(
      `Spreaker returned ${JSON.stringify(stamp)} as an episode's publish time, which is ` +
      `not the "YYYY-MM-DD HH:MM:SS" UTC stamp this reads.`
    );
  }
  const [, y, mo, d, h, mi, s] = match;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
}

/**
 * The scheduled episodes on one page of the author's listing, and the cursor after it.
 *
 * PURE, and exported for the same reason buildMultipartBody is: it is the only place the
 * response shape is interpreted, so it is the only place that has to be checked against
 * the API — and it can be, with no token and no network.
 *
 * `lastId` is the id to page from next, taken from the LAST item on the page whether or
 * not that item was scheduled: the cursor walks the listing, not the subset.
 */
export function readEpisodesPage(body: unknown): {
  episodes: SpreakerScheduledEpisode[];
  count: number;
  lastId: number | null;
} {
  const items = (body as any)?.response?.items;
  if (!Array.isArray(items)) {
    throw new Error(
      `Spreaker's reply had no response.items in it: ${JSON.stringify(body).slice(0, 400)}`
    );
  }

  const episodes: SpreakerScheduledEpisode[] = [];
  let lastId: number | null = null;

  for (const item of items) {
    const episodeId = Number(item?.episode_id);
    if (!Number.isFinite(episodeId)) {
      throw new Error(
        `Spreaker listed an episode whose episode_id is ${JSON.stringify(item?.episode_id)}, ` +
        `which is not a number.`
      );
    }
    lastId = episodeId;

    // Already out, or a draft with no date. Neither is a scheduled release.
    if (item.published_at !== null && item.published_at !== undefined) continue;
    if (typeof item.auto_published_at !== 'string' || !item.auto_published_at.trim()) continue;

    const durationMs = Number(item.duration);
    episodes.push({
      episodeId,
      title: typeof item.title === 'string' ? item.title : `episode ${episodeId}`,
      publishAt: utcStampToIso(item.auto_published_at),
      autoPublishedAt: item.auto_published_at,
      siteUrl: typeof item.site_url === 'string' ? item.site_url : null,
      durationSec: Number.isFinite(durationMs) ? Math.round(durationMs / 1000) : null,
    });
  }

  return { episodes, count: items.length, lastId };
}
