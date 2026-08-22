/**
 * Publish schedule — the renderer's half of `publishAt`.
 *
 * The stored field is an ISO-8601 instant WITH AN EXPLICIT OFFSET, because YouTube reads
 * a schedule as a moment and a bare `2026-09-01T14:00` means a different moment to
 * whoever reads it. The panel, meanwhile, gives the operator a date box and a time box —
 * two local wall-clock values with no zone in them at all. Everything here is the join
 * between those two facts, kept pure so the arithmetic is readable and testable rather
 * than smeared across a template.
 *
 * There is deliberately NO time-zone picker in this release (spec §2.3). The zone is this
 * Mac's, the offset is the one in effect AT THE SCHEDULED MOMENT (not today's — see
 * composePublishAt), and it is always shown rather than assumed.
 *
 * Every function here THROWS on input it cannot honour. A schedule that silently becomes
 * a different moment is the exact failure the explicit-offset rule exists to prevent, so
 * there is nothing to recover to.
 */

/** What an `<input type="date">` produces. */
const DATE_INPUT = /^\d{4}-\d{2}-\d{2}$/;
/** What an `<input type="time">` produces (seconds are never part of a schedule here). */
const TIME_INPUT = /^\d{2}:\d{2}$/;
/** The explicit zone the stored value always ends with. */
const ZONE_SUFFIX = /([Zz]|[+-]\d{2}:\d{2})$/;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `+05:30` / `-04:00` for the offset in effect at `at` on this machine. */
export function offsetStringFor(at: Date): string {
  // getTimezoneOffset is minutes to ADD to local to reach UTC, i.e. west-positive. The
  // ISO suffix is the opposite sign, which is the classic place this goes wrong.
  const minutesEastOfUtc = -at.getTimezoneOffset();
  const sign = minutesEastOfUtc < 0 ? '-' : '+';
  const abs = Math.abs(minutesEastOfUtc);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** `UTC-04:00`, or plain `UTC` for Z — what the operator reads next to a time. */
export function offsetLabel(offset: string): string {
  return offset === 'Z' || offset === 'z' ? 'UTC' : `UTC${offset}`;
}

/** The offset a stored value carries, as `Z` or `±HH:MM`. Throws if it carries none. */
export function storedOffsetOf(iso: string): string {
  const match = ZONE_SUFFIX.exec(iso);
  if (!match) {
    throw new Error(
      `Stored publishAt ${JSON.stringify(iso)} has no explicit time zone. It was written ` +
      `without one, which no write through publish-set-fields can do.`
    );
  }
  return match[1];
}

/** Minutes east of UTC for a `Z` / `±HH:MM` suffix. */
function offsetMinutes(offset: string): number {
  if (offset === 'Z' || offset === 'z') return 0;
  const sign = offset[0] === '-' ? -1 : 1;
  return sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
}

/**
 * Build the value `publish-set-fields` accepts from the two boxes the operator filled.
 *
 * The offset is computed FOR THE SCHEDULED MOMENT, not for right now. Schedule something
 * on the far side of a daylight-saving change and today's offset is wrong by an hour —
 * the upload would go out at the wrong time, and the stored string would look perfectly
 * well-formed while doing it.
 */
export function composePublishAt(date: string, time: string): string {
  if (!DATE_INPUT.test(date)) {
    throw new Error(`Pick a date first: expected YYYY-MM-DD, got ${JSON.stringify(date)}.`);
  }
  if (!TIME_INPUT.test(time)) {
    throw new Error(`Pick a time first: expected HH:MM, got ${JSON.stringify(time)}.`);
  }

  // A date-time with no offset is parsed as LOCAL time — that is what makes this the
  // wall clock the operator typed.
  const local = new Date(`${date}T${time}:00`);
  if (Number.isNaN(local.getTime())) {
    throw new Error(`${date} ${time} is not a real date and time.`);
  }

  const composed = `${date}T${time}:00${offsetStringFor(local)}`;

  // The one hour a year that does not exist here: on a spring-forward date the Date
  // above normalises 02:30 to 03:30, so the composed string names a different instant
  // than the operator typed. Say so instead of scheduling the wrong moment.
  if (new Date(composed).getTime() !== local.getTime()) {
    throw new Error(
      `${date} ${time} does not exist in this time zone — the clocks jump over it that ` +
      `morning. Pick a time before or after the change.`
    );
  }

  return composed;
}

/** The stored instant as the two local box values, for prefilling the inputs. */
export function splitPublishAt(iso: string): { date: string; time: string } {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    throw new Error(`Stored publishAt ${JSON.stringify(iso)} is not a date and time this can read.`);
  }
  return {
    date: `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`,
    time: `${pad2(at.getHours())}:${pad2(at.getMinutes())}`,
  };
}

export interface PublishAtDescription {
  /** The stored instant as local wall time. */
  local: string;
  /** The offset in effect HERE for that instant, e.g. `UTC-04:00`. */
  localOffset: string;
  /** The offset the value was STORED with — not always this machine's. */
  storedOffset: string;
  /** True when those two are the same offset, so the stored one needs no mention. */
  offsetsAgree: boolean;
  /** `in 15 days`, `in 3 hours`, `6 hours ago`. */
  relative: string;
  /** True when the moment has already passed — a schedule nobody can still meet. */
  isPast: boolean;
  /** The exact stored string, for when the operator wants the value itself. */
  raw: string;
}

/**
 * How a stored schedule reads on screen: local wall time, the offset it is being read
 * in, and how far away it is.
 *
 * The stored offset is reported ALONGSIDE the local one rather than instead of it. They
 * usually agree; when they do not (the record was written in the other half of the year,
 * or on another machine) that difference is the whole explanation for a time that looks
 * an hour off, and hiding it would leave the operator with no way to see it.
 */
export function describePublishAt(iso: string, now: Date = new Date()): PublishAtDescription {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    throw new Error(`Stored publishAt ${JSON.stringify(iso)} is not a date and time this can read.`);
  }

  const stored = storedOffsetOf(iso);
  const localOffset = offsetStringFor(at);
  const deltaMs = at.getTime() - now.getTime();

  return {
    local: at.toLocaleString([], {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }),
    localOffset: offsetLabel(localOffset),
    storedOffset: offsetLabel(stored),
    offsetsAgree: offsetMinutes(stored) === offsetMinutes(localOffset),
    relative: describeDistance(deltaMs),
    isPast: deltaMs < 0,
    raw: iso,
  };
}

/** `in 15 days` / `20 minutes ago`. Whole units only — this is a sense of scale. */
function describeDistance(deltaMs: number): string {
  const future = deltaMs >= 0;
  const abs = Math.abs(deltaMs);

  const minutes = Math.round(abs / 60_000);
  if (minutes < 1) return future ? 'in under a minute' : 'just now';

  let value: number;
  let unit: string;
  if (minutes < 60) {
    value = minutes;
    unit = 'minute';
  } else if (abs < 36 * 3_600_000) {
    value = Math.round(abs / 3_600_000);
    unit = 'hour';
  } else {
    value = Math.round(abs / 86_400_000);
    unit = 'day';
  }

  const phrase = `${value} ${unit}${value === 1 ? '' : 's'}`;
  return future ? `in ${phrase}` : `${phrase} ago`;
}

/** `412 KB` / `1.8 MB` — thumbnail sizes, where the byte count is not the point. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new Error(`formatBytes needs a byte count; got ${JSON.stringify(bytes)}`);
  }
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * `12:07` / `1:04:12` — an episode's length, where the point is how long it is to listen
 * to and not how many seconds it contains.
 *
 * Hours appear only when there are any; minutes are zero-padded only once hours are
 * there, so a 12-minute clip reads `12:07` and not `0:12:07`.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`formatDuration needs a number of seconds; got ${JSON.stringify(seconds)}`);
  }
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return h > 0
    ? `${h}:${mm}:${String(s).padStart(2, '0')}`
    : `${mm}:${String(s).padStart(2, '0')}`;
}

/** The file's own name, for the row that already shows nothing else about the path. */
export function basename(absPath: string): string {
  const parts = absPath.split(/[\\/]/);
  return parts[parts.length - 1] || absPath;
}
