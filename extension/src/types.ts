// Shared data contract between ContentStudio Companion and the ContentStudio
// desktop app. These interfaces mirror ContentStudio's analytics schema —
// field names must stay identical on both sides.

export interface VideoRecord {
  videoId: string; channelId: string; publishedAt: string; durationSec: number;
  format: 'long' | 'short' | 'live';
  titleHistory: Array<{ title: string; from: string; to: string | null; origin: 'upload' | 'manual-edit' | 'ab-rotation' | 'test-compare' }>;
}
interface SnapshotBase {
  videoId: string; channelId: string; capturedAt: string;
  source: 'studio-extension'; videoAgeHours: number;
  impressions: number | null; impressionsCtr: number | null;
  views: number; watchHours: number;
  avgViewDurationSec: number | null; avgPctViewed: number | null;
  retention: { at30s: number | null; at60s: number | null } | null;
  trafficShare: { browse: number; suggested: number; search: number; external: number; notifications: number; other: number } | null;
  ctrBySource: { browse: number | null; search: number | null; suggested: number | null } | null;
  topSearchTerms: Array<{ term: string; views: number }> | null;
  subsGained: number | null; likes: number | null; comments: number | null; shares: number | null;
}
/** Extension 0.2.10 and earlier: no engaged views, no earnings. Still accepted from a queued outbox. */
export interface SnapshotV1 extends SnapshotBase { schemaVersion: 1; }
/**
 * Extension 0.2.11+: lifetime engaged views (views without the Home-feed autoplay previews
 * YouTube has counted as views since 2026-08-27), lifetime estimated earnings (USD), lifetime
 * CPM (USD, null when no ads ran), subscribers lost. Mirror of SnapshotV2 in analytics-types.ts.
 */
export interface SnapshotV2 extends SnapshotBase {
  schemaVersion: 2;
  engagedViews: number; estimatedEarnings: number | null; cpm: number | null; subsLost: number | null;
}
export type Snapshot = SnapshotV1 | SnapshotV2;

/** Mirror of SourceDay in ContentStudio's analytics-types.ts. null = no impressions value reported. */
export interface SourceDay { impressions: number | null; impressionsCtr: number | null; views: number; }
/** Mirror of LocationDay: one PLAYBACK_LOCATION_TYPE's share of a channel day. */
export interface LocationDay { views: number; engagedViews: number; watchHours: number; }
interface ChannelDayBase {
  channelId: string; day: string; capturedAt: string; source: 'studio-extension';
  impressions: number | null; impressionsCtr: number | null; views: number; watchHours: number;
  newViewers: number | null; returningViewers: number | null; subsNetChange: number | null;
  bySource: {
    browse: SourceDay; suggested: SourceDay; search: SourceDay; channel: SourceDay; playlist: SourceDay;
    direct: SourceDay; external: SourceDay; notification: SourceDay; shorts: SourceDay; endScreen: SourceDay; other: SourceDay;
  };
  otherSources: string[];
}
/** Extension 0.2.10: still accepted from a queued outbox. */
export interface ChannelDayV1 extends ChannelDayBase { schemaVersion: 1; }
/**
 * Mirror of ChannelDayV2: one channel's PER-DAY totals (not lifetime). newViewers /
 * returningViewers are null while Studio has not computed the cohort (~2 most recent days).
 * Money is USD (Studio sends USD x1000); cpm is null on a day no ads ran.
 */
export interface ChannelDayV2 extends ChannelDayBase {
  schemaVersion: 2;
  engagedViews: number; estimatedEarnings: number | null; cpm: number | null;
  likes: number | null; comments: number | null; shares: number | null;
  subsGained: number | null; subsLost: number | null;
  byLocation: {
    browse: LocationDay; watch: LocationDay; shortsFeed: LocationDay; channel: LocationDay;
    embedded: LocationDay; other: LocationDay;
  };
  otherLocations: string[];
}
export type ChannelDay = ChannelDayV1 | ChannelDayV2;

/**
 * A video's first seven Studio days (its local publish day and the six after), fetched once
 * that window has closed and settled. Mirror of VideoFirstWeek in analytics-types.ts.
 */
export interface VideoFirstWeek {
  schemaVersion: 1; videoId: string; channelId: string; publishedAt: string;
  firstDay: string; lastDay: string; capturedAt: string; source: 'studio-extension';
  views: number; engagedViews: number; watchHours: number;
  impressions: number | null; impressionsCtr: number | null; avgPctViewed: number | null;
}
