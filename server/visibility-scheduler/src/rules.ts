// The scheduler's rules, kept free of I/O so they can be tested on their own.
// See VISIBILITY-SCHEDULER-PLAN.md at the repo root.

export const VISIBILITIES = ['public', 'unlisted', 'private'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export function isVisibility(value: unknown): value is Visibility {
  return typeof value === 'string' && (VISIBILITIES as readonly string[]).includes(value);
}

/** A change must be at least this far in the future when it is made or edited. */
export const MIN_LEAD_MS = 60_000;

/**
 * An ISO-8601 timestamp WITH an explicit zone ("Z" or "+hh:mm"). A bare local time is
 * refused: the server runs in UTC and the clients do not, so a zoneless time would be read
 * in the wrong zone without anyone noticing.
 */
export function parseRunAt(value: unknown): number | string {
  if (typeof value !== 'string') return 'runAt must be a string';
  const v = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(v)) {
    return `runAt must be an ISO-8601 timestamp with an explicit zone (Z or +hh:mm); got ${JSON.stringify(value)}`;
  }
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) return `runAt is not a real time: ${JSON.stringify(value)}`;
  return ms;
}

export interface PendingSlot {
  id: string;
  videoId: string;
  runAt: number;
}

/**
 * Why a change at `runAt` for `videoId` may not be saved, or null when it may.
 * `others` are the video's other pending changes (the one being edited excluded).
 */
export function scheduleProblem(runAt: number, videoId: string, others: PendingSlot[], now: number): string | null {
  if (runAt < now + MIN_LEAD_MS) return 'runAt must be at least one minute in the future';
  const minute = Math.floor(runAt / 60_000);
  const clash = others.find((o) => o.videoId === videoId && Math.floor(o.runAt / 60_000) === minute);
  if (clash) return `this video already has a change in that minute (${clash.id}); two in one minute would leave unclear which wins`;
  return null;
}

/** The writable fields of a video's `status`, other than the two this service decides. */
const KEPT_STATUS_FIELDS = ['license', 'embeddable', 'publicStatsViewable', 'selfDeclaredMadeForKids', 'containsSyntheticMedia'] as const;

export interface StatusUpdate {
  status: Record<string, unknown>;
  /** True when the video had a YouTube-native publishAt that this update removes. */
  clearedYouTubeSchedule: boolean;
}

/**
 * The `status` object to send with videos.update(part=status).
 *
 * YouTube deletes any writable property of the part that the update leaves out, so the
 * current values are sent back unchanged and only privacyStatus differs. A YouTube-native
 * publishAt is always removed: this service's change is what decides the video's visibility,
 * and a video left carrying one would still go public on that date.
 */
export function buildStatusUpdate(current: Record<string, unknown>, target: Visibility): StatusUpdate {
  const status: Record<string, unknown> = {};
  for (const field of KEPT_STATUS_FIELDS) {
    if (current[field] !== undefined) status[field] = current[field];
  }
  status.privacyStatus = target;
  return { status, clearedYouTubeSchedule: hasYouTubeSchedule(current) };
}

/** Whether YouTube itself is set to publish this video on a date. */
export function hasYouTubeSchedule(current: Record<string, unknown>): boolean {
  return typeof current.publishAt === 'string' && current.publishAt !== '';
}

/** Whether the video is already what the change asks for. Scheduled is not private: it is private until a date. */
export function isAtTarget(current: Record<string, unknown>, target: Visibility): boolean {
  return current.privacyStatus === target && !hasYouTubeSchedule(current);
}

/** Delays before the retries of a change that hit a network error or a 5xx/429. */
const RETRY_DELAYS_MS = [1, 2, 5, 10].map((m) => m * 60_000);

/** The delay before retry number `failures` (1 = after the first failure), or null when out of retries. */
export function retryDelay(failures: number): number | null {
  return RETRY_DELAYS_MS[failures - 1] ?? null;
}

/** Whether an HTTP status from Google is worth retrying the same request for. */
export function isTransientStatus(status: number | undefined): boolean {
  return status === undefined || status === 429 || status >= 500;
}

/** YouTube video ids are 11 characters of [A-Za-z0-9_-]. */
export function isVideoId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{11}$/.test(value);
}
