/**
 * The visibility scheduler's shapes as the renderer sees them. Mirrors
 * electron/services/scheduler/scheduler-client.ts, which mirrors the server's jobs.ts.
 */

export type Visibility = 'public' | 'unlisted' | 'private';
export const VISIBILITIES: readonly Visibility[] = ['public', 'unlisted', 'private'];
export type JobState = 'pending' | 'done' | 'failed' | 'cancelled';

export interface SchedulerJobResult {
  before: string;
  after: string;
  ranAt: string;
  lateByMs: number;
  clearedYouTubeSchedule: boolean;
  /** Set when nothing had to change, or for a failure. */
  message: string | null;
}

export interface SchedulerJob {
  id: string;
  channelId: string;
  channelTitle: string | null;
  videoId: string;
  videoTitle: string;
  target: Visibility;
  /** UTC ISO; shown in local time. */
  runAt: string;
  note: string;
  createdAt: string;
  createdBy: string;
  state: JobState;
  nextAttemptAt: string | null;
  attempts: { at: string; error: string }[];
  result: SchedulerJobResult | null;
}

export interface SchedulerJobWithWarnings {
  job: SchedulerJob;
  warnings: string[];
}

export interface SchedulerChannel {
  channelId: string;
  title: string;
  connectedAt: string;
  state: string;
  lastError: string | null;
}

export interface SchedulerHealth {
  ok: boolean;
  lastTick: string | null;
  nextDue: string | null;
  caller: string;
}

export interface SchedulerVideo {
  videoId: string;
  channelId: string;
  title: string;
  privacyStatus: string;
  publishAt: string | null;
}

export interface SchedulerStatus {
  configured: boolean;
  baseUrl: string | null;
  reason: string | null;
  configPath: string;
}

export interface SchedulerTestResult {
  health: SchedulerHealth;
  channels: SchedulerChannel[];
}

export interface SchedulerJobFilter {
  videoId?: string;
  channelId?: string;
  state?: JobState;
  from?: string;
  to?: string;
}

export interface NewSchedulerJob {
  videoId: string;
  target: Visibility;
  runAt: string;
  note: string;
}

export interface SchedulerJobPatch {
  target?: Visibility;
  runAt?: string;
  note?: string;
}
