// What the shelf's Visibility section says about a change, and the one conversion it must
// get exactly right: a local date + time typed into the form -> an ISO timestamp carrying
// its own zone offset.
//
// Kept free of DOM, chrome.* and network so tools/visibility-format-checks.js can run it
// under any time zone. See VISIBILITY-SCHEDULER-PLAN.md ("A change") for the job shape.

import type { SchedulerJob, Visibility } from './scheduler-client';

export const VISIBILITIES: readonly Visibility[] = ['public', 'unlisted', 'private'];

/** "public" -> "Public". Anything else YouTube reports is shown exactly as it came. */
export function visibilityLabel(value: string): string {
  if ((VISIBILITIES as readonly string[]).includes(value)) return value[0]!.toUpperCase() + value.slice(1);
  return value;
}

const pad = (n: number, width = 2) => String(Math.abs(n)).padStart(width, '0');

/**
 * A Date as `YYYY-MM-DDTHH:MM:SS±hh:mm` in the zone this browser runs in.
 *
 * The offset is the one in force AT THAT INSTANT (getTimezoneOffset of the date itself,
 * not of today), so a change typed in winter for a summer date carries the summer offset.
 */
export function isoWithOffset(d: Date): string {
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const zone = `${sign}${pad(Math.floor(Math.abs(offsetMin) / 60))}:${pad(Math.abs(offsetMin) % 60)}`;
  return (
    `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${zone}`
  );
}

export type RunAtResult = { ok: true; iso: string } | { ok: false; error: string };

/** How far apart two readings of one wall-clock time can be across a clock change. */
const CLOCK_CHANGE_STEPS_MIN = [30, 60, 120];

/**
 * The runAt to send for a date (`YYYY-MM-DD`) and time (`HH:MM`) read in local time.
 *
 * Refused, never adjusted: a time the clocks skip (spring forward) would otherwise be moved
 * an hour by the Date constructor without anyone seeing it, and a time the clocks repeat
 * (fall back) names two instants, so either reading would be a guess.
 */
export function runAtFromLocal(date: string, time: string): RunAtResult {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!dm) return { ok: false, error: date.trim() ? `"${date}" is not a date (YYYY-MM-DD).` : 'Pick a date.' };
  const tm = /^(\d{2}):(\d{2})$/.exec(time.trim());
  if (!tm) return { ok: false, error: time.trim() ? `"${time}" is not a time (HH:MM).` : 'Pick a time.' };

  const [y, mo, d] = [Number(dm[1]), Number(dm[2]), Number(dm[3])];
  const [h, mi] = [Number(tm[1]), Number(tm[2])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return { ok: false, error: `${date} is not a real date.` };
  if (h > 23 || mi > 59) return { ok: false, error: `${time} is not a real time.` };

  // Noon is never skipped or repeated by a clock change, so a probe there that lands on
  // another day means the date itself does not exist (new Date(2026, 1, 30) is 2 March).
  const sameDay = (x: Date) => x.getFullYear() === y && x.getMonth() === mo - 1 && x.getDate() === d;
  if (!sameDay(new Date(y, mo - 1, d, 12, 0, 0, 0))) return { ok: false, error: `${date} is not a real date.` };

  const at = new Date(y, mo - 1, d, h, mi, 0, 0);
  const sameWall = (x: Date) => sameDay(x) && x.getHours() === h && x.getMinutes() === mi;
  if (!sameWall(at)) {
    return { ok: false, error: `${time} does not exist on ${date} in this time zone (the clocks skip it). Pick another time.` };
  }
  for (const step of CLOCK_CHANGE_STEPS_MIN) {
    for (const dir of [-1, 1]) {
      if (sameWall(new Date(at.getTime() + dir * step * 60_000))) {
        return { ok: false, error: `${time} happens twice on ${date} in this time zone (the clocks go back). Pick a time outside the repeated hour.` };
      }
    }
  }
  return { ok: true, iso: isoWithOffset(at) };
}

/** An ISO instant as the form's date and time inputs show it, in local time. */
export function localInputsOf(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`not a time: ${JSON.stringify(iso)}`);
  return {
    date: `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/**
 * An ISO instant for reading, in local time: "Tue 4 Nov, 10:00", with the year only when
 * it is not this year. Throws on an unreadable time: the client validates every time it
 * receives, so reaching here with one is a bug to see, not a blank to draw.
 */
export function formatLocal(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`not a time: ${JSON.stringify(iso)}`);
  return d.toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Today in local time as `YYYY-MM-DD`, for the add form's date input. */
export function localDateOf(d: Date): string {
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Below this a late change is ordinary scheduler slack (the loop ticks every 30 s). */
export const LATE_NOTE_MS = 2 * 60_000;

/** "ran N min late", or null when the change ran within two minutes of its time. */
export function lateNote(lateByMs: number): string | null {
  if (!(lateByMs > LATE_NOTE_MS)) return null;
  return `ran ${Math.round(lateByMs / 60_000)} min late`;
}

export type JobTone = 'pending' | 'retrying' | 'done' | 'failed' | 'cancelled';

export interface JobDescription {
  tone: JobTone;
  /** "→ Public", "Unlisted → Public", "→ Public failed". */
  headline: string;
  /** Further facts, each its own line or clause. */
  details: string[];
}

/**
 * What one change's row says. Its time and note are drawn beside this, not in it.
 * `when` formats an ISO instant for the reader (local time in the shelf).
 */
export function describeJob(job: SchedulerJob, when: (iso: string) => string): JobDescription {
  const to = visibilityLabel(job.target);
  switch (job.state) {
    case 'pending': {
      if (!job.attempts.length) return { tone: 'pending', headline: `→ ${to}`, details: [] };
      const last = job.attempts[job.attempts.length - 1]!;
      const details = [`attempt ${job.attempts.length} failed: ${last.error}`];
      if (job.nextAttemptAt) details.push(`trying again at ${when(job.nextAttemptAt)}`);
      return { tone: 'retrying', headline: `→ ${to}`, details };
    }
    case 'cancelled':
      return { tone: 'cancelled', headline: `→ ${to} cancelled`, details: [] };
    case 'done': {
      const r = job.result;
      if (!r) return { tone: 'failed', headline: `→ ${to}`, details: ['The scheduler reports this change as done but sent no result for it.'] };
      const details: string[] = [];
      const late = lateNote(r.lateByMs);
      if (late) details.push(late);
      if (r.clearedYouTubeSchedule) details.push('cancelled YouTube’s own schedule');
      if (r.message) details.push(r.message);
      return { tone: 'done', headline: `${visibilityLabel(r.before)} → ${visibilityLabel(r.after)}`, details };
    }
    case 'failed': {
      const r = job.result;
      const details = [r?.message ?? 'The scheduler reports this change as failed but sent no message for it.'];
      if (r) {
        const late = lateNote(r.lateByMs);
        if (late) details.push(late);
      }
      return { tone: 'failed', headline: `→ ${to} failed`, details };
    }
  }
}

/** Pending changes soonest first; everything else (history) newest first. */
export function splitJobs(jobs: SchedulerJob[]): { pending: SchedulerJob[]; history: SchedulerJob[] } {
  const at = (j: SchedulerJob) => Date.parse(j.runAt);
  const pending = jobs.filter((j) => j.state === 'pending').sort((a, b) => at(a) - at(b));
  const history = jobs.filter((j) => j.state !== 'pending').sort((a, b) => at(b) - at(a));
  return { pending, history };
}

/** The section head's count, or null with nothing pending. */
export function pendingBadge(jobs: SchedulerJob[]): string | null {
  const n = jobs.filter((j) => j.state === 'pending').length;
  return n ? `${n} pending` : null;
}

/**
 * The warning the server will attach, said in the form BEFORE saving (the plan's "the
 * clients show it before saving"). Mirrors server/visibility-scheduler jobs.warningsFor.
 */
export function scheduleClashWarning(
  publishAt: string | null,
  target: Visibility | null,
  when: (iso: string) => string,
): string | null {
  if (!publishAt || !target || target === 'private') return null;
  return `YouTube itself is set to publish this video at ${when(publishAt)}; this change will cancel that schedule when it runs.`;
}
