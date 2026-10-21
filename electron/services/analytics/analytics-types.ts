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

/**
 * A video's lifetime counters at one capture. schemaVersion 1 is every snapshot written before
 * extension 0.2.11 (and every analytics-api one); 2 adds the fields of SnapshotV2. The ingest
 * validator checks each version's exact shape.
 */
export type Snapshot = SnapshotV1 | SnapshotV2;

export interface SnapshotV1 extends SnapshotFields {
  schemaVersion: 1;
}

/**
 * Extension 0.2.11+. `engagedViews` is YouTube's ENGAGED_VIEWS: views without the inline
 * Home-feed autoplay previews it has counted as views since 2026-08-27 (see
 * ENGAGED_VIEWS_EQUAL_BEFORE). Money is USD; `cpm` is null where no ads ran.
 */
export interface SnapshotV2 extends SnapshotFields {
  schemaVersion: 2;
  engagedViews: number;
  estimatedEarnings: number | null;
  cpm: number | null;
  subsLost: number | null;
}

/**
 * The day YouTube started counting inline Home-feed autoplay previews as views. Verified live
 * 2026-10-21 against all three channels (Studio yta_web/join, DAY series): EXTERNAL_VIEWS equalled
 * ENGAGED_VIEWS on every channel through 2026-08-26 and ran ~2-2.5x it from 2026-08-27 (main
 * channel BROWSE location: 181 views / 181 engaged on 08-26, 5,276 / 713 on 08-27). So a
 * lifetime count captured before this instant holds only views from before the change, and its
 * views ARE its engaged views — a dated fact, not an estimate. Midnight UTC is still 08-26 in
 * every timezone west of UTC, Studio's and Owen's included.
 */
export const ENGAGED_VIEWS_EQUAL_BEFORE = '2026-08-27T00:00:00.000Z';

interface SnapshotFields {
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

/**
 * A finished, DECIDED A/B title test.
 *
 * Permanent: stored outside verdicts (which are regenerated every distillation) because a
 * concluded experiment is a fact, not a derived value. Undecided tests are never recorded
 * — "the titles performed the same" is not a win, and storing it as one would teach the
 * generator that a coin-flip was a success.
 */
export interface AbTestResult {
  videoId: string;
  channelId: string;
  variants: string[];
  winner: string;
  /** Winner's watch-time share minus the nearest rival's, in percentage points. */
  liftPct: number;
  method: 'test-compare' | 'rotation';
  decidedAt: string;        // ISO
  shares: number[];         // watch-time share per variant, percent
}

export interface VideoVerdict {
  videoId: string;
  channelId: string;
  publishedAt: string;
  titles: string[];                   // chronological, from titleHistory
  firstWeek: { impressions: number | null; ctr: number | null; views: number; avgPctViewed: number | null; retention30s: number | null; dominantSource: string } | null;  // null for back-catalog imports with no early snapshots
  /**
   * `engagedViews`: from the latest SnapshotV2, or from the latest snapshot when it was captured
   * before ENGAGED_VIEWS_EQUAL_BEFORE (its views are its engaged views); null otherwise — a video
   * whose newest counts are from 2026-08-27 on with no V2 snapshot yet.
   */
  lifetime: { impressions: number | null; ctr: number | null; views: number; watchHours: number; subsGained: number | null; engagedViews: number | null };
  /** The video's first seven Studio days (VideoFirstWeek); null until collected. */
  firstSevenDays: {
    firstDay: string;
    views: number;
    engagedViews: number;
    impressions: number | null;
    ctr: number | null;
    avgPctViewed: number | null;
  } | null;
  ctrPercentile: number | null;       // within-channel, age-matched cohort
  retentionPercentile: number | null;
  packagingScore: number | null;      // mean of ctrPercentile and retentionPercentile
  outcome: 'overperformed' | 'typical' | 'underperformed';   // >=80th / middle / <=20th by packagingScore
  abTest: { variants: string[]; winner: string; method: 'test-compare' | 'rotation'; liftPct: number } | null;
  topSearchTerms: string[];
}

/**
 * One video as the insights render shows it. `basis` names the window `ctr`, `avgPctViewed`,
 * `views` and `engagedViews` come from: 'first-week' when the verdict has its first seven
 * Studio days (firstSevenDays), 'lifetime' otherwise (top/bottom packaging are always
 * 'lifetime'). `retention30s` is first-week only, whatever the basis. `ctrPercentile` is
 * always over lifetime CTR. The render compares on `engagedViews`; `views` includes Home-feed
 * autoplay previews from 2026-08-27 and is kept for the record only.
 */
export interface VideoVerdictSummary {
  title: string;
  publishedAt: string;                // ISO, from the verdict
  basis: 'first-week' | 'lifetime';
  ctr: number | null;
  ctrPercentile: number | null;
  avgPctViewed: number | null;
  retention30s: number | null;
  views: number;
  engagedViews: number | null;
}

/** Structural title traits measured against each other in decided A/B tests. */
export type AbTitleTraitId = 'colon' | 'question' | 'digit';

/**
 * A trait whose isolated loss record cleared an evidence band. `lostAlone`/`wonAlone` are
 * carried alongside the directive so the rendered rule can state its own provenance —
 * a rule built on 25 losses must not read like one built on 2.
 */
export interface AbTitleRule {
  id: AbTitleTraitId;
  directive: string;
  lostAlone: number;
  wonAlone: number;
  confidence: 'strong' | 'weak';
}

/** A trait BELOW the weak band: recorded as an observation, never stated as a rule. */
export interface AbTitleRuleObservation {
  id: AbTitleTraitId;
  lostAlone: number;
  wonAlone: number;
}

/** One winning title, with the margin it won by in percentage POINTS of watch-time share. */
export interface AbTitleExemplar {
  winner: string;
  beat: string;
  liftPts: number;
  decidedAt: string;        // YYYY-MM-DD
}

/**
 * Everything the generation prompt is allowed to say about a channel's A/B title tests:
 * a bounded set of threshold-clearing rules plus a CAPPED, lift-ranked exemplar list.
 * Replaces the old unbounded `abLearnings`, which grew one line per test forever and
 * carried no evidence base for anything it showed.
 */
export interface AbTitleRulesDerivation {
  channelId: string;
  channelName: string;
  derivedAt: string;                        // ISO — the "as of" date rendered in the block
  decidedTests: number;
  earliestDecidedAt: string | null;         // YYYY-MM-DD; null only when decidedTests === 0
  latestDecidedAt: string | null;
  rules: AbTitleRule[];
  observations: AbTitleRuleObservation[];
  exemplars: AbTitleExemplar[];
}

export interface ChannelInsights {
  channelId: string;
  computedAt: string;
  videoCount: number;
  /**
   * `medianFirstWeekViews` is raw views from first-week snapshots and is not rendered (raw views
   * doubled from 2026-08-27); `medianFirstWeekEngagedViews` is over firstSevenDays and is.
   */
  baselines: {
    medianCtrFirstWeek: number | null; medianAvgPctViewed: number | null; medianRetention30s: number | null; medianFirstWeekViews: number | null;
    medianFirstWeekEngagedViews: number | null;
  };
  topPackaging: VideoVerdictSummary[];    // ~8 best by packagingScore, recency-weighted (videos <90d old get 2x weight)
  bottomPackaging: VideoVerdictSummary[]; // ~5 worst
  /** Every long/live upload published in the 90 days before computedAt, newest first. */
  recentUploads: VideoVerdictSummary[];
  /** Derived at distillation time from the channel's ab-tests.json — see ab-title-rules.ts. */
  abTitleRules: AbTitleRulesDerivation;
  topSearchTerms: Array<{ term: string; views: number }>;
  aiBrief: string | null;                 // v1: always null (field reserved)
}

/**
 * Model-written title guidelines distilled from a channel's rendered performance block
 * (insights-guidelines.ts). `sourceHash` is the sha256 of the EXACT rendered block the
 * distiller read; generation compares it against the current render and re-distills only
 * when the evidence changed. `lines` are subject-free one-line lessons, each "- "-prefixed.
 */
export interface ChannelGuidelines {
  generatedAt: string;
  /** The provider-prefixed or bare model that wrote the lines, for the record. */
  model: string;
  sourceHash: string;
  lines: string[];
}

export interface CrossChannelInsights {
  computedAt: string;
  channelIds: string[];
  recentOverperformers: Array<{ channelId: string; title: string; packagingScore: number; views: number; engagedViews: number | null }>;  // last 90d across channels — percentile-normalized comparison only
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

/**
 * One source's share of a channel day. `impressions`/`impressionsCtr` are null when Studio
 * returned no impressions value for that source that day (EXT_URL and NOTIFICATION rows often
 * carry none) — null is "not reported", never 0. `views` is 0 when the source had no row.
 */
export interface SourceDay {
  impressions: number | null;
  impressionsCtr: number | null;      // percent
  views: number;
}

/**
 * One channel's totals for one calendar day (Studio's DAY dimension, the channel's own
 * reporting day). Unlike Snapshot these are PER-DAY values, not lifetime-cumulative, and a
 * later collection of the same day REPLACES the stored row (Studio revises recent days).
 *
 * schemaVersion 1 rows were written by extension 0.2.10 only (2026-10-21, a 35-day window).
 * 0.2.11 fetches 400 days every cycle, so its first fetch replaces every v1 row; a v1 row is
 * still read as what it is — no engaged views, earnings or locations — never padded out.
 */
export type ChannelDay = ChannelDayV1 | ChannelDayV2;

export interface ChannelDayV1 extends ChannelDayFields {
  schemaVersion: 1;
}

/**
 * One PLAYBACK_LOCATION_TYPE's share of a channel day: where the view happened (BROWSE is the
 * Home feed itself), as opposed to bySource, which surface sent the viewer. A location with
 * no row that day is all zeros.
 */
export interface LocationDay {
  views: number;
  engagedViews: number;
  watchHours: number;
}

export const CHANNEL_DAY_LOCATION_KEYS = ['browse', 'watch', 'shortsFeed', 'channel', 'embedded', 'other'] as const;

/** Extension 0.2.11+. Money is USD; `cpm` is null on a day no ads ran; null = not reported. */
export interface ChannelDayV2 extends ChannelDayFields {
  schemaVersion: 2;
  engagedViews: number;
  estimatedEarnings: number | null;
  cpm: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  subsGained: number | null;
  subsLost: number | null;
  byLocation: {
    browse: LocationDay; watch: LocationDay; shortsFeed: LocationDay; channel: LocationDay;
    embedded: LocationDay; other: LocationDay;
  };
  /** Studio location names folded into `byLocation.other`, deduped and sorted. */
  otherLocations: string[];
}

/**
 * A video's first seven Studio days — its local publish day and the six after — from one
 * VIDEO query over exactly that range, collected once the window has closed and settled.
 * Upserted by videoId into <channel>/first-weeks.json. This is the first-week measure the
 * distiller compares uploads on: the same window for every video, whenever it was published,
 * with engaged views whatever the date (the per-video snapshots from 2026-08-27 until
 * extension 0.2.11 carry none).
 */
export interface VideoFirstWeek {
  schemaVersion: 1;
  videoId: string;
  channelId: string;
  publishedAt: string;          // ISO
  firstDay: string;             // 'YYYY-MM-DD'
  lastDay: string;              // firstDay + 6
  capturedAt: string;
  source: 'studio-extension';
  views: number;
  engagedViews: number;
  watchHours: number;
  impressions: number | null;
  impressionsCtr: number | null;  // percent
  avgPctViewed: number | null;    // percent
}

/** Thrown when a VideoFirstWeek fails validation on ingest; `reasons` lists every failing field. */
export class VideoFirstWeekValidationError extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(`VideoFirstWeek validation failed: ${reasons.join('; ')}`);
    this.name = 'VideoFirstWeekValidationError';
    this.reasons = reasons;
  }
}

interface ChannelDayFields {
  channelId: string;
  day: string;                        // 'YYYY-MM-DD'
  capturedAt: string;                 // ISO, when this row was fetched
  source: 'studio-extension';
  impressions: number | null;
  impressionsCtr: number | null;      // percent
  views: number;
  watchHours: number;
  /**
   * null = Studio has not computed the viewer cohort for that day yet. Observed 2026-10-21:
   * for the most recent ~2 days NEW_VIEWERS and RETURNING_VIEWERS both come back 0 while
   * EXTERNAL_VIEWS > 0. The next collection overwrites the row with the real numbers.
   */
  newViewers: number | null;
  returningViewers: number | null;
  subsNetChange: number | null;
  /** Keys are OUR names; the collector maps Studio's TRAFFIC_SOURCE_TYPE enum onto them. */
  bySource: {
    browse: SourceDay; suggested: SourceDay; search: SourceDay; channel: SourceDay; playlist: SourceDay;
    direct: SourceDay; external: SourceDay; notification: SourceDay; shorts: SourceDay; endScreen: SourceDay; other: SourceDay;
  };
  /** Studio enum names folded into `bySource.other`, deduped and sorted — nothing is dropped unnamed. */
  otherSources: string[];
}

export const CHANNEL_DAY_SOURCE_KEYS = [
  'browse', 'suggested', 'search', 'channel', 'playlist',
  'direct', 'external', 'notification', 'shorts', 'endScreen', 'other',
] as const;

/** Thrown when a ChannelDay fails validation on ingest; `reasons` lists every failing field. */
export class ChannelDayValidationError extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(`ChannelDay validation failed: ${reasons.join('; ')}`);
    this.name = 'ChannelDayValidationError';
    this.reasons = reasons;
  }
}
