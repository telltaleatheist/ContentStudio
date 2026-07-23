// Per-video "last snapshot captured" state, OWNED BY THE COLLECTOR for cadence
// tiering. This is the local state src/collector.ts consults to decide which
// videos are "due" each ~6h cycle (age <7d every cycle, 7-28d daily, 28-365d
// weekly, >1y monthly). It also doubles as the collector's "known videos" set.
//
// Shape: channelId -> videoId -> ISO timestamp of the most recent snapshot we
// emitted for that video. Stored in chrome.storage.local under one key.

const COLLECTION_STATE_KEY = 'collectionState';

/** videoId -> ISO capturedAt of the last snapshot emitted for that video. */
export type ChannelVideoState = Record<string, string>;
type CollectionState = Record<string, ChannelVideoState>;

async function readState(): Promise<CollectionState> {
  const stored = await chrome.storage.local.get(COLLECTION_STATE_KEY);
  const raw = stored[COLLECTION_STATE_KEY];
  return raw && typeof raw === 'object' ? (raw as CollectionState) : {};
}

/** The per-video last-capture map for one channel (empty on first-ever run). */
export async function getChannelVideoState(channelId: string): Promise<ChannelVideoState> {
  const state = await readState();
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
  const state = await readState();
  const channel: ChannelVideoState = { ...(state[channelId] ?? {}) };
  for (const { videoId, capturedAt } of entries) {
    channel[videoId] = capturedAt;
  }
  state[channelId] = channel;
  await chrome.storage.local.set({ [COLLECTION_STATE_KEY]: state });
}
