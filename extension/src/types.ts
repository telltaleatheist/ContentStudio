// Shared data contract between ContentStudio Companion and the ContentStudio
// desktop app. These interfaces mirror ContentStudio's analytics schema —
// field names must stay identical on both sides.

export interface VideoRecord {
  videoId: string; channelId: string; publishedAt: string; durationSec: number;
  format: 'long' | 'short' | 'live';
  titleHistory: Array<{ title: string; from: string; to: string | null; origin: 'upload' | 'manual-edit' | 'ab-rotation' | 'test-compare' }>;
}
export interface Snapshot {
  schemaVersion: 1; videoId: string; channelId: string; capturedAt: string;
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
/** Mirror of SourceDay in ContentStudio's analytics-types.ts. null = no impressions value reported. */
export interface SourceDay { impressions: number | null; impressionsCtr: number | null; views: number; }
/**
 * Mirror of ChannelDay: one channel's PER-DAY totals (not lifetime). newViewers /
 * returningViewers are null while Studio has not computed the cohort (~2 most recent days).
 */
export interface ChannelDay {
  schemaVersion: 1; channelId: string; day: string; capturedAt: string; source: 'studio-extension';
  impressions: number | null; impressionsCtr: number | null; views: number; watchHours: number;
  newViewers: number | null; returningViewers: number | null; subsNetChange: number | null;
  bySource: {
    browse: SourceDay; suggested: SourceDay; search: SourceDay; channel: SourceDay; playlist: SourceDay;
    direct: SourceDay; external: SourceDay; notification: SourceDay; shorts: SourceDay; endScreen: SourceDay; other: SourceDay;
  };
  otherSources: string[];
}
