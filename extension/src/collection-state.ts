// Per-video "last snapshot captured" state, OWNED BY THE COLLECTOR for cadence
// tiering. This is the local state src/collector.ts consults to decide which
// videos are "due" each ~6h cycle (age <7d every cycle, 7-28d daily, 28-365d
// weekly, >1y monthly). It also doubles as the collector's "known videos" set.
//
// Shape: channelId -> videoId -> ISO timestamp of the most recent snapshot we
// emitted for that video. Stored in chrome.storage.local under one key.
//
// The key carries the snapshot schema: 0.2.11 starts a new map ('collectionStateV2') so every
// video is due once and gets one schemaVersion 2 snapshot (lifetime engaged views and
// earnings) on the first cycle, instead of old videos waiting up to a month for their tier.
// The 0.2.10 map is removed on the first write.

const COLLECTION_STATE_KEY = 'collectionStateV2';
const RETIRED_COLLECTION_STATE_KEY = 'collectionState';
// channelId -> videoId -> ISO time its first-week record was collected (and queued).
const FIRST_WEEK_STATE_KEY = 'firstWeekState';

/** videoId -> ISO capturedAt of the last snapshot emitted for that video. */
export type ChannelVideoState = Record<string, string>;
type CollectionState = Record<string, ChannelVideoState>;

async function readMap(key: string): Promise<CollectionState> {
  const stored = await chrome.storage.local.get(key);
  const raw = stored[key];
  return raw && typeof raw === 'object' ? (raw as CollectionState) : {};
}

/** The per-video last-capture map for one channel (empty on first-ever run). */
export async function getChannelVideoState(channelId: string): Promise<ChannelVideoState> {
  const state = await readMap(COLLECTION_STATE_KEY);
  const channel = state[channelId];
  return channel && typeof channel === 'object' ? channel : {};
}

/**
 * Record that we emitted a snapshot for these videos at the given capturedAt.
 * Merges into the existing per-channel map (read-modify-write). Called by the
 * collector for exactly the videos whose snapshots it returns this cycle, so a
 * later cycle can honour each video's cadence tier.
 */
export async function recordSnapshotTimes(
  channelId: string,
  entries: Array<{ videoId: string; capturedAt: string }>,
): Promise<void> {
  if (entries.length === 0) return;
  const state = await readMap(COLLECTION_STATE_KEY);
  const channel: ChannelVideoState = { ...(state[channelId] ?? {}) };
  for (const { videoId, capturedAt } of entries) {
    channel[videoId] = capturedAt;
  }
  state[channelId] = channel;
  await chrome.storage.local.set({ [COLLECTION_STATE_KEY]: state });
  await chrome.storage.local.remove(RETIRED_COLLECTION_STATE_KEY);
}

/** videoId -> when its first-week record was collected, for one channel. */
export async function getFirstWeekState(channelId: string): Promise<ChannelVideoState> {
  const state = await readMap(FIRST_WEEK_STATE_KEY);
  const channel = state[channelId];
  return channel && typeof channel === 'object' ? channel : {};
}

/**
 * Record that these videos' first weeks were collected now, and forget entries older than
 * `keepDays` (by then the video is past the collector's lookback and never asked for again).
 */
export async function recordFirstWeeks(channelId: string, videoIds: string[], keepDays: number): Promise<void> {
  const state = await readMap(FIRST_WEEK_STATE_KEY);
  const channel: ChannelVideoState = { ...(state[channelId] ?? {}) };
  const now = new Date();
  const cutoff = now.getTime() - keepDays * 24 * 3_600_000;
  let pruned = 0;
  for (const [videoId, at] of Object.entries(channel)) {
    if (Date.parse(at) < cutoff) {
      delete channel[videoId];
      pruned++;
    }
  }
  if (videoIds.length === 0 && pruned === 0) return;
  for (const videoId of videoIds) channel[videoId] = now.toISOString();
  state[channelId] = channel;
  await chrome.storage.local.set({ [FIRST_WEEK_STATE_KEY]: state });
}
