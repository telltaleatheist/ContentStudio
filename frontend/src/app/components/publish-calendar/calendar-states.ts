/**
 * Calendar state derivation — the pure half of the publish calendar.
 *
 * Split out of the component deliberately: which state a chip is in, and whether it can
 * still be scheduled, are the rules the design's §2.5 table specifies, and they are worth
 * being able to exercise without an Angular test bed. Nothing here touches a signal, a
 * template or the DOM.
 */

import { SPREAKER_DESTINATION } from '../../features/publish/publish.types';

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

/** Where an item is going. The readiness bar is different for each. */
export type Destination = 'youtube' | 'spreaker';

/** The subset of a record the readiness rules read. */
export interface ReadinessFacts {
  channelId: string | null;
  videoId: string | null;
  status: string;
  hasThumbnail: boolean;
  /** How many titles the operator has chosen. The first one IS the video's title. */
  abCount: number;
  /** The destination flag: a podcast episode goes to Spreaker, never to YouTube. */
  isPodcast: boolean;
  /** Set once an episode exists on Spreaker — the podcast's equivalent of a video id. */
  spreakerEpisodeId: number | null;
  /** Is an episode audio file attached? An episode with none cannot be uploaded at all. */
  hasEpisodeAudio: boolean;
}

export function destinationOf(facts: { isPodcast: boolean }): Destination {
  return facts.isPodcast ? 'spreaker' : 'youtube';
}

/**
 * Which tab a row files under: a channel id, `spreaker`, or null for nothing.
 *
 * DESTINATION FIRST, and that is the whole rule. A podcast episode keeps the YouTube
 * channel id it was routed with — it has to, or there would be no way to route it back —
 * so grouping on the channel id alone would file every episode under a channel it is
 * never going to reach, and the Spreaker tab would be permanently empty while the podcast
 * work sat under Unfiltered.
 *
 * Null means this row belongs to no tab at all: not routed, and not a podcast. That is a
 * state, not a default — it is what keeps an unrouted item visible on every tab instead of
 * being dimmed away on all of them.
 */
export function laneTabOf(row: { destination: Destination; channelId: string | null }): string | null {
  return row.destination === 'spreaker' ? SPREAKER_DESTINATION : row.channelId;
}

/**
 * Is this row pushed into the background because some OTHER tab is in force?
 *
 * `channelKnown` is passed in rather than looked up because only the component holds the
 * registry. It is false for both "no channel" and "an id the registry does not have", and
 * both of those rows stay at full strength on every tab: a row that needs routing
 * attention must not fade into somebody else's background.
 */
export function dimmedFor(
  row: { destination: Destination; channelId: string | null },
  channelKnown: boolean,
  activeTab: string | null
): boolean {
  const tab = laneTabOf(row);
  if (tab === null) return false;
  // A stored channel id the registry does not hold. It has a tab in name only — there is
  // no such tab to be on — so it stays at full strength wherever the operator is looking.
  if (row.destination === 'youtube' && !channelKnown) return false;
  return tab !== activeTab;
}

/**
 * The calendar's two GROUPS: Owen Morgan's channels (the three YouTube channels and the
 * podcast) and Little Goose Productions, the kids music channel.
 *
 * Separate boards rather than more tabs on one strip (Owen, 2026-10-16: "maybe it should
 * be its own tab entirely. one for the owen morgan channels, one for the little goose
 * channels"). A kids channel's release week has nothing to do with the commentary
 * channels', and one strip of five tabs made every count, the tray and the bulk upload
 * speak for both businesses at once.
 */
export type ChannelGroup = 'owen-morgan' | 'little-goose';

/** The groups in switcher order, with the words the switcher prints. */
export const CHANNEL_GROUPS: ReadonlyArray<{ id: ChannelGroup; label: string }> = [
  { id: 'owen-morgan', label: 'Owen Morgan' },
  { id: 'little-goose', label: 'Little Goose' },
];

/**
 * The prompt set that makes a channel Little Goose's.
 *
 * Read off the ROUTING rather than off a new field on the channel record: channels.json
 * already says which prompt sets publish to which channel (it is what
 * resolveChannelForPromptSet reads), so the group is a fact the registry already holds. A
 * second `group` field would be a second answer to the same question, free to disagree
 * with the first.
 */
export const LITTLE_GOOSE_PROMPT_SET = 'youtube-littlegoose';

/**
 * Which group a registered channel belongs to.
 *
 * A channel routed the Little Goose prompt set is Little Goose's; every other channel is
 * Owen Morgan's. That second half is the rule rather than a default: before Little Goose
 * existed every channel on this install was Owen's, and a channel with no prompt sets
 * routed at all is still one of his until something says otherwise.
 *
 * A record with no `promptSets` array is refused by name. The registry always writes one,
 * so its absence is a malformed record, and filing it under either group would be a guess.
 */
export function channelGroupOf(channel: { channelId: string; promptSets: readonly string[] }): ChannelGroup {
  if (!Array.isArray(channel.promptSets)) {
    throw new Error(
      `Channel ${channel.channelId} has no promptSets list in the registry, so the calendar ` +
      `cannot tell which group it belongs to.`
    );
  }
  return channel.promptSets.includes(LITTLE_GOOSE_PROMPT_SET) ? 'little-goose' : 'owen-morgan';
}

/**
 * Which group a row — a chip, a tray row, a mirrored video — files under.
 *
 * In order, and each step is the stronger fact:
 *   1. Spreaker is Owen Morgan's. The podcast is his show, whatever YouTube channel the
 *      episode was routed via.
 *   2. A registered channel decides. That is where the video will actually be uploaded,
 *      so it outranks the prompt set it was generated with.
 *   3. Otherwise the prompt set decides: unrouted, or routed to an id the registry does
 *      not hold. This is what puts a Little Goose song with no channel yet in the Little
 *      Goose tray — exactly the row that needs routing — rather than in Owen's.
 *
 * `promptSet` is null for a row that has none (a mirrored YouTube video, an item from
 * before prompt sets were recorded), which is Owen Morgan's by the same rule as above.
 */
export function rowGroupOf(
  row: { destination: Destination; channelId: string | null; promptSet: string | null },
  channelGroups: ReadonlyMap<string, ChannelGroup>
): ChannelGroup {
  if (row.destination === 'spreaker') return 'owen-morgan';
  if (row.channelId !== null) {
    const group = channelGroups.get(row.channelId);
    if (group !== undefined) return group;
  }
  return row.promptSet === LITTLE_GOOSE_PROMPT_SET ? 'little-goose' : 'owen-morgan';
}

/** A stored group value, checked: anything else in storage is not a group. */
export function isChannelGroup(value: string | null): value is ChannelGroup {
  return CHANNEL_GROUPS.some((group) => group.id === value);
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
  // A YOUTUBE CHANNEL IS A YOUTUBE REQUIREMENT. A Spreaker push authorizes against the
  // show id in the stored credentials and never reads channelId — spreaker-push.ts does
  // not mention the field. A podcast record keeps one only so the destination can be
  // changed back, so demanding it held finished episodes at "needs channel" forever.
  if (!facts.isPodcast && facts.channelId === null) missing.push('channel');
  if (facts.abCount < 1) missing.push('title');
  // A THUMBNAIL IS A YOUTUBE REQUIREMENT, not a universal one. Spreaker's episode image
  // is optional and this app never sends one, so demanding it of a podcast episode would
  // hold back an item that is in fact ready and could never be satisfied.
  if (!facts.isPodcast && !facts.hasThumbnail) missing.push('thumbnail');
  // AN EPISODE IS ITS AUDIO. The mirror image of the thumbnail rule above, and the harder
  // of the two: a video with no thumbnail still uploads, while spreaker-push refuses an
  // episode with no audio before sending a byte — "an episode is the audio", in its own
  // words. Leaving it out of the checklist is what let the board call an episode ready
  // and then offer a run that could only fail.
  if (facts.isPodcast && !facts.hasEpisodeAudio) missing.push('episode audio');
  return missing;
}

/**
 * How far along an item is, judged against ITS OWN destination.
 *
 * WHAT THIS STILL CANNOT SEE is the file itself. `hasEpisodeAudio` is the presence of a
 * PATH on the record, so an episode whose audio has since been moved, renamed or left on
 * an unmounted volume reads `ready` here and is refused at dispatch — the push re-measures
 * the file against the bytes every time, and it is right to. That is the honest split:
 * this rule speaks for the decisions, and the push speaks for the disk.
 */
export function readinessOf(facts: ReadinessFacts): Readiness {
  const shipped = facts.isPodcast ? facts.spreakerEpisodeId !== null : facts.videoId !== null;
  if (shipped || facts.status === 'published') return 'done';
  return missingFor(facts).length === 0 ? 'ready' : 'incomplete';
}
