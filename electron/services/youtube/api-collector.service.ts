/**
 * YouTube API Collector
 *
 * Orchestrates one collection cycle per channel using the Data + Analytics APIs
 * (via YouTubeApiService) and feeds the analytics store the SAME shapes the
 * browser-extension ingest produces — VideoRecord upserts + lifetime-cumulative
 * Snapshots (source:'analytics-api').
 *
 * Per channel (collectChannel):
 *   1. Catalog sync: full upload list -> VideoRecord upserts. titleHistory
 *      span-merge (in the store) handles renames; origin 'upload' for a video's
 *      first sighting, 'manual-edit' for a changed current title thereafter.
 *   2. Cadence gate: pick the videos DUE this cycle by age tier (see isDue).
 *      A video with no prior analytics-api snapshot is ALWAYS due — this makes
 *      the first-ever run a full back-catalog backfill (one lifetime snapshot
 *      per video) with no special-casing.
 *   3. Fetch metrics ONLY for due videos: core metrics batched across the due
 *      set; traffic-source share, top search terms, and early retention per
 *      video (retention is a per-video Analytics call, so it is deliberately
 *      limited to the due set — never the whole catalog).
 *   4. Map -> Snapshot -> store.appendSnapshots (the store validates).
 *
 * collectAll runs every connected channel with per-channel error isolation
 * (one channel failing NEVER aborts the others — the error is recorded on that
 * channel's result and surfaced), then runs distillation ONCE for the cycle.
 *
 * Scheduling + state (collector-state.json) live in start()/the main process.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Snapshot, VideoRecord } from '../analytics/analytics-types';
import { AnalyticsStoreService } from '../analytics/analytics-store.service';
import { DistillationService } from '../analytics/distillation.service';
import { YouTubeAuthService } from './youtube-auth.service';
import { YouTubeApiService, VideoCatalogEntry } from './youtube-api.service';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Cadence tier boundaries (video age) and the min gap since the last
// analytics-api snapshot required to re-capture within each tier.
const TIER_FRESH_DAYS = 7;    // < 7d: capture every run
const TIER_RECENT_DAYS = 28;  // 7..28d: capture if last api snapshot > 24h
const TIER_MATURE_DAYS = 365; // 28..365d: capture if > 7d ; > 365d: capture if > 30d

const GAP_RECENT_MS = 24 * HOUR_MS;
const GAP_MATURE_MS = 7 * DAY_MS;
const GAP_OLD_MS = 30 * DAY_MS;

// Re-collect only when the last completed run is older than this (startup + interval).
export const COLLECTION_INTERVAL_MS = 6 * HOUR_MS;
// compactOldSnapshots is monthly.
const COMPACT_INTERVAL_MS = 30 * DAY_MS;

export interface ChannelCollectResult {
  channelId: string;
  channelTitle: string;
  videos: number;             // videos in the synced catalog
  snapshotsWritten: number;
  errors: string[];
  durationMs: number;
}

interface ChannelRunState {
  lastRunAt: string | null;
  lastResult: ChannelCollectResult | null;
}

export interface CollectorState {
  lastRunAt: string | null;       // global: last collectAll completion
  lastCompactedAt: string | null;
  channels: Record<string, ChannelRunState>;
}

export class ApiCollectorService {
  private store: AnalyticsStoreService;
  private auth: YouTubeAuthService;
  private api: YouTubeApiService;
  private distillation: DistillationService;
  private statePath: string;

  private running = false; // guards against overlapping cycles

  constructor(
    store: AnalyticsStoreService,
    auth: YouTubeAuthService,
    api: YouTubeApiService,
    distillation: DistillationService,
    stateDir: string
  ) {
    this.store = store;
    this.auth = auth;
    this.api = api;
    this.distillation = distillation;
    this.statePath = path.join(stateDir, 'collector-state.json');
  }

  // ==================== STATE ====================

  getState(): CollectorState {
    if (!fs.existsSync(this.statePath)) {
      return { lastRunAt: null, lastCompactedAt: null, channels: {} };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf-8')) as Partial<CollectorState>;
      return {
        lastRunAt: parsed.lastRunAt ?? null,
        lastCompactedAt: parsed.lastCompactedAt ?? null,
        channels: parsed.channels ?? {},
      };
    } catch {
      // A corrupt state file must not brick collection — treat as fresh state.
      console.warn('[ApiCollector] collector-state.json unreadable; starting from empty state');
      return { lastRunAt: null, lastCompactedAt: null, channels: {} };
    }
  }

  private writeState(state: CollectorState): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2), 'utf-8');
  }

  // ==================== CADENCE ====================

  /**
   * Is this video due for a snapshot this cycle?
   *   - no prior analytics-api snapshot -> ALWAYS (backfill / brand-new video)
   *   - age < 7d           -> every run
   *   - 7d..28d            -> last api snapshot older than 24h
   *   - 28d..365d          -> last api snapshot older than 7d
   *   - > 365d             -> last api snapshot older than 30d
   */
  private isDue(publishedAt: string, lastApiCaptureAt: string | undefined, now: number): boolean {
    if (!lastApiCaptureAt) {
      return true;
    }
    const ageMs = now - Date.parse(publishedAt);
    const sinceLast = now - Date.parse(lastApiCaptureAt);
    const ageDays = ageMs / DAY_MS;

    if (ageDays < TIER_FRESH_DAYS) return true;
    if (ageDays < TIER_RECENT_DAYS) return sinceLast > GAP_RECENT_MS;
    if (ageDays < TIER_MATURE_DAYS) return sinceLast > GAP_MATURE_MS;
    return sinceLast > GAP_OLD_MS;
  }

  /** Per-video latest capturedAt among analytics-api snapshots for a channel. */
  private lastApiCaptureByVideo(channelId: string): Map<string, string> {
    const latest = new Map<string, string>();
    for (const snapshot of this.store.iterateSnapshots(channelId)) {
      if (snapshot.source !== 'analytics-api') continue;
      const prev = latest.get(snapshot.videoId);
      if (!prev || snapshot.capturedAt > prev) {
        latest.set(snapshot.videoId, snapshot.capturedAt);
      }
    }
    return latest;
  }

  // ==================== COLLECT ====================

  /**
   * Collect one channel. NEVER throws — every failure is recorded on
   * result.errors so callers (collectAll, IPC) surface it while other channels
   * continue. A top-level failure (e.g. token revoked) records one error and
   * returns with snapshotsWritten:0.
   */
  async collectChannel(channelId: string): Promise<ChannelCollectResult> {
    const startedAt = Date.now();
    const result: ChannelCollectResult = {
      channelId,
      channelTitle: channelId,
      videos: 0,
      snapshotsWritten: 0,
      errors: [],
      durationMs: 0,
    };

    try {
      // Fail fast (and surface a clean per-channel error) if the channel isn't
      // connected or its refresh token is dead. The API service then manages
      // token refresh internally for every subsequent call.
      await this.auth.getAccessToken(channelId);
      const conn = this.auth.listConnections().find((c) => c.channelId === channelId);
      if (conn) result.channelTitle = conn.channelTitle;

      // 1. Catalog sync -> VideoRecord upserts. Known-vs-new decides the title
      // span origin ('upload' first sight; a later changed title is a rename,
      // which the store's span-merge records as 'manual-edit').
      const catalog = await this.api.listUploads(channelId);
      result.videos = catalog.length;
      const knownIds = new Set(this.store.listVideos(channelId).map((v) => v.videoId));
      const records = catalog.map((v) => this.toVideoRecord(v, channelId, knownIds.has(v.videoId)));
      if (records.length > 0) {
        await this.store.upsertVideos(records);
      }

      // 2. Cadence gate.
      const now = Date.now();
      const lastByVideo = this.lastApiCaptureByVideo(channelId);
      const due = catalog.filter((v) => this.isDue(v.publishedAt, lastByVideo.get(v.videoId), now));
      if (due.length === 0) {
        result.durationMs = Date.now() - startedAt;
        this.recordChannelResult(result);
        console.log(`[ApiCollector] ${channelId}: no videos due this cycle (${catalog.length} in catalog)`);
        return result;
      }

      // 3. Core metrics batched across the due set (chunked inside the API service).
      const core = await this.api.getCoreMetrics(channelId, due);

      // Build a core-only snapshot for EVERY due video first. getCoreMetrics is
      // batched (a handful of calls for the whole catalog), so this captures the
      // entire back-catalog in seconds. A video with no core row (brand new, zero
      // views) still gets a zeroed lifetime snapshot so cadence advances.
      const capturedAt = new Date().toISOString();
      const snapshotByVideo = new Map<string, Snapshot>();
      for (const video of due) {
        const metrics = core.get(video.videoId) ?? null;
        snapshotByVideo.set(
          video.videoId,
          this.buildSnapshot(video, channelId, capturedAt, metrics, null, null, null)
        );
      }

      // Per-video enrichment (traffic share, search terms, retention) is THREE
      // serial API calls each — running it across a full back-catalog would mean
      // tens of thousands of sequential calls and blow the Analytics quota. Enrich
      // only the most-recent ENRICH_PER_RUN due videos this cycle (recent packaging
      // performance is what matters for titling); older videos keep their core
      // snapshot and rotate into enrichment on later cycles as they become due.
      const ENRICH_PER_RUN = 40;
      const toEnrich = [...due]
        .filter((v) => core.get(v.videoId))
        .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
        .slice(0, ENRICH_PER_RUN);
      for (const video of toEnrich) {
        try {
          const metrics = core.get(video.videoId)!;
          const trafficShare = await this.api.getTrafficShare(channelId, video);
          const topSearchTerms = await this.api.getSearchTerms(channelId, video);
          const retention = await this.api.getRetention(channelId, video);
          snapshotByVideo.set(
            video.videoId,
            this.buildSnapshot(video, channelId, capturedAt, metrics, trafficShare, retention, topSearchTerms)
          );
        } catch (error) {
          // Enrichment failure: keep the core snapshot already recorded for this video.
          result.errors.push(`video ${video.videoId} enrichment: ${this.describe(error)}`);
        }
      }

      const snapshots = [...snapshotByVideo.values()];
      if (snapshots.length > 0) {
        result.snapshotsWritten = await this.store.appendSnapshots(snapshots);
      }
    } catch (error) {
      // Top-level (auth / catalog) failure — isolate to this channel.
      result.errors.push(this.describe(error));
    }

    result.durationMs = Date.now() - startedAt;
    this.recordChannelResult(result);
    return result;
  }

  /**
   * Collect every connected channel (or the one given), with per-channel error
   * isolation, then run distillation ONCE for the whole cycle. Updates
   * collector-state and (monthly) triggers snapshot compaction.
   */
  async collectAll(onlyChannelId?: string): Promise<ChannelCollectResult[]> {
    if (this.running) {
      console.log('[ApiCollector] collectAll skipped — a cycle is already running');
      return [];
    }
    this.running = true;
    try {
      const channelIds = onlyChannelId
        ? [onlyChannelId]
        : this.auth.listConnectedChannelIds();

      const results: ChannelCollectResult[] = [];
      for (const channelId of channelIds) {
        results.push(await this.collectChannel(channelId));
      }

      // Distillation once per cycle (not per channel).
      try {
        await this.distillation.runDistillation();
      } catch (error) {
        console.error('[ApiCollector] Distillation failed:', this.describe(error));
      }

      // Persist global lastRunAt + maybe compact.
      const state = this.getState();
      state.lastRunAt = new Date().toISOString();
      this.writeState(state);
      await this.maybeCompact();

      return results;
    } finally {
      this.running = false;
    }
  }

  // ==================== STARTUP ====================

  /**
   * Data collection is MANUAL only. The user triggers it from the Analytics page
   * ("Refresh data"), which calls collectAll()/collectChannel() over IPC. There
   * is deliberately no automatic run on startup and no background interval —
   * pulling a multi-thousand-video catalog is expensive and should be the user's
   * explicit choice, not a surprise on every launch. (Snapshot compaction still
   * piggybacks on a manual refresh via maybeCompact().)
   *
   * Call once at startup. Its only job: clear the per-channel error list left by
   * a PRIOR session's refresh, so stale failures (e.g. an error from before an
   * API was enabled) don't linger on screen as if they were current. Historical
   * counts and all collected data on disk are left untouched; errors reflect
   * only the refreshes done in the current session.
   */
  clearStaleErrors(): void {
    const state = this.getState();
    let changed = false;
    for (const ch of Object.values(state.channels)) {
      if (ch.lastResult && ch.lastResult.errors.length > 0) {
        ch.lastResult.errors = [];
        changed = true;
      }
    }
    if (changed) this.writeState(state);
  }

  private async maybeCompact(): Promise<void> {
    const state = this.getState();
    const last = state.lastCompactedAt ? Date.parse(state.lastCompactedAt) : 0;
    if (Date.now() - last < COMPACT_INTERVAL_MS) {
      return;
    }
    try {
      const compacted = await this.store.compactOldSnapshots();
      state.lastCompactedAt = new Date().toISOString();
      this.writeState(state);
      if (compacted.length > 0) {
        console.log(`[ApiCollector] Monthly compaction rewrote ${compacted.length} month file(s)`);
      }
    } catch (error) {
      console.error('[ApiCollector] Compaction failed:', this.describe(error));
    }
  }

  // ==================== MAPPING ====================

  private toVideoRecord(video: VideoCatalogEntry, channelId: string, known: boolean): VideoRecord {
    return {
      videoId: video.videoId,
      channelId,
      publishedAt: video.publishedAt,
      durationSec: video.durationSec,
      format: video.format,
      // Present the current title as an open span. First sight -> 'upload'.
      // For a KNOWN video whose title changed, the store closes the old span and
      // appends this one with origin 'manual-edit' (an owner rename observed via
      // the API); when the title is unchanged the origin is ignored by the merge.
      titleHistory: [{
        title: video.title,
        from: video.publishedAt,
        to: null,
        origin: known ? 'manual-edit' : 'upload',
      }],
    };
  }

  /**
   * Build a lifetime-cumulative Snapshot. impressions / impressionsCtr /
   * ctrBySource are ALWAYS null here — they are Studio-only (extension's job).
   */
  private buildSnapshot(
    video: VideoCatalogEntry,
    channelId: string,
    capturedAt: string,
    core: import('./youtube-api.service').CoreMetrics | null,
    trafficShare: Snapshot['trafficShare'],
    retention: Snapshot['retention'],
    topSearchTerms: Snapshot['topSearchTerms']
  ): Snapshot {
    const ageHours = (Date.parse(capturedAt) - Date.parse(video.publishedAt)) / HOUR_MS;
    return {
      schemaVersion: 1,
      videoId: video.videoId,
      channelId,
      capturedAt,
      source: 'analytics-api',
      videoAgeHours: Math.max(0, Math.round(ageHours)),
      impressions: null,       // Studio-only
      impressionsCtr: null,    // Studio-only
      views: core ? core.views : 0,
      watchHours: core ? Math.round((core.estimatedMinutesWatched / 60) * 10) / 10 : 0,
      avgViewDurationSec: core ? core.averageViewDuration : null,
      avgPctViewed: core ? core.averageViewPercentage : null,
      retention,
      trafficShare,
      ctrBySource: null,       // Studio-only
      topSearchTerms,
      subsGained: core ? core.subscribersGained : null,
      likes: core ? core.likes : null,
      comments: core ? core.comments : null,
      shares: core ? core.shares : null,
    };
  }

  // ==================== HELPERS ====================

  private recordChannelResult(result: ChannelCollectResult): void {
    const state = this.getState();
    state.channels[result.channelId] = {
      lastRunAt: new Date().toISOString(),
      lastResult: result,
    };
    this.writeState(state);
  }

  private describe(error: unknown): string {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
}
