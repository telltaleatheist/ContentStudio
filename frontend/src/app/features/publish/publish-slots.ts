/**
 * Release cadences — which day and hour each channel publishes at, and which of those
 * slots is still free.
 *
 * Split out of the component in the same spirit as `publish-calendar/calendar-states.ts`:
 * the arithmetic that decides "the next open Thursday at 1pm" is a rule, not a rendering
 * detail, and it is worth being able to exercise without an Angular test bed. Nothing
 * here touches a signal, a template, the DOM or a clock it was not handed.
 *
 * Exercised by `tools/routing-publish-checks.js` (`npm run check:pure`), which transpiles
 * THIS file rather than a mirror of it, so a rule cannot be changed here and still pass
 * against a copy somewhere else.
 *
 * Everything is LOCAL WALL CLOCK. A release slot is "Sunday at 1pm where the operator
 * lives", not an instant — the instant is composed later, by `composePublishAt`, which
 * is the one place that attaches an offset.
 */

/**
 * The three cadences this install publishes on.
 *
 * A key, not a channel id: channel ids are per-install YouTube ids that only the registry
 * knows, and hard-coding one here would make the rule true on exactly one machine.
 */
export type CadenceKey = 'telltale' | 'unfiltered' | 'fireside';

/** One release slot in local wall clock. `weekday` is 0=Sunday … 6=Saturday. */
export interface Slot {
  weekday: number;
  /** Local hour, 0–23. */
  hour: number;
  /** Local minute, 0–59. */
  minute: number;
}

/**
 * Which word in a channel's registry name identifies its cadence.
 *
 * Matched on a distinctive word rather than on the whole name because the registry holds
 * whatever the operator typed ("Owen Morgan (Telltale)", "Owen's Fireside Chat", "Owen
 * Unfiltered"), and all three begin with the same word.
 */
const CADENCE_WORDS: ReadonlyArray<{ key: CadenceKey; word: string }> = [
  { key: 'telltale', word: 'telltale' },
  { key: 'unfiltered', word: 'unfiltered' },
  { key: 'fireside', word: 'fireside' },
];

const SUNDAY = 0;
const THURSDAY = 4;

/**
 * The published cadence for each channel, as the owner states it.
 *
 * - Telltale (the main channel): Sundays and Thursdays at 1:00 PM.
 * - Fireside Chat: every day at 1:00 PM, EXCEPT Sunday and Thursday at 2:00 PM, so a
 *   Fireside episode never lands on top of a main-channel release.
 * - Unfiltered: every day at 4:00 PM.
 */
export const CADENCES: Readonly<Record<CadenceKey, ReadonlyArray<Slot>>> = {
  telltale: [
    { weekday: SUNDAY, hour: 13, minute: 0 },
    { weekday: THURSDAY, hour: 13, minute: 0 },
  ],
  unfiltered: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, hour: 16, minute: 0 })),
  fireside: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    hour: weekday === SUNDAY || weekday === THURSDAY ? 14 : 13,
    minute: 0,
  })),
};

/** How a cadence reads on screen, for the one line that explains a suggestion. */
export const CADENCE_NOTES: Readonly<Record<CadenceKey, string>> = {
  telltale: 'Sundays and Thursdays at 1:00 PM.',
  unfiltered: 'Every day at 4:00 PM.',
  fireside: 'Every day at 1:00 PM, and 2:00 PM on Sundays and Thursdays so it clears the main channel.',
};

/**
 * The cadence a channel name names, or null when it names none.
 *
 * NULL IS A REAL ANSWER and the caller must say it out loud: a channel this app has no
 * cadence for gets no suggestion at all, rather than being quietly given somebody else's
 * schedule. Inventing a release day for a channel would be exactly the kind of invisible
 * wrong answer the rest of this feature exists to avoid.
 */
export function cadenceKeyFor(channelName: string | null | undefined): CadenceKey | null {
  if (typeof channelName !== 'string') return null;
  const haystack = channelName.toLowerCase();
  for (const { key, word } of CADENCE_WORDS) {
    if (haystack.includes(word)) return key;
  }
  return null;
}

/** Local `YYYY-MM-DDTHH:MM` — the key two schedules are compared as. Never a UTC one. */
export function slotKeyOf(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}:${pad(at.getMinutes())}`
  );
}

/** The date box and time box values for a moment, as the two inputs want them. */
export function splitSlot(at: Date): { date: string; time: string } {
  const key = slotKeyOf(at);
  return { date: key.slice(0, 10), time: key.slice(11) };
}

/**
 * Every slot for a cadence, in time order, starting from the first one strictly after
 * `after` and stopping once `horizonDays` have been walked.
 *
 * Built by walking days rather than by arithmetic on epoch milliseconds: a slot is a wall
 * clock time, and adding 24 hours across a daylight-saving boundary moves the clock.
 */
export function slotsAfter(
  cadence: CadenceKey,
  after: Date,
  horizonDays: number,
): Date[] {
  if (!Number.isInteger(horizonDays) || horizonDays < 1) {
    throw new Error(
      `slotsAfter needs a horizon of at least one day; got ${JSON.stringify(horizonDays)}.`,
    );
  }
  const slots = CADENCES[cadence];
  if (!slots) {
    throw new Error(`No cadence is recorded under the key ${JSON.stringify(cadence)}.`);
  }

  const out: Date[] = [];
  const day = new Date(after.getFullYear(), after.getMonth(), after.getDate());
  for (let i = 0; i <= horizonDays; i++) {
    const probe = new Date(day.getFullYear(), day.getMonth(), day.getDate() + i);
    for (const slot of slots) {
      if (probe.getDay() !== slot.weekday) continue;
      const at = new Date(
        probe.getFullYear(),
        probe.getMonth(),
        probe.getDate(),
        slot.hour,
        slot.minute,
        0,
        0,
      );
      if (at.getTime() > after.getTime()) out.push(at);
    }
  }
  out.sort((a, b) => a.getTime() - b.getTime());
  return out;
}

/**
 * The earliest future slot for this cadence that nothing else on the same channel already
 * occupies.
 *
 * `occupied` is the set of `slotKeyOf` values for the OTHER items routed to this channel
 * — the current item's own schedule is not a collision with itself and the caller leaves
 * it out. Returns null when every slot inside the horizon is taken, which is a fact worth
 * saying rather than a reason to hand back a slot that is already busy.
 */
export function nextOpenSlot(
  cadence: CadenceKey,
  now: Date,
  occupied: ReadonlySet<string>,
  horizonDays = 120,
): Date | null {
  for (const at of slotsAfter(cadence, now, horizonDays)) {
    if (!occupied.has(slotKeyOf(at))) return at;
  }
  return null;
}

/**
 * Whether a chosen moment lands on something already scheduled for this channel.
 *
 * Reported, never enforced: any day and any time is allowed, and a deliberate double
 * release is the operator's call. The caller flags it and moves on.
 */
export function collidesWith(at: Date, occupied: ReadonlySet<string>): boolean {
  return occupied.has(slotKeyOf(at));
}

/**
 * Whether a moment sits on one of this cadence's slots.
 *
 * What the calendar dots a day with, and what tells a hand-typed time apart from a
 * cadence one without having to re-derive the rule in a template.
 */
export function isCadenceSlot(cadence: CadenceKey, at: Date): boolean {
  const slots = CADENCES[cadence];
  if (!slots) {
    throw new Error(`No cadence is recorded under the key ${JSON.stringify(cadence)}.`);
  }
  return slots.some(
    (slot) =>
      slot.weekday === at.getDay() &&
      slot.hour === at.getHours() &&
      slot.minute === at.getMinutes(),
  );
}
