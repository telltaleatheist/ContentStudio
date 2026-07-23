// Persistent outbox for payloads that could not be delivered to ContentStudio.
//
// Policy: no retries-with-degradation. A failed push stays queued in
// chrome.storage.local exactly as it was, and is retried on the next alarm
// cycle or when the user presses "Sync now". Entries are only removed after a
// successful POST.

import type { Snapshot, VideoRecord } from './types';
import { IngestError, pushSnapshots, pushVideos, type IngestFailureKind } from './ingest-client';

export type OutboxEntry =
  | { id: string; queuedAt: string; kind: 'videos'; videos: VideoRecord[] }
  | { id: string; queuedAt: string; kind: 'snapshots'; snapshots: Snapshot[] };

const OUTBOX_KEY = 'outbox';

export async function getOutbox(): Promise<OutboxEntry[]> {
  const stored = await chrome.storage.local.get(OUTBOX_KEY);
  const raw = stored[OUTBOX_KEY];
  return Array.isArray(raw) ? (raw as OutboxEntry[]) : [];
}

async function setOutbox(entries: OutboxEntry[]): Promise<void> {
  await chrome.storage.local.set({ [OUTBOX_KEY]: entries });
}

export async function outboxDepth(): Promise<number> {
  return (await getOutbox()).length;
}

export async function enqueueVideos(videos: VideoRecord[]): Promise<void> {
  const entries = await getOutbox();
  entries.push({ id: crypto.randomUUID(), queuedAt: new Date().toISOString(), kind: 'videos', videos });
  await setOutbox(entries);
}

export async function enqueueSnapshots(snapshots: Snapshot[]): Promise<void> {
  const entries = await getOutbox();
  entries.push({ id: crypto.randomUUID(), queuedAt: new Date().toISOString(), kind: 'snapshots', snapshots });
  await setOutbox(entries);
}

export interface FlushResult {
  attempted: number;
  delivered: number;
  remaining: number;
  /**
   * Set when the flush stopped early because of an environmental failure
   * (unreachable / unexpected-response) that would fail every remaining entry
   * too. The failing entry stays queued.
   */
  stopped: { kind: IngestFailureKind; message: string } | null;
  /**
   * Per-entry validation failures (HTTP 400). These entries stay queued —
   * they indicate schema drift that a human must look at — but they do not
   * block delivery of later entries.
   */
  entryErrors: Array<{ id: string; kind: IngestFailureKind; message: string }>;
}

async function sendEntry(entry: OutboxEntry): Promise<void> {
  if (entry.kind === 'videos') {
    await pushVideos(entry.videos);
  } else {
    await pushSnapshots(entry.snapshots);
  }
}

/**
 * Attempt to deliver every queued entry, oldest first.
 *
 * - Success: entry is removed.
 * - IngestError 'validation': entry stays queued, error recorded, flush
 *   continues (the failure is specific to that payload).
 * - IngestError 'unreachable' / 'unexpected-response':
 *   entry stays queued and the flush stops (environmental — the rest would
 *   fail identically).
 *
 * Never throws for IngestErrors; the result carries every failure distinctly.
 */
export async function flushOutbox(): Promise<FlushResult> {
  const entries = await getOutbox();
  const result: FlushResult = {
    attempted: 0,
    delivered: 0,
    remaining: entries.length,
    stopped: null,
    entryErrors: [],
  };

  const surviving: OutboxEntry[] = [];
  let stopped = false;

  for (const entry of entries) {
    if (stopped) {
      surviving.push(entry);
      continue;
    }
    result.attempted += 1;
    try {
      await sendEntry(entry);
      result.delivered += 1;
    } catch (err) {
      if (err instanceof IngestError) {
        surviving.push(entry);
        if (err.kind === 'validation') {
          result.entryErrors.push({ id: entry.id, kind: err.kind, message: err.message });
        } else {
          result.stopped = { kind: err.kind, message: err.message };
          stopped = true;
        }
      } else {
        // Not an IngestError — genuinely unexpected. Keep the entry, stop the
        // flush, and re-surface after persisting state. Never swallowed.
        surviving.push(entry);
        await setOutbox([...surviving, ...entries.slice(entries.indexOf(entry) + 1)]);
        throw err;
      }
    }
  }

  await setOutbox(surviving);
  result.remaining = surviving.length;
  return result;
}
