/**
 * Calendar state derivation — the pure half of the publish calendar.
 *
 * Split out of the component deliberately: which state a chip is in, and whether it can
 * still be scheduled, are the rules the design's §2.5 table specifies, and they are worth
 * being able to exercise without an Angular test bed. Nothing here touches a signal, a
 * template or the DOM.
 */

/** The chip states, exactly as the design names them. */
export type ChipState = 'scheduled' | 'stale' | 'published';

/** The subset of a publish record these rules read. */
export interface SchedulableFacts {
  publishAt: string | null;
  status: string;
  videoId: string | null;
}

/**
 * Which state a scheduled row is in.
 *
 * PUBLISHED means the video has gone out: the record says so, or there is a video id and
 * its moment has passed. Both matter — the record's `status` is what this app knows, and
 * a linked video whose scheduled time is behind us has published whether or not anything
 * came back to say so.
 *
 * STALE is a schedule that lapsed with nothing recording a publish. It is not an error and
 * it is not a published row; it is the one state that needs explaining, which is why the
 * chip prints when it was due AND when the intent was recorded.
 */
export function chipStateOf(facts: SchedulableFacts, now: Date): ChipState {
  if (facts.publishAt === null) {
    throw new Error('chipStateOf is for scheduled rows; this record has no publishAt.');
  }
  const at = new Date(facts.publishAt);
  if (Number.isNaN(at.getTime())) {
    throw new Error(`Stored publishAt ${JSON.stringify(facts.publishAt)} is not a date this can read.`);
  }

  const isPast = at.getTime() < now.getTime();
  if (facts.status === 'published' || (facts.videoId !== null && isPast)) return 'published';
  return isPast ? 'stale' : 'scheduled';
}

/**
 * Can this item still be given a publish time?
 *
 * YouTube accepts `status.publishAt` only while a video is private and has never been
 * published, so a published row gets NO scheduling control at all — not a disabled one.
 * A disabled control claims the operation exists and is merely unavailable right now,
 * which is a different and false statement.
 */
export function isSchedulable(facts: { status: string }): boolean {
  return facts.status !== 'published';
}

/**
 * A channel's short tag: the initials of its name, up to three.
 *
 * Deterministic, and never a mapping this app invented — "Owen Morgan (Telltale)",
 * "Owen's Fireside Chat" and "Owen Unfiltered" all start with the same word, so a
 * first-letter tag would print O for all three. Initials keep them apart (OMT / OFC / OU)
 * without needing to know anything about which channel is which.
 */
export function channelTag(name: string): string {
  const letters = name
    // Apostrophes are DELETED rather than split on: "Owen's" is one word, and splitting
    // it produced an "S" initial that made Fireside read OSF instead of OFC.
    .replace(/['\u2019]/g, '')
    .replace(/[^A-Za-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase());
  return letters.slice(0, 3).join('') || '?';
}

/** First of the month, local. Used by the reports page's month grouping. */
export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/** Local `YYYY-MM-DD`. Local, because a day cell is a wall-clock day, not a UTC one. */
export function dateKeyOf(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `2 days ago` / `in 3 hours`. Whole units — this is a sense of scale, not a duration. */
export function distance(at: Date, now: Date): string {
  const deltaMs = at.getTime() - now.getTime();
  const future = deltaMs >= 0;
  const abs = Math.abs(deltaMs);
  const minutes = Math.round(abs / 60_000);

  let value: number;
  let unit: string;
  if (minutes < 60) {
    value = Math.max(minutes, 1);
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

/**
 * How far along an item is toward being a video on YouTube.
 *
 * Three answers, and the middle one is the only one that can be acted on in bulk:
 *
 *   done       — a video id exists, or the operator marked it published. Off the work
 *                list entirely; the extension handles it from here.
 *   ready      — everything videos.insert needs has been decided, so it can go now.
 *   incomplete — something is still missing, and `missingFor` names what.
 *
 * DONE is deliberately the same rule the reports list uses (`videoId || status
 * 'published'`): the backlog mark-as-published pass wrote a status on 138 items that have
 * no video id, and two pages disagreeing about which of those are finished would be worse
 * than either answer alone.
 */
export type Readiness = 'done' | 'ready' | 'incomplete';

/** The subset of a record the readiness rules read. */
export interface ReadinessFacts {
  channelId: string | null;
  videoId: string | null;
  status: string;
  hasThumbnail: boolean;
  /** How many titles the operator has chosen. The first one IS the video's title. */
  abCount: number;
}

/**
 * What is still missing before this item could be uploaded, in the order it reads.
 *
 * A THUMBNAIL COUNTS AS MISSING even though videos.insert does not require one: an upload
 * without it produces a real video on a real channel that then has to be fixed by hand in
 * Studio, which is the thing uploading from here is meant to avoid. The API's minimum and
 * the operator's minimum are different bars, and this is the operator's.
 */
export function missingFor(facts: ReadinessFacts): string[] {
  const missing: string[] = [];
  if (facts.channelId === null) missing.push('channel');
  if (facts.abCount < 1) missing.push('title');
  if (!facts.hasThumbnail) missing.push('thumbnail');
  return missing;
}

export function readinessOf(facts: ReadinessFacts): Readiness {
  if (facts.videoId !== null || facts.status === 'published') return 'done';
  return missingFor(facts).length === 0 ? 'ready' : 'incomplete';
}
