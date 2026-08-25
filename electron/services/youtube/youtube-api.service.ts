/**
 * YouTube API Service
 *
 * Thin, typed REST clients (axios) over:
 *   - Data API v3            (https://www.googleapis.com/youtube/v3)
 *   - Analytics API v2       (https://youtubeanalytics.googleapis.com/v2/reports)
 *
 * Every call obtains a fresh access token per channel from YouTubeAuthService
 * (which refreshes when near expiry), so a long collection cycle never dies on a
 * mid-flight token expiry. Errors on 401/403/429 are surfaced as NAMED errors —
 * never silently swallowed. 429 is retried at most ONCE, and only when a
 * Retry-After header tells us how long to wait; otherwise it is thrown.
 *
 * ── Doc-verified facts that shaped this file (developers.google.com) ──────────
 *  • reports.query `ids` for owner reports = "channel==MINE" (the OAuth token
 *    belongs to exactly one brand channel, so MINE is unambiguous).
 *  • dates are YYYY-MM-DD; startDate = the video's publish date so counters are
 *    lifetime-cumulative (matching the Snapshot contract).
 *  • filters=video==ID1,ID2,… accepts UP TO 500 IDs; we chunk well under that.
 *  • insightTrafficSourceType has 21 documented enum values (mapped below).
 *  • the search-terms report (insightTrafficSourceDetail) REQUIRES both a
 *    `sort` value and `maxResults` ≤ 25, plus an insightTrafficSourceType filter.
 *  • the retention report (elapsedVideoTimeRatio) allows only a SINGLE video ID
 *    and returns 100 points, ratio 0.01→1.0 (value = exclusive interval end).
 *  • Data API playlistItems.list caps maxResults at 50 (paginate via pageToken);
 *    videos.list takes a comma id list (50 by convention) and ignores maxResults
 *    when `id` is present.
 *
 * ── Unit conventions (match the browser-extension producer, per the seed) ────
 *  • retention.at30s/at60s and avgPctViewed are stored as PERCENT (0..100).
 *    audienceWatchRatio is a 0..1 fraction, so retention = ratio × 100.
 *  • trafficShare buckets are view-count SHARES summing to ~1 (fractions), as
 *    specified for this collector; dominantSource (its only consumer) is
 *    unit-agnostic so this does not mix units into any percentile cohort.
 */

import axios, { AxiosRequestConfig } from 'axios';
import * as fs from 'fs';
import * as https from 'https';
import { Transform } from 'stream';
import { Snapshot } from '../analytics/analytics-types';
import { YouTubeAuthService } from './youtube-auth.service';

const DATA_API = 'https://www.googleapis.com/youtube/v3';
// Media uploads (thumbnails.set) go to the /upload host, not the plain Data API host.
const UPLOAD_API = 'https://www.googleapis.com/upload/youtube/v3';
const ANALYTICS_API = 'https://youtubeanalytics.googleapis.com/v2/reports';

// filters=video==… allows up to 500 IDs; 200 keeps request URLs comfortably small.
const CORE_METRICS_CHUNK = 200;
// The search-terms report hard-caps maxResults at 25; we want the top ~15.
const SEARCH_TERMS_LIMIT = 15;
// Short heuristic: Shorts can be up to 180s and the API exposes NO explicit flag.
const SHORT_MAX_DURATION_SEC = 180;

/** Thrown on any non-retryable YouTube API failure; `status` carries the HTTP code. */
export class YouTubeApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'YouTubeApiError';
    this.status = status;
  }
}

/** Thrown when a 429 persists (no Retry-After, or a single post-Retry-After retry still 429s). */
export class YouTubeRateLimitError extends YouTubeApiError {
  constructor(message: string) {
    super(message, 429);
    this.name = 'YouTubeRateLimitError';
  }
}

/** One video from the channel's upload catalog. */
export interface VideoCatalogEntry {
  videoId: string;
  title: string;
  publishedAt: string;       // ISO
  durationSec: number;
  format: 'long' | 'short' | 'live';
  isLive: boolean;           // liveStreamingDetails present
}

/**
 * A recent upload with its status fields, used for draft matching.
 *
 * `publishAt` is the load-bearing field: a private video WITH publishAt is scheduled
 * (finished work), a private video WITHOUT one is a true draft.
 */
export interface UploadStatusEntry {
  videoId: string;
  title: string;
  publishedAt: string;
  durationSec: number;
  privacyStatus: string;
  uploadStatus: string;
  publishAt: string | null;
  descriptionLength: number;
  tagCount: number;
  categoryId: string | null;
}

/**
 * A video's `snippet` and `status` parts, exactly as the API returned them.
 *
 * Open records rather than declared fields ON PURPOSE. These objects exist to be handed
 * BACK to videos.update with two or three values changed, and videos.update replaces the
 * whole part: a field this app does not know about (a localization block, a field Google
 * adds next year) has to survive the round trip, and it only survives if nothing along
 * the way narrows the object to the fields someone thought to type out.
 */
export interface VideoParts {
  id: string;
  snippet: Record<string, any>;
  status: Record<string, any>;
}

/** Core lifetime metrics for a video (Analytics API). */
export interface CoreMetrics {
  views: number;
  estimatedMinutesWatched: number;
  averageViewDuration: number;      // seconds
  averageViewPercentage: number;    // percent 0..100
  subscribersGained: number;
  likes: number;
  comments: number;
  shares: number;
}

/**
 * Map an insightTrafficSourceType enum value into one of the six Snapshot
 * trafficShare buckets. Anything unmapped/unknown → 'other' (documented).
 * Enum per the Analytics API dimensions reference (21 values).
 */
const TRAFFIC_SOURCE_BUCKET: Record<string, keyof NonNullable<Snapshot['trafficShare']>> = {
  // Browse surfaces (home / subscriptions feed / Shorts feed)
  SUBSCRIBER: 'browse',
  SHORTS: 'browse',
  // Suggested / next-video surfaces
  RELATED_VIDEO: 'suggested',
  END_SCREEN: 'suggested',
  VIDEO_REMIXES: 'suggested',
  SOUND_PAGE: 'suggested',
  ANNOTATION: 'suggested',
  CAMPAIGN_CARD: 'suggested',
  // Search
  YT_SEARCH: 'search',
  HASHTAGS: 'search',
  // External / embeds
  EXT_URL: 'external',
  NO_LINK_EMBEDDED: 'external',
  NO_LINK_OTHER: 'external',
  // Notifications
  NOTIFICATION: 'notifications',
  // Everything else -> other (PLAYLIST, YT_CHANNEL, YT_OTHER_PAGE, PRODUCT_PAGE,
  // ADVERTISING, PROMOTED, LIVE_REDIRECT, + any future/unknown value)
};

function bucketFor(type: string): keyof NonNullable<Snapshot['trafficShare']> {
  return TRAFFIC_SOURCE_BUCKET[type] ?? 'other';
}

/** YYYY-MM-DD (UTC) for an ISO timestamp. */
function dateOnly(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/** Today's date (UTC), YYYY-MM-DD. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Parse an ISO 8601 duration (e.g. "PT1H2M3S", "PT45S", "P0D") to seconds.
 * Live/upcoming items can report "P0D" -> 0.
 */
export function parseIsoDuration(iso: string | undefined): number {
  if (!iso) return 0;
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso);
  if (!m) return 0;
  const [, d, h, min, s] = m;
  return (Number(d || 0) * 86400) + (Number(h || 0) * 3600) + (Number(min || 0) * 60) + Number(s || 0);
}

/** Classify format from duration + live flag. 'short' is a <=180s HEURISTIC. */
export function classifyFormat(durationSec: number, isLive: boolean): 'long' | 'short' | 'live' {
  if (isLive) return 'live';
  if (durationSec > 0 && durationSec <= SHORT_MAX_DURATION_SEC) return 'short';
  return 'long';
}

export class YouTubeApiService {
  private auth: YouTubeAuthService;

  constructor(auth: YouTubeAuthService) {
    this.auth = auth;
  }

  // ==================== HTTP CORE ====================

  private async request<T>(config: AxiosRequestConfig, retriedAfterRateLimit = false): Promise<T> {
    try {
      const resp = await axios.request<T>({ ...config, timeout: 30000 });
      return resp.data;
    } catch (e) {
      if (!axios.isAxiosError(e) || !e.response) {
        throw new YouTubeApiError(e instanceof Error ? e.message : String(e));
      }
      const status = e.response.status;
      const apiError = (e.response.data as any)?.error;
      const reason = apiError?.errors?.[0]?.reason || apiError?.status;
      const detail = apiError?.message || reason || e.message;

      if (status === 429 || reason === 'rateLimitExceeded' || reason === 'quotaExceeded') {
        const retryAfter = Number(e.response.headers['retry-after']);
        if (!retriedAfterRateLimit && Number.isFinite(retryAfter) && retryAfter > 0) {
          console.warn(`[YouTubeApi] Rate limited; retrying once after ${retryAfter}s`);
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
          return this.request<T>(config, true);
        }
        throw new YouTubeRateLimitError(
          `YouTube API rate/quota limit hit${reason ? ` (${reason})` : ''}: ${detail}. Try again later.`
        );
      }
      if (status === 401) {
        throw new YouTubeApiError(`YouTube API rejected the access token (401): ${detail}. Reconnect the channel.`, 401);
      }
      if (status === 403) {
        throw new YouTubeApiError(`YouTube API forbidden (403${reason ? `, ${reason}` : ''}): ${detail}.`, 403);
      }
      throw new YouTubeApiError(`YouTube API error (${status}): ${detail}`, status);
    }
  }

  private async dataGet<T>(channelId: string, endpoint: string, params: Record<string, string>): Promise<T> {
    const token = await this.auth.getAccessToken(channelId);
    return this.request<T>({
      method: 'GET',
      url: `${DATA_API}/${endpoint}`,
      params,
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  private async analyticsQuery(
    channelId: string,
    params: Record<string, string>
  ): Promise<{ columns: string[]; rows: any[][] }> {
    const token = await this.auth.getAccessToken(channelId);
    const data = await this.request<any>({
      method: 'GET',
      url: ANALYTICS_API,
      params: { ids: 'channel==MINE', ...params },
      headers: { Authorization: `Bearer ${token}` },
    });
    const columns: string[] = (data.columnHeaders || []).map((c: any) => c.name);
    const rows: any[][] = data.rows || [];
    return { columns, rows };
  }

  /**
   * The original uploaded filename for one video, e.g. `1 - sean duffy.mov`.
   *
   * `videos.list part=fileDetails` — owner-only data, so it needs THIS channel's token.
   * Returns null when the video is not visible to this channel (empty items): that is
   * the normal answer when probing "which of my channels owns this videoId", not an
   * error. Contradicts the 2026-07 note that fileName was never returned — that test
   * ran without an owner token; verified live 2026-08-25 on a private draft.
   */
  async getUploadFileName(channelId: string, videoId: string): Promise<string | null> {
    const data = await this.dataGet<any>(channelId, 'videos', {
      part: 'fileDetails',
      id: videoId,
    });
    const item = (data.items || [])[0];
    if (!item) return null; // not this channel's video (or deleted)
    const name = item.fileDetails?.fileName;
    return typeof name === 'string' && name ? name : null;
  }

  // ==================== DATA API: CATALOG ====================

  /** Resolve the channel's uploads playlist id (contentDetails.relatedPlaylists.uploads). */
  private async getUploadsPlaylistId(channelId: string): Promise<string> {
    const data = await this.dataGet<any>(channelId, 'channels', { part: 'contentDetails', mine: 'true' });
    const uploads = data?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) {
      throw new YouTubeApiError(`Could not find the uploads playlist for channel ${channelId}`);
    }
    return uploads;
  }

  /**
   * Full upload catalog: page the uploads playlist (50 at a time) for video IDs,
   * then hydrate durations / publish dates / live flags via videos.list (chunks
   * of 50). Returns one VideoCatalogEntry per uploaded video.
   */
  async listUploads(channelId: string): Promise<VideoCatalogEntry[]> {
    const uploadsPlaylist = await this.getUploadsPlaylistId(channelId);

    // 1. Collect all upload video IDs (paginated).
    const videoIds: string[] = [];
    let pageToken: string | undefined;
    do {
      const params: Record<string, string> = {
        part: 'contentDetails',
        playlistId: uploadsPlaylist,
        maxResults: '50',
      };
      if (pageToken) params.pageToken = pageToken;
      const page = await this.dataGet<any>(channelId, 'playlistItems', params);
      for (const item of page.items || []) {
        const id = item?.contentDetails?.videoId;
        if (id) videoIds.push(id);
      }
      pageToken = page.nextPageToken;
    } while (pageToken);

    // 2. Hydrate in chunks of 50.
    const entries: VideoCatalogEntry[] = [];
    for (let i = 0; i < videoIds.length; i += 50) {
      const chunk = videoIds.slice(i, i + 50);
      const data = await this.dataGet<any>(channelId, 'videos', {
        part: 'contentDetails,snippet,liveStreamingDetails',
        id: chunk.join(','),
      });
      for (const item of data.items || []) {
        const isLive = !!item.liveStreamingDetails;
        const durationSec = parseIsoDuration(item.contentDetails?.duration);
        entries.push({
          videoId: item.id,
          title: item.snippet?.title || item.id,
          publishedAt: item.snippet?.publishedAt || new Date().toISOString(),
          durationSec,
          isLive,
          format: classifyFormat(durationSec, isLive),
        });
      }
    }
    return entries;
  }

  /**
   * The most recent uploads WITH their status fields — what draft matching needs.
   *
   * Deliberately separate from listUploads():
   *  - listUploads pages the entire catalog (thousands of videos per channel); drafts
   *    are always recent, so we stop after `maxVideos`.
   *  - it doesn't request part=status, which is where privacyStatus/publishAt live.
   *
   * Cost is ~1 + 2 + 2 quota units at the default cap.
   *
   * NOTE: `fileDetails.fileName` is NOT requested because YouTube does not populate it
   * (verified live 2026-07-25 — fileName/fileSize come back undefined even when
   * fileDetailsAvailability is 'available'). The original filename is only readable
   * from the Studio DOM, which is the extension's job.
   */
  async listRecentUploads(channelId: string, maxVideos = 100): Promise<UploadStatusEntry[]> {
    const uploadsPlaylist = await this.getUploadsPlaylistId(channelId);

    // playlistItems returns newest-first, so the first pages are the recent uploads.
    const videoIds: string[] = [];
    let pageToken: string | undefined;
    do {
      const params: Record<string, string> = {
        part: 'contentDetails',
        playlistId: uploadsPlaylist,
        maxResults: '50',
      };
      if (pageToken) params.pageToken = pageToken;
      const page = await this.dataGet<any>(channelId, 'playlistItems', params);
      for (const item of page.items || []) {
        const id = item?.contentDetails?.videoId;
        if (id) videoIds.push(id);
      }
      pageToken = page.nextPageToken;
    } while (pageToken && videoIds.length < maxVideos);

    const wanted = videoIds.slice(0, maxVideos);

    const entries: UploadStatusEntry[] = [];
    for (let i = 0; i < wanted.length; i += 50) {
      const chunk = wanted.slice(i, i + 50);
      const data = await this.dataGet<any>(channelId, 'videos', {
        part: 'snippet,status,contentDetails',
        id: chunk.join(','),
      });
      for (const item of data.items || []) {
        entries.push({
          videoId: item.id,
          title: item.snippet?.title || '',
          publishedAt: item.snippet?.publishedAt || '',
          durationSec: parseIsoDuration(item.contentDetails?.duration),
          privacyStatus: item.status?.privacyStatus || 'private',
          uploadStatus: item.status?.uploadStatus || '',
          // Present => the video is SCHEDULED, not a draft. Load-bearing safety signal.
          publishAt: item.status?.publishAt || null,
          descriptionLength: (item.snippet?.description || '').length,
          tagCount: (item.snippet?.tags || []).length,
          categoryId: item.snippet?.categoryId || null,
        });
      }
    }
    return entries;
  }

  // ==================== DATA API: WRITES ====================
  //
  // The three calls the "Push to YouTube" action needs. Everything above this line is a
  // GET; these are the first writes in the file, so read the constraint that governs
  // them before adding a fourth:
  //
  //   videos.update REPLACES the whole submitted part. A `snippet` body carrying only a
  //   title CLEARS the description, the tags and the categoryId of a live video. There
  //   is therefore no "update the title" method here and there never will be — the only
  //   write is updateVideo(), it takes a WHOLE part, and the caller is expected to have
  //   read that part with getVideoParts() first. See publish/youtube-push.ts, which is
  //   the read-modify-write that does it.
  //
  // Quota (verified against Google's docs 2026-08-21): videos.list = 1 unit,
  // videos.update = 50, thumbnails.set = 50, all from the shared 10,000/day pool.

  /**
   * The two mutable parts of a video, EXACTLY as the API returned them.
   *
   * Deliberately untyped record fields rather than a hand-written field list: the whole
   * point of reading this is to hand every field back unchanged, and a typed subset would
   * silently drop whatever the interface's author had not heard of (a new snippet field,
   * a localization block). Anything this object does not carry is a field this app
   * cannot promise to preserve, so it carries all of them.
   */
  async getVideoParts(channelId: string, videoId: string): Promise<VideoParts | null> {
    const data = await this.dataGet<any>(channelId, 'videos', {
      part: 'snippet,status',
      id: videoId,
    });
    const item = data?.items?.[0];
    if (!item) return null;
    if (!item.snippet || !item.status) {
      throw new YouTubeApiError(
        `videos.list returned video ${videoId} without ` +
        `${!item.snippet ? 'a snippet' : 'a status'} part — refusing to update a video ` +
        `whose current values could not be read.`
      );
    }
    return { id: item.id, snippet: item.snippet, status: item.status };
  }

  /**
   * videos.update. `parts` names EVERY part in `body` — the API replaces each named part
   * wholesale with what is sent, and silently ignores a part that is in the body but not
   * in `part=`, which is how a "why did nothing change" bug happens.
   */
  async updateVideo(
    channelId: string,
    parts: Array<'snippet' | 'status'>,
    body: { id: string; snippet?: Record<string, any>; status?: Record<string, any> }
  ): Promise<VideoParts> {
    if (parts.length === 0) {
      throw new YouTubeApiError('updateVideo needs at least one part to update.');
    }
    for (const part of parts) {
      if (!(part in body)) {
        throw new YouTubeApiError(
          `updateVideo was asked to update part "${part}" but the body has no "${part}" — ` +
          `that request would replace the part with nothing.`
        );
      }
    }
    for (const key of Object.keys(body)) {
      if (key !== 'id' && !parts.includes(key as 'snippet' | 'status')) {
        throw new YouTubeApiError(
          `updateVideo body carries "${key}" but part= does not name it, so the API would ` +
          `ignore it and report success. Name it in parts or drop it from the body.`
        );
      }
    }

    const token = await this.auth.getAccessToken(channelId);
    const data = await this.request<any>({
      method: 'PUT',
      url: `${DATA_API}/videos`,
      params: { part: parts.join(',') },
      data: body,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (!data?.id) {
      throw new YouTubeApiError(
        `videos.update for ${body.id} returned no video resource — the write cannot be confirmed.`
      );
    }
    return { id: data.id, snippet: data.snippet || {}, status: data.status || {} };
  }

  /**
   * thumbnails.set — a media upload, so it goes to the /upload endpoint with the image
   * bytes as the raw body (NOT multipart: this endpoint takes media only).
   *
   * Takes the bytes and their mime rather than a path: reading and VALIDATING the file is
   * the caller's job (publish/thumbnail-validate.ts owns every rule about what YouTube
   * will take), and this client has no business deciding a file is good enough.
   */
  async setThumbnail(
    channelId: string,
    videoId: string,
    image: Buffer,
    mime: 'image/png' | 'image/jpeg'
  ): Promise<{ videoId: string; defaultUrl: string | null }> {
    const token = await this.auth.getAccessToken(channelId);
    const data = await this.request<any>({
      method: 'POST',
      url: `${UPLOAD_API}/thumbnails/set`,
      params: { videoId, uploadType: 'media' },
      data: image,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': mime,
        'Content-Length': String(image.length),
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    return { videoId, defaultUrl: data?.items?.[0]?.default?.url ?? null };
  }

  /**
   * Upload one video file: videos.insert over the RESUMABLE protocol.
   *
   * Two requests. (1) POST the metadata to the /upload host with
   * uploadType=resumable, which answers 200 with a session URL in `Location` and no
   * body worth keeping. (2) PUT the file bytes to that URL in one streamed request.
   * A counting Transform between the disk and the wire is what feeds `onProgress` —
   * axios's own progress events are unreliable under Node's adapter.
   *
   * AUDIT GATE: until Google approves the app's API audit, a video uploaded here is
   * LOCKED PRIVATE — it cannot go public even at its scheduled publishAt. Callers own
   * saying so to the operator; this client just does the upload.
   *
   * No mid-stream resume: a failed PUT throws with YouTube's words and the operator
   * runs the upload again (YouTube discards the abandoned session). A silent
   * resume-and-hope here would be a fallback path that only runs when something is
   * already wrong. `signal` aborts both requests and destroys the file stream.
   */
  async insertVideo(
    channelId: string,
    filePath: string,
    body: {
      snippet: { title: string; description: string; tags: string[]; categoryId: string };
      status: { privacyStatus: 'private'; publishAt?: string; selfDeclaredMadeForKids: boolean };
    },
    onProgress?: (sentBytes: number, totalBytes: number) => void,
    signal?: AbortSignal
  ): Promise<{ videoId: string }> {
    const MIME_BY_EXT: Record<string, string> = {
      '.mov': 'video/quicktime', '.mp4': 'video/mp4', '.m4v': 'video/x-m4v',
      '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
      '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg',
    };
    const ext = (filePath.match(/\.[^.]+$/)?.[0] || '').toLowerCase();
    const mime = MIME_BY_EXT[ext];
    if (!mime) {
      throw new YouTubeApiError(
        `"${filePath}" has extension "${ext || '(none)'}", which is not a video type this ` +
        `uploader knows (${Object.keys(MIME_BY_EXT).join(', ')}).`
      );
    }
    const totalBytes = fs.statSync(filePath).size;
    if (totalBytes === 0) throw new YouTubeApiError(`"${filePath}" is empty (0 bytes).`);

    const token = await this.auth.getAccessToken(channelId);

    // (1) Open the resumable session. Plain request(): small, JSON, 30s timeout is right.
    let location: string;
    try {
      const resp = await axios.request({
        method: 'POST',
        url: `${UPLOAD_API}/videos`,
        params: { uploadType: 'resumable', part: 'snippet,status' },
        data: body,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': mime,
          'X-Upload-Content-Length': String(totalBytes),
        },
        timeout: 30000,
        signal,
      });
      const loc = resp.headers['location'];
      if (typeof loc !== 'string' || !loc) {
        throw new YouTubeApiError('videos.insert resumable init returned no Location header.');
      }
      location = loc;
    } catch (e) {
      throw this.asInsertError(e, 'videos.insert (session init)');
    }

    // (2) Stream the bytes — raw node https, NOT axios. axios routes Node request
    // bodies through follow-redirects, which RETAINS every written chunk in memory so
    // it can replay the body after a redirect; on a 1 GB export that retention became a
    // fatal ArrayBuffer allocation in the main process (SIGABRT, crash report read live
    // 2026-08-25). The resumable session URL never redirects, so that machinery buys
    // nothing. streamFileToSession pipes disk -> socket and holds one chunk at a time.
    return streamFileToSession(location, filePath, mime, totalBytes, onProgress, signal);
  }

  /** YouTube's words, verbatim, on a named step — insert bypasses request() for streaming. */
  private asInsertError(e: unknown, step: string): Error {
    if (e instanceof YouTubeApiError) return e;
    if (axios.isAxiosError(e)) {
      const status = e.response?.status ?? null;
      const apiError = (e.response?.data as any)?.error;
      const detail = apiError?.message || apiError?.errors?.[0]?.reason || e.message;
      return new YouTubeApiError(`${step} failed${status ? ` (HTTP ${status})` : ''}: ${detail}`, status);
    }
    return new YouTubeApiError(`${step} failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  /**
   * The categoryId of the channel's most recent upload, or null on a channel with none.
   *
   * videos.insert REQUIRES a categoryId, and this app has no category picker — the
   * honest default is whatever the operator's own latest video uses, read at upload
   * time rather than hard-coded here and drifting from practice.
   */
  async getLatestCategoryId(channelId: string): Promise<string | null> {
    const uploadsId = await this.getUploadsPlaylistId(channelId);
    const page = await this.dataGet<any>(channelId, 'playlistItems', {
      part: 'contentDetails', playlistId: uploadsId, maxResults: '5',
    });
    const ids = (page.items || []).map((i: any) => i.contentDetails?.videoId).filter(Boolean);
    if (!ids.length) return null;
    const vids = await this.dataGet<any>(channelId, 'videos', { part: 'snippet', id: ids.join(',') });
    for (const v of vids.items || []) {
      const cat = v.snippet?.categoryId;
      if (typeof cat === 'string' && cat) return cat;
    }
    return null;
  }

  // ==================== ANALYTICS API: CORE METRICS ====================

  /**
   * Lifetime core metrics for the given videos, batched via
   * dimensions=video & filters=video==id1,id2,… in chunks of CORE_METRICS_CHUNK.
   * startDate = earliest publish date in the chunk (never truncates a video's
   * lifetime). Videos with no analytics data simply don't appear in the map.
   */
  async getCoreMetrics(
    channelId: string,
    videos: Array<{ videoId: string; publishedAt: string }>
  ): Promise<Map<string, CoreMetrics>> {
    const out = new Map<string, CoreMetrics>();
    const end = today();

    for (let i = 0; i < videos.length; i += CORE_METRICS_CHUNK) {
      const chunk = videos.slice(i, i + CORE_METRICS_CHUNK);
      const earliest = chunk.reduce((min, v) => (v.publishedAt < min ? v.publishedAt : min), chunk[0].publishedAt);
      let start = dateOnly(earliest);
      if (start > end) start = end; // clamp (video published "today" edge)

      const { columns, rows } = await this.analyticsQuery(channelId, {
        startDate: start,
        endDate: end,
        dimensions: 'video',
        metrics: 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,likes,comments,shares',
        filters: `video==${chunk.map((v) => v.videoId).join(',')}`,
        maxResults: String(chunk.length),
      });

      const idx = (name: string) => columns.indexOf(name);
      const vi = idx('video');
      for (const row of rows) {
        const videoId = row[vi];
        out.set(videoId, {
          views: Number(row[idx('views')] || 0),
          estimatedMinutesWatched: Number(row[idx('estimatedMinutesWatched')] || 0),
          averageViewDuration: Number(row[idx('averageViewDuration')] || 0),
          averageViewPercentage: Number(row[idx('averageViewPercentage')] || 0),
          subscribersGained: Number(row[idx('subscribersGained')] || 0),
          likes: Number(row[idx('likes')] || 0),
          comments: Number(row[idx('comments')] || 0),
          shares: Number(row[idx('shares')] || 0),
        });
      }
    }
    return out;
  }

  // ==================== ANALYTICS API: PER-VIDEO ====================

  /**
   * Traffic-source SHARES for one video (dimensions=insightTrafficSourceType).
   * Buckets are fractions summing to ~1. Returns null when the video has no
   * traffic-source data (e.g. zero views) — never a zero-filled object.
   */
  async getTrafficShare(
    channelId: string,
    video: { videoId: string; publishedAt: string }
  ): Promise<Snapshot['trafficShare']> {
    let start = dateOnly(video.publishedAt);
    const end = today();
    if (start > end) start = end;

    const { columns, rows } = await this.analyticsQuery(channelId, {
      startDate: start,
      endDate: end,
      dimensions: 'insightTrafficSourceType',
      metrics: 'views',
      filters: `video==${video.videoId}`,
    });
    if (rows.length === 0) return null;

    const ti = columns.indexOf('insightTrafficSourceType');
    const wi = columns.indexOf('views');
    const buckets = { browse: 0, suggested: 0, search: 0, external: 0, notifications: 0, other: 0 };
    let total = 0;
    for (const row of rows) {
      const views = Number(row[wi] || 0);
      total += views;
      buckets[bucketFor(String(row[ti]))] += views;
    }
    if (total <= 0) return null;

    const share = (n: number) => Math.round((n / total) * 10000) / 10000; // 4dp; sum ~1
    return {
      browse: share(buckets.browse),
      suggested: share(buckets.suggested),
      search: share(buckets.search),
      external: share(buckets.external),
      notifications: share(buckets.notifications),
      other: share(buckets.other),
    };
  }

  /**
   * Top search terms for one video (dimensions=insightTrafficSourceDetail with
   * the REQUIRED insightTrafficSourceType==YT_SEARCH filter, sort=-views,
   * maxResults<=25). Returns null when there is no search traffic.
   */
  async getSearchTerms(
    channelId: string,
    video: { videoId: string; publishedAt: string }
  ): Promise<Snapshot['topSearchTerms']> {
    let start = dateOnly(video.publishedAt);
    const end = today();
    if (start > end) start = end;

    const { columns, rows } = await this.analyticsQuery(channelId, {
      startDate: start,
      endDate: end,
      dimensions: 'insightTrafficSourceDetail',
      metrics: 'views',
      filters: `video==${video.videoId};insightTrafficSourceType==YT_SEARCH`,
      sort: '-views',
      maxResults: String(SEARCH_TERMS_LIMIT),
    });
    if (rows.length === 0) return null;

    const di = columns.indexOf('insightTrafficSourceDetail');
    const wi = columns.indexOf('views');
    const terms = rows
      .map((row) => ({ term: String(row[di]), views: Number(row[wi] || 0) }))
      .filter((t) => t.term.length > 0);
    return terms.length > 0 ? terms : null;
  }

  /**
   * Early retention {at30s, at60s} (PERCENT) for one video, derived from the
   * audience-retention curve (dimensions=elapsedVideoTimeRatio,
   * metrics=audienceWatchRatio; single video only). For each mark, the point
   * whose elapsedVideoTimeRatio is nearest mark/durationSec is used.
   * A mark is null when the video is shorter than it; the whole result is null
   * when no curve is available.
   */
  async getRetention(
    channelId: string,
    video: { videoId: string; publishedAt: string; durationSec: number }
  ): Promise<Snapshot['retention']> {
    // Below 30s there is no meaningful 30s (or 60s) mark at all.
    if (video.durationSec < 30) return null;

    let start = dateOnly(video.publishedAt);
    const end = today();
    if (start > end) start = end;

    const { columns, rows } = await this.analyticsQuery(channelId, {
      startDate: start,
      endDate: end,
      dimensions: 'elapsedVideoTimeRatio',
      metrics: 'audienceWatchRatio',
      filters: `video==${video.videoId}`,
    });
    if (rows.length === 0) return null;

    const ri = columns.indexOf('elapsedVideoTimeRatio');
    const ai = columns.indexOf('audienceWatchRatio');
    const points = rows
      .map((row) => ({ ratio: Number(row[ri]), watch: Number(row[ai]) }))
      .filter((p) => Number.isFinite(p.ratio) && Number.isFinite(p.watch));
    if (points.length === 0) return null;

    return {
      at30s: this.retentionAtMark(points, 30, video.durationSec),
      at60s: this.retentionAtMark(points, 60, video.durationSec),
    };
  }

  /** Retention percent at `markSeconds`, nearest curve point; null if video shorter than the mark. */
  private retentionAtMark(
    points: Array<{ ratio: number; watch: number }>,
    markSeconds: number,
    durationSec: number
  ): number | null {
    if (durationSec < markSeconds) return null;
    const target = markSeconds / durationSec; // 0..1
    let best = points[0];
    let bestDist = Math.abs(points[0].ratio - target);
    for (const p of points) {
      const dist = Math.abs(p.ratio - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    // audienceWatchRatio is a 0..1 fraction -> store as PERCENT to match the
    // extension's retention units (keeps within-channel cohorts consistent).
    return Math.round(best.watch * 100 * 10) / 10;
  }
}

/**
 * PUT one file's bytes to a resumable upload session and return the created video id.
 *
 * Standalone and exported so the streaming mechanics can be exercised against a local
 * TLS server in a harness — the app calls it only from insertVideo. NO timeout: a 1 GB
 * .mov takes as long as it takes, and the abort signal is the operator's way out, not a
 * timer's. Memory: fs stream -> counting Transform -> socket, one chunk in flight;
 * nothing retains the body (the reason this is not axios — see insertVideo).
 */
export function streamFileToSession(
  sessionUrl: string,
  filePath: string,
  mime: string,
  totalBytes: number,
  onProgress?: (sentBytes: number, totalBytes: number) => void,
  signal?: AbortSignal
): Promise<{ videoId: string }> {
  let sent = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      sent += chunk.length;
      onProgress?.(sent, totalBytes);
      cb(null, chunk);
    },
  });
  const file = fs.createReadStream(filePath);
  const onAbort = () => file.destroy(new Error('Upload cancelled.'));
  signal?.addEventListener('abort', onAbort, { once: true });

  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const target = new URL(sessionUrl);
    if (target.protocol !== 'https:') {
      reject(new YouTubeApiError(`Resumable session URL is not https (${target.protocol}) — refusing to send bytes.`));
      return;
    }
    const req = https.request(
      {
        method: 'PUT',
        hostname: target.hostname,
        port: target.port ? Number(target.port) : 443,
        path: `${target.pathname}${target.search}`,
        headers: { 'Content-Type': mime, 'Content-Length': totalBytes },
        signal,
      },
      (res) => {
        res.setEncoding('utf8');
        let body = '';
        res.on('data', (c: string) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    // A disk error must kill the request, not leave it waiting for bytes forever.
    file.on('error', (err) => { req.destroy(err); reject(err); });
    counter.on('error', reject);
    file.pipe(counter).pipe(req);
  }).then(({ status, body }) => {
    if (status < 200 || status >= 300) {
      let detail = body.slice(0, 400);
      try { detail = JSON.parse(body)?.error?.message ?? detail; } catch { /* not JSON — keep the raw excerpt */ }
      throw new YouTubeApiError(`videos.insert (byte upload) failed (HTTP ${status}): ${detail}`, status);
    }
    let videoId: unknown;
    try { videoId = JSON.parse(body)?.id; } catch { /* falls through to the named throw */ }
    if (typeof videoId !== 'string' || !videoId) {
      throw new YouTubeApiError('videos.insert finished but returned no video id.');
    }
    return { videoId };
  }).finally(() => {
    signal?.removeEventListener('abort', onAbort);
  });
}
