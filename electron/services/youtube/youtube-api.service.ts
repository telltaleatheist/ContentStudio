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
import { Snapshot } from '../analytics/analytics-types';
import { YouTubeAuthService } from './youtube-auth.service';

const DATA_API = 'https://www.googleapis.com/youtube/v3';
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
