/**
 * Analytics Store Service
 *
 * Rolling per-channel storage for YouTube analytics snapshots under
 * <userData>/analytics/:
 *
 *   analytics/
 *     channels.json                    ChannelRegistryEntry[]
 *     cross-channel-insights.json      CrossChannelInsights
 *     <channelId>/
 *       videos.json                    VideoRecord[]
 *       verdicts.json                  VideoVerdict[]
 *       insights.json                  ChannelInsights
 *       snapshots/YYYY-MM.jsonl        append-only, one Snapshot per line
 *                                      (file chosen by month of capturedAt)
 *
 * All mutations run through a serialized write queue (same discipline as
 * OutputHandlerService) so concurrent ingests can't clobber each other's
 * read-modify-write.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  ANALYTICS_SCHEMA_VERSION,
  ChannelInsights,
  ChannelRegistryEntry,
  CrossChannelInsights,
  Snapshot,
  SnapshotValidationError,
  VideoRecord,
  VideoRecordValidationError,
  VideoVerdict,
} from './analytics-types';

const VALID_FORMATS = ['long', 'short', 'live'];
const VALID_TITLE_ORIGINS = ['upload', 'manual-edit', 'ab-rotation', 'test-compare'];
const VALID_SOURCES = ['studio-extension', 'analytics-api'];

/** True when `value` is a parseable ISO date string. */
function isParseableIso(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}

/** True when `value` is a finite number. */
function isNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** True when `value` is a finite number or null (null = "not captured"). */
function isNumOrNull(value: unknown): boolean {
  return value === null || isNum(value);
}

/**
 * Validate a Snapshot per the ingest contract. Returns the list of failing
 * fields (empty = valid). NO coercion is performed.
 */
export function validateSnapshot(raw: any): string[] {
  const reasons: string[] = [];
  if (!raw || typeof raw !== 'object') {
    return ['snapshot is not an object'];
  }
  if (raw.schemaVersion !== ANALYTICS_SCHEMA_VERSION) {
    reasons.push(`schemaVersion must be ${ANALYTICS_SCHEMA_VERSION} (got ${JSON.stringify(raw.schemaVersion)})`);
  }
  if (typeof raw.videoId !== 'string' || raw.videoId.length === 0) reasons.push('videoId must be a non-empty string');
  if (typeof raw.channelId !== 'string' || raw.channelId.length === 0) reasons.push('channelId must be a non-empty string');
  if (!isParseableIso(raw.capturedAt)) reasons.push('capturedAt must be a parseable ISO date string');
  if (!VALID_SOURCES.includes(raw.source)) reasons.push(`source must be one of ${VALID_SOURCES.join('|')}`);
  if (!isNum(raw.videoAgeHours)) reasons.push('videoAgeHours must be a number');
  if (!isNumOrNull(raw.impressions)) reasons.push('impressions must be a number or null');
  if (!isNumOrNull(raw.impressionsCtr)) reasons.push('impressionsCtr must be a number or null');
  if (!isNum(raw.views)) reasons.push('views must be a number');
  if (!isNum(raw.watchHours)) reasons.push('watchHours must be a number');
  if (!isNumOrNull(raw.avgViewDurationSec)) reasons.push('avgViewDurationSec must be a number or null');
  if (!isNumOrNull(raw.avgPctViewed)) reasons.push('avgPctViewed must be a number or null');

  if (raw.retention !== null) {
    if (!raw.retention || typeof raw.retention !== 'object'
      || !isNumOrNull(raw.retention.at30s) || !isNumOrNull(raw.retention.at60s)) {
      reasons.push('retention must be null or { at30s: number|null, at60s: number|null }');
    }
  }
  if (raw.trafficShare !== null) {
    const ts = raw.trafficShare;
    const keys = ['browse', 'suggested', 'search', 'external', 'notifications', 'other'];
    if (!ts || typeof ts !== 'object' || keys.some((k) => !isNum(ts[k]))) {
      reasons.push(`trafficShare must be null or an object with numeric ${keys.join('/')}`);
    }
  }
  if (raw.ctrBySource !== null) {
    const cs = raw.ctrBySource;
    if (!cs || typeof cs !== 'object'
      || !isNumOrNull(cs.browse) || !isNumOrNull(cs.search) || !isNumOrNull(cs.suggested)) {
      reasons.push('ctrBySource must be null or { browse, search, suggested } of number|null');
    }
  }
  if (raw.topSearchTerms !== null) {
    if (!Array.isArray(raw.topSearchTerms)
      || raw.topSearchTerms.some((t: any) => !t || typeof t.term !== 'string' || t.term.length === 0 || !isNum(t.views))) {
      reasons.push('topSearchTerms must be null or Array<{ term: string; views: number }>');
    }
  }
  if (!isNumOrNull(raw.subsGained)) reasons.push('subsGained must be a number or null');
  if (!isNumOrNull(raw.likes)) reasons.push('likes must be a number or null');
  if (!isNumOrNull(raw.comments)) reasons.push('comments must be a number or null');
  if (!isNumOrNull(raw.shares)) reasons.push('shares must be a number or null');
  return reasons;
}

/**
 * Validate a VideoRecord. Returns the list of failing fields (empty = valid).
 */
export function validateVideoRecord(raw: any): string[] {
  const reasons: string[] = [];
  if (!raw || typeof raw !== 'object') {
    return ['video record is not an object'];
  }
  if (typeof raw.videoId !== 'string' || raw.videoId.length === 0) reasons.push('videoId must be a non-empty string');
  if (typeof raw.channelId !== 'string' || raw.channelId.length === 0) reasons.push('channelId must be a non-empty string');
  if (!isParseableIso(raw.publishedAt)) reasons.push('publishedAt must be a parseable ISO date string');
  if (!isNum(raw.durationSec)) reasons.push('durationSec must be a number');
  if (!VALID_FORMATS.includes(raw.format)) reasons.push(`format must be one of ${VALID_FORMATS.join('|')}`);
  if (raw.jobId !== undefined && typeof raw.jobId !== 'string') reasons.push('jobId must be a string when present');
  if (raw.itemIndex !== undefined && !isNum(raw.itemIndex)) reasons.push('itemIndex must be a number when present');
  if (!Array.isArray(raw.titleHistory) || raw.titleHistory.length === 0) {
    reasons.push('titleHistory must be a non-empty array');
  } else {
    raw.titleHistory.forEach((span: any, i: number) => {
      if (!span || typeof span !== 'object') { reasons.push(`titleHistory[${i}] is not an object`); return; }
      if (typeof span.title !== 'string' || span.title.length === 0) reasons.push(`titleHistory[${i}].title must be a non-empty string`);
      if (!isParseableIso(span.from)) reasons.push(`titleHistory[${i}].from must be a parseable ISO date string`);
      if (span.to !== null && !isParseableIso(span.to)) reasons.push(`titleHistory[${i}].to must be null or a parseable ISO date string`);
      if (!VALID_TITLE_ORIGINS.includes(span.origin)) reasons.push(`titleHistory[${i}].origin must be one of ${VALID_TITLE_ORIGINS.join('|')}`);
    });
  }
  return reasons;
}

/** Month key ("YYYY-MM", UTC) for a capturedAt timestamp — names the monthly file. */
function monthKeyOf(capturedAt: string): string {
  const d = new Date(capturedAt);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export class AnalyticsStoreService {
  private baseDir: string;
  // Serializes all mutations (same discipline as OutputHandlerService.writeQueue)
  // so concurrent ingests can't clobber each other's read-modify-write.
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
    console.log('[AnalyticsStore] Initialized at:', this.baseDir);
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  /** Chain `task` onto the serialized write queue (one failed task doesn't poison it). */
  private enqueue<T>(task: () => T): Promise<T> {
    const run = this.writeQueue.then(() => task());
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private channelDir(channelId: string): string {
    return path.join(this.baseDir, channelId);
  }

  private snapshotsDir(channelId: string): string {
    return path.join(this.channelDir(channelId), 'snapshots');
  }

  private readJson<T>(filePath: string): T | null {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  }

  private writeJson(filePath: string, data: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  // ==================== CHANNEL REGISTRY ====================

  listChannels(): ChannelRegistryEntry[] {
    return this.readJson<ChannelRegistryEntry[]>(path.join(this.baseDir, 'channels.json')) || [];
  }

  saveChannels(channels: ChannelRegistryEntry[]): Promise<void> {
    return this.enqueue(() => {
      this.writeJson(path.join(this.baseDir, 'channels.json'), channels);
      console.log(`[AnalyticsStore] Saved ${channels.length} channel registry entries`);
    });
  }

  // ==================== VIDEO RECORDS ====================

  listVideos(channelId: string): VideoRecord[] {
    return this.readJson<VideoRecord[]>(path.join(this.channelDir(channelId), 'videos.json')) || [];
  }

  /**
   * Upsert VideoRecords (validated; throws VideoRecordValidationError listing the
   * failing fields on bad input). Merge semantics for an existing videoId:
   * scalar fields are replaced by the incoming record; titleHistory is MERGED —
   * when the incoming record's current title differs from the stored current
   * title, the stored current span is closed (to = now) and a new span appended.
   * Returns the number of records upserted.
   */
  upsertVideos(records: VideoRecord[]): Promise<number> {
    // Validate BEFORE queueing so a bad batch rejects without touching disk.
    for (const record of records) {
      const reasons = validateVideoRecord(record);
      if (reasons.length > 0) {
        throw new VideoRecordValidationError(
          reasons.map((r) => `videoId=${record?.videoId ?? '<missing>'}: ${r}`)
        );
      }
    }

    return this.enqueue(() => {
      // Group by channel so each channel's videos.json is read/written once.
      const byChannel = new Map<string, VideoRecord[]>();
      for (const record of records) {
        const list = byChannel.get(record.channelId) || [];
        list.push(record);
        byChannel.set(record.channelId, list);
      }

      for (const [channelId, channelRecords] of byChannel) {
        const filePath = path.join(this.channelDir(channelId), 'videos.json');
        const existing = this.readJson<VideoRecord[]>(filePath) || [];
        const byId = new Map(existing.map((v) => [v.videoId, v]));

        for (const incoming of channelRecords) {
          const stored = byId.get(incoming.videoId);
          if (!stored) {
            byId.set(incoming.videoId, incoming);
            continue;
          }
          byId.set(incoming.videoId, this.mergeVideoRecord(stored, incoming));
        }

        this.writeJson(filePath, Array.from(byId.values()));
      }

      console.log(`[AnalyticsStore] Upserted ${records.length} video record(s) across ${byChannel.size} channel(s)`);
      return records.length;
    });
  }

  /**
   * Merge an incoming VideoRecord into a stored one. Scalars take the incoming
   * values; titleHistory keeps the stored spans and — when the incoming CURRENT
   * title differs from the stored current title — closes the stored current span
   * (to = now) and appends the incoming current span.
   */
  private mergeVideoRecord(stored: VideoRecord, incoming: VideoRecord): VideoRecord {
    const history = stored.titleHistory.map((span) => ({ ...span }));
    const storedCurrent = history.find((span) => span.to === null);
    const incomingCurrent = incoming.titleHistory.find((span) => span.to === null);

    if (incomingCurrent && (!storedCurrent || storedCurrent.title !== incomingCurrent.title)) {
      const now = new Date().toISOString();
      if (storedCurrent) {
        storedCurrent.to = now;
      }
      history.push({
        title: incomingCurrent.title,
        from: incomingCurrent.from || now,
        to: null,
        origin: incomingCurrent.origin,
      });
    }

    return {
      ...incoming,
      titleHistory: history,
    };
  }

  // ==================== SNAPSHOTS ====================

  /**
   * Validate + append snapshots to the per-month JSONL files (one Snapshot per
   * line; file chosen by month of capturedAt). Throws SnapshotValidationError
   * (listing every failing field of the first bad snapshot) without writing
   * anything when any snapshot in the batch is invalid.
   * Returns the number of snapshots appended.
   */
  appendSnapshots(snapshots: Snapshot[]): Promise<number> {
    // Validate the whole batch BEFORE queueing — all-or-nothing ingest.
    for (const snapshot of snapshots) {
      const reasons = validateSnapshot(snapshot);
      if (reasons.length > 0) {
        throw new SnapshotValidationError(
          reasons.map((r) => `videoId=${(snapshot as any)?.videoId ?? '<missing>'}: ${r}`)
        );
      }
    }

    return this.enqueue(() => {
      // Group lines per target file so each file gets a single append.
      const byFile = new Map<string, string[]>();
      for (const snapshot of snapshots) {
        const filePath = path.join(this.snapshotsDir(snapshot.channelId), `${monthKeyOf(snapshot.capturedAt)}.jsonl`);
        const lines = byFile.get(filePath) || [];
        lines.push(JSON.stringify(snapshot));
        byFile.set(filePath, lines);
      }

      for (const [filePath, lines] of byFile) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.appendFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
      }

      console.log(`[AnalyticsStore] Appended ${snapshots.length} snapshot(s) across ${byFile.size} monthly file(s)`);
      return snapshots.length;
    });
  }

  /** Sorted list of month keys ("YYYY-MM") that have snapshot files for a channel. */
  listSnapshotMonths(channelId: string): string[] {
    const dir = this.snapshotsDir(channelId);
    if (!fs.existsSync(dir)) {
      return [];
    }
    return fs.readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f))
      .map((f) => f.replace('.jsonl', ''))
      .sort();
  }

  /** Read all snapshots in one monthly file (skips blank lines; bad JSON throws). */
  readSnapshotMonth(channelId: string, monthKey: string): Snapshot[] {
    const filePath = path.join(this.snapshotsDir(channelId), `${monthKey}.jsonl`);
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return content
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Snapshot);
  }

  /**
   * Iterate every snapshot for a channel, month file by month file (oldest
   * first), without materializing all months at once.
   */
  *iterateSnapshots(channelId: string): Generator<Snapshot> {
    for (const monthKey of this.listSnapshotMonths(channelId)) {
      for (const snapshot of this.readSnapshotMonth(channelId, monthKey)) {
        yield snapshot;
      }
    }
  }

  /** Convenience: all snapshots for a channel (iterated per month file). */
  loadAllSnapshots(channelId: string): Snapshot[] {
    return Array.from(this.iterateSnapshots(channelId));
  }

  /** Count snapshots + latest capturedAt for a channel without keeping them all in memory. */
  getSnapshotStats(channelId: string): { snapshotCount: number; lastCapturedAt: string | null } {
    let snapshotCount = 0;
    let lastCapturedAt: string | null = null;
    for (const snapshot of this.iterateSnapshots(channelId)) {
      snapshotCount++;
      if (!lastCapturedAt || snapshot.capturedAt > lastCapturedAt) {
        lastCapturedAt = snapshot.capturedAt;
      }
    }
    return { snapshotCount, lastCapturedAt };
  }

  /**
   * Compact old snapshot months: months older than 12 months (relative to now)
   * are rewritten keeping only each video's LAST snapshot of that month.
   * Counters are lifetime-cumulative, so this is lossless at monthly resolution.
   * Returns per-channel counts of removed lines.
   */
  compactOldSnapshots(): Promise<Array<{ channelId: string; month: string; before: number; after: number }>> {
    return this.enqueue(() => {
      const cutoff = new Date();
      cutoff.setUTCMonth(cutoff.getUTCMonth() - 12);
      const cutoffKey = `${cutoff.getUTCFullYear()}-${String(cutoff.getUTCMonth() + 1).padStart(2, '0')}`;

      const results: Array<{ channelId: string; month: string; before: number; after: number }> = [];

      for (const channel of this.listChannels()) {
        for (const monthKey of this.listSnapshotMonths(channel.channelId)) {
          if (monthKey >= cutoffKey) {
            continue; // month is within the rolling 12-month window
          }
          const snapshots = this.readSnapshotMonth(channel.channelId, monthKey);
          // Keep the LAST snapshot per video (by capturedAt) within this month.
          const lastByVideo = new Map<string, Snapshot>();
          for (const snapshot of snapshots) {
            const current = lastByVideo.get(snapshot.videoId);
            if (!current || snapshot.capturedAt > current.capturedAt) {
              lastByVideo.set(snapshot.videoId, snapshot);
            }
          }
          if (lastByVideo.size === snapshots.length) {
            continue; // nothing to compact
          }
          const kept = Array.from(lastByVideo.values())
            .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
          const filePath = path.join(this.snapshotsDir(channel.channelId), `${monthKey}.jsonl`);
          fs.writeFileSync(filePath, kept.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf-8');
          results.push({ channelId: channel.channelId, month: monthKey, before: snapshots.length, after: kept.length });
          console.log(`[AnalyticsStore] Compacted ${channel.channelId}/${monthKey}: ${snapshots.length} -> ${kept.length}`);
        }
      }

      return results;
    });
  }

  // ==================== VERDICTS + INSIGHTS ====================

  loadVerdicts(channelId: string): VideoVerdict[] {
    return this.readJson<VideoVerdict[]>(path.join(this.channelDir(channelId), 'verdicts.json')) || [];
  }

  saveVerdicts(channelId: string, verdicts: VideoVerdict[]): Promise<void> {
    return this.enqueue(() => {
      this.writeJson(path.join(this.channelDir(channelId), 'verdicts.json'), verdicts);
      console.log(`[AnalyticsStore] Saved ${verdicts.length} verdict(s) for ${channelId}`);
    });
  }

  loadChannelInsights(channelId: string): ChannelInsights | null {
    return this.readJson<ChannelInsights>(path.join(this.channelDir(channelId), 'insights.json'));
  }

  saveChannelInsights(channelId: string, insights: ChannelInsights): Promise<void> {
    return this.enqueue(() => {
      this.writeJson(path.join(this.channelDir(channelId), 'insights.json'), insights);
      console.log(`[AnalyticsStore] Saved channel insights for ${channelId}`);
    });
  }

  loadCrossChannelInsights(): CrossChannelInsights | null {
    return this.readJson<CrossChannelInsights>(path.join(this.baseDir, 'cross-channel-insights.json'));
  }

  saveCrossChannelInsights(insights: CrossChannelInsights): Promise<void> {
    return this.enqueue(() => {
      this.writeJson(path.join(this.baseDir, 'cross-channel-insights.json'), insights);
      console.log('[AnalyticsStore] Saved cross-channel insights');
    });
  }
}
