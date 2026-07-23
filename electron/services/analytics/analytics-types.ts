/**
 * Analytics Types
 *
 * Schema for the YouTube performance-feedback loop. schemaVersion is pinned to 1;
 * every ingested Snapshot must declare it. Counters are LIFETIME-CUMULATIVE at the
 * moment of capture, and `null` always means "not captured" (never 0-as-unknown).
 */

export type MetricSource = 'studio-extension' | 'analytics-api';

export interface ChannelRegistryEntry {
  channelId: string;          // UC... id, user-pasted
  name: string;
  promptSets: string[];       // prompt-set names mapped to this channel (for generation-time insights)
}

export interface VideoRecord {
  videoId: string;
  channelId: string;
  publishedAt: string;        // ISO
  durationSec: number;
  format: 'long' | 'short' | 'live';
  jobId?: string;
  itemIndex?: number;
  titleHistory: Array<{
    title: string;
    from: string;
    to: string | null;        // null = current
    origin: 'upload' | 'manual-edit' | 'ab-rotation' | 'test-compare';
  }>;
}

export interface Snapshot {
  schemaVersion: 1;
  videoId: string;
  channelId: string;
  capturedAt: string;
  source: MetricSource;
  videoAgeHours: number;
  // ALL counters lifetime-cumulative at capture; null = not captured (never 0-as-unknown)
  impressions: number | null;
  impressionsCtr: number | null;      // percent
  views: number;
  watchHours: number;
  avgViewDurationSec: number | null;
  avgPctViewed: number | null;        // percent
  retention: { at30s: number | null; at60s: number | null } | null;
  trafficShare: { browse: number; suggested: number; search: number; external: number; notifications: number; other: number } | null;
  ctrBySource: { browse: number | null; search: number | null; suggested: number | null } | null;
  topSearchTerms: Array<{ term: string; views: number }> | null;
  subsGained: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
}

export interface VideoVerdict {
  videoId: string;
  channelId: string;
  publishedAt: string;
  titles: string[];                   // chronological, from titleHistory
  firstWeek: { impressions: number | null; ctr: number | null; views: number; avgPctViewed: number | null; retention30s: number | null; dominantSource: string } | null;  // null for back-catalog imports with no early snapshots
  lifetime: { impressions: number | null; ctr: number | null; views: number; watchHours: number; subsGained: number | null };
  ctrPercentile: number | null;       // within-channel, age-matched cohort
  retentionPercentile: number | null;
  packagingScore: number | null;      // mean of ctrPercentile and retentionPercentile
  outcome: 'overperformed' | 'typical' | 'underperformed';   // >=80th / middle / <=20th by packagingScore
  abTest: { variants: string[]; winner: string; method: 'test-compare' | 'rotation'; liftPct: number } | null;
  topSearchTerms: string[];
}

export interface VideoVerdictSummary { title: string; ctr: number | null; ctrPercentile: number | null; retention30s: number | null; views: number; }

export interface ChannelInsights {
  channelId: string;
  computedAt: string;
  videoCount: number;
  baselines: { medianCtrFirstWeek: number | null; medianAvgPctViewed: number | null; medianRetention30s: number | null; medianFirstWeekViews: number | null };
  topPackaging: VideoVerdictSummary[];    // ~8 best by packagingScore, recency-weighted (videos <90d old get 2x weight)
  bottomPackaging: VideoVerdictSummary[]; // ~5 worst
  abLearnings: Array<{ variants: string[]; winner: string; liftPct: number }>;
  topSearchTerms: Array<{ term: string; views: number }>;
  aiBrief: string | null;                 // v1: always null (field reserved)
}

export interface CrossChannelInsights {
  computedAt: string;
  channelIds: string[];
  recentOverperformers: Array<{ channelId: string; title: string; packagingScore: number; views: number }>;  // last 90d across channels — percentile-normalized comparison only
  /**
   * risingSearchTerms.trendVsPriorPeriod encoding:
   *   > 0  = ratio of current-90d-window view growth to prior-90d-window growth
   *          (only computed when the prior window had > 0 growth for that term).
   *   -1   = SENTINEL for a NEW term: it gained views this window but had zero
   *          growth in the prior window, so a ratio is undefined.
   * `views` is the current-window cumulative growth for the term.
   * 0 is never used as a value (it would be indistinguishable from "no change").
   */
  risingSearchTerms: Array<{ term: string; views: number; trendVsPriorPeriod: number }>;
  aiBrief: string | null;                 // v1: always null
}

export const ANALYTICS_SCHEMA_VERSION = 1 as const;

/**
 * Thrown when a Snapshot fails validation on ingest. `reasons` lists every failing
 * field so the caller (and the HTTP 400 response) can surface exactly what was wrong.
 * No silent coercion, no defaults for missing data.
 */
export class SnapshotValidationError extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(`Snapshot validation failed: ${reasons.join('; ')}`);
    this.name = 'SnapshotValidationError';
    this.reasons = reasons;
  }
}

/**
 * Thrown when a VideoRecord fails validation on upsert.
 */
export class VideoRecordValidationError extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(`VideoRecord validation failed: ${reasons.join('; ')}`);
    this.name = 'VideoRecordValidationError';
    this.reasons = reasons;
  }
}
