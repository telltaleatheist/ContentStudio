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
  /** Throws, naming what is missing, when the app is not configured. */
  requireCredentials: () => SpreakerCredentials;
  /** Override for the harness. Defaults to the real v2 base. */
  baseUrl?: string;
}

export class SpreakerApiService implements SpreakerUploadApi {
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
   * that goes wrong.
   */
  async createEpisode(request: SpreakerEpisodeRequest): Promise<SpreakerEpisodeCreated> {
    const { accessToken } = this.deps.requireCredentials();

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
          ? ' The stored access token was rejected — Spreaker tokens expire, so re-mint one ' +
            'through the OAuth2 flow and save it in Settings → Spreaker.'
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
}
