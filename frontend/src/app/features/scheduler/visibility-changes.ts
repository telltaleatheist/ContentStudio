/**
 * Visibility changes — the pure half of the panel, the Settings card and the calendar
 * badges (VISIBILITY-SCHEDULER-PLAN.md, "ContentStudio"). No Angular, no IPC: what a change
 * reads as, the order a list shows, and the requests built from the form's local date and
 * time. tools/visibility-scheduler-checks.js runs every function here from this file.
 *
 * Times are the viewer's local time everywhere (plan, "A change"); the stored runAt is a UTC
 * instant, and what is sent is composed by composePublishAt, which carries the offset in
 * effect AT that moment, so a change across a daylight-saving date lands at the hour typed.
 */

import { composePublishAt } from '../publish/publish-schedule';
import type { NewSchedulerJob, SchedulerJob, SchedulerJobPatch, Visibility } from './scheduler.types';
import { VISIBILITIES } from './scheduler.types';

/** "ran N min late" only past this; the loop ticks every 30 s, so a minute or two is normal. */
export const LATE_NOTE_AFTER_MS = 2 * 60_000;
/** The server keeps 200 characters of a note; a longer one is refused here rather than cut. */
export const NOTE_MAX = 200;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n: number) => String(n).padStart(2, '0');

function parse(iso: string, what: string): Date {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) throw new Error(`${what} ${JSON.stringify(iso)} is not a time this can read.`);
  return at;
}

/** Local `YYYY-MM-DD` of an instant — the calendar's day key (calendar-states dateKeyOf). */
export function localDateKey(iso: string): string {
  const at = parse(iso, 'The change time');
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`;
}

/** Local `HH:MM`. */
export function localTime(iso: string): string {
  const at = parse(iso, 'The change time');
  return `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
}

/** `Tue 4 Nov, 10:00` in local time. */
export function formatLocal(iso: string): string {
  const at = parse(iso, 'The change time');
  const day = at.toLocaleDateString('en-GB', { weekday: 'short' });
  return `${day} ${at.getDate()} ${MONTHS[at.getMonth()]}${at.getFullYear() !== new Date().getFullYear() ? ` ${at.getFullYear()}` : ''}, ${localTime(iso)}`;
}

/**
 * The calendar badge: `→ public 10:00` on its day, or `→ unlisted 9 Jan` where the day is
 * not already what the badge sits on.
 */
export function badgeText(job: Pick<SchedulerJob, 'target' | 'runAt'>, form: 'time' | 'date'): string {
  const at = parse(job.runAt, 'The change time');
  return form === 'time' ? `→ ${job.target} ${localTime(job.runAt)}` : `→ ${job.target} ${at.getDate()} ${MONTHS[at.getMonth()]}`;
}

export interface DayBadge {
  jobId: string;
  text: string;
  failed: boolean;
  /** The hover: video, note, and for a failure the reason. */
  title: string;
}

/**
 * Pending and failed changes grouped by local day, each day's in time order. Done and
 * cancelled changes are history and get no badge.
 */
export function badgesByDay(jobs: readonly SchedulerJob[]): Map<string, DayBadge[]> {
  const out = new Map<string, DayBadge[]>();
  const shown = jobs
    .filter((j) => j.state === 'pending' || j.state === 'failed')
    .slice()
    .sort((a, b) => Date.parse(a.runAt) - Date.parse(b.runAt));
  for (const job of shown) {
    const key = localDateKey(job.runAt);
    const failed = job.state === 'failed';
    const reason = failed ? failureText(job) : null;
    const title = [job.videoTitle || job.videoId, job.note || null, reason ? `failed: ${reason}` : null].filter(Boolean).join(' · ');
    const list = out.get(key) ?? [];
    list.push({ jobId: job.id, text: badgeText(job, 'time'), failed, title });
    out.set(key, list);
  }
  return out;
}

/** Pending first, soonest first; then everything else, most recent first. */
export function sortChanges(jobs: readonly SchedulerJob[]): SchedulerJob[] {
  const t = (j: SchedulerJob) => Date.parse(j.runAt);
  const pending = jobs.filter((j) => j.state === 'pending').sort((a, b) => t(a) - t(b));
  const history = jobs.filter((j) => j.state !== 'pending').sort((a, b) => t(b) - t(a));
  return [...pending, ...history];
}

/** `ran 7 min late` past LATE_NOTE_AFTER_MS, else null. */
export function lateText(lateByMs: number): string | null {
  if (!(lateByMs > LATE_NOTE_AFTER_MS)) return null;
  const minutes = Math.round(lateByMs / 60_000);
  return `ran ${minutes} min late`;
}

/** Why a failed change failed: the result's message, else the last attempt's error. */
export function failureText(job: SchedulerJob): string {
  const fromResult = job.result?.message ?? null;
  if (fromResult) return fromResult;
  const last = job.attempts.length ? job.attempts[job.attempts.length - 1].error : null;
  if (last) return last;
  return 'the scheduler recorded no reason';
}

export type ChangeTone = 'pending' | 'done' | 'failed' | 'cancelled';

export interface ChangeView {
  id: string;
  tone: ChangeTone;
  /** `→ public` */
  target: string;
  /** Local time, `Tue 4 Nov, 10:00`. */
  when: string;
  state: string;
  note: string;
  /** Extra facts, in order: `unlisted → public`, `ran 7 min late`, `cancelled YouTube’s own schedule`, retries. */
  lines: string[];
  /** For a failure, the reason in full; null otherwise. */
  error: string | null;
  editable: boolean;
}

/** How one change reads in the panel. */
export function changeView(job: SchedulerJob): ChangeView {
  const lines: string[] = [];
  const r = job.result;
  let error: string | null = null;
  if (job.state === 'done' && r) {
    lines.push(`${r.before} → ${r.after}`);
    if (r.message) lines.push(r.message);
    const late = lateText(r.lateByMs);
    if (late) lines.push(late);
    if (r.clearedYouTubeSchedule) lines.push('cancelled YouTube’s own schedule');
  }
  if (job.state === 'failed') {
    error = failureText(job);
    if (r && r.before) lines.push(`${r.before} → ${r.after || r.before}`);
    if (job.attempts.length > 1) lines.push(`${job.attempts.length} attempts`);
  }
  if (job.state === 'pending' && job.attempts.length > 0) {
    const last = job.attempts[job.attempts.length - 1];
    lines.push(
      `retrying${job.nextAttemptAt ? ` at ${localTime(job.nextAttemptAt)}` : ''} after ${job.attempts.length} failed attempt${job.attempts.length === 1 ? '' : 's'}: ${last.error}`,
    );
  }
  return {
    id: job.id,
    tone: job.state,
    target: `→ ${job.target}`,
    when: formatLocal(job.runAt),
    state: job.state,
    note: job.note,
    lines,
    error,
    editable: job.state === 'pending',
  };
}

export interface ChangeForm {
  target: string;
  /** `<input type="date">`, local. */
  date: string;
  /** `<input type="time">`, local. */
  time: string;
  note: string;
}

function requireTarget(value: string): Visibility {
  if (!(VISIBILITIES as readonly string[]).includes(value)) throw new Error('Pick a visibility: public, unlisted or private.');
  return value as Visibility;
}

function requireNote(value: string): string {
  const note = (value ?? '').trim();
  if (note.length > NOTE_MAX) throw new Error(`The note is ${note.length} characters; the scheduler keeps ${NOTE_MAX}. Shorten it.`);
  return note;
}

/** The POST /jobs body from the add form. Throws on a missing visibility, date or time. */
export function buildCreateRequest(videoId: string, form: ChangeForm): NewSchedulerJob {
  return {
    videoId,
    target: requireTarget(form.target),
    // Throws on an incomplete pair or the hour that does not exist on a spring-forward morning.
    runAt: composePublishAt(form.date, form.time),
    note: requireNote(form.note),
  };
}

/** The edit form, prefilled from a change. */
export function formFromJob(job: SchedulerJob): ChangeForm {
  return { target: job.target, date: localDateKey(job.runAt), time: localTime(job.runAt), note: job.note };
}

/** The PATCH body: only what the form changed. Throws when nothing did. */
export function buildPatchRequest(job: SchedulerJob, form: ChangeForm): SchedulerJobPatch {
  const patch: SchedulerJobPatch = {};
  const target = requireTarget(form.target);
  if (target !== job.target) patch.target = target;
  const runAt = composePublishAt(form.date, form.time);
  if (Date.parse(runAt) !== Date.parse(job.runAt)) patch.runAt = runAt;
  const note = requireNote(form.note);
  if (note !== job.note) patch.note = note;
  if (Object.keys(patch).length === 0) throw new Error('Nothing was changed.');
  return patch;
}

/** The next calendar day of a `YYYY-MM-DD` key, by calendar day (not 24 h). */
export function nextDayKey(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  const next = new Date(y, m - 1, d + 1);
  return `${next.getFullYear()}-${pad2(next.getMonth() + 1)}-${pad2(next.getDate())}`;
}

/** `from`/`to` for GET /jobs covering local days first..last inclusive, zones explicit. */
export function rangeForDays(firstKey: string, lastKey: string): { from: string; to: string } {
  return { from: composePublishAt(firstKey, '00:00'), to: composePublishAt(nextDayKey(lastKey), '00:00') };
}
