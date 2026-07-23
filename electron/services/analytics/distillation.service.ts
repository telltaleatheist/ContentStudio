/**
 * Distillation Service
 *
 * Turns raw snapshot series into per-video verdicts, per-channel insights and
 * cross-channel insights:
 *
 *   Snapshots (rolling JSONL) --computeVerdicts--> VideoVerdict[]
 *                             --computeChannelInsights--> ChannelInsights
 *                             --computeCrossChannelInsights--> CrossChannelInsights
 *
 * Percentiles are computed WITHIN a channel across videos that HAVE the metric
 * (nulls excluded, never treated as 0), over the age-matched first-week cohort.
 */

import {
  ChannelInsights,
  CrossChannelInsights,
  Snapshot,
  VideoRecord,
  VideoVerdict,
  VideoVerdictSummary,
} from './analytics-types';
import { AnalyticsStoreService } from './analytics-store.service';

// First-week snapshot targeting: nearest snapshot to 168h of video age, within ±48h.
const FIRST_WEEK_TARGET_HOURS = 168;
const FIRST_WEEK_TOLERANCE_HOURS = 48;

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
// How far back channel insights (and thus the AI prompt block) look for "what works
// now": baselines, packaging rankings, and search terms are drawn ONLY from videos
// published within this window. Older videos' lifetime CTR is confounded by years of
// stale feed impressions, and for a topical channel old topics aren't useful guidance.
// Widen/narrow here (a natural future candidate for a per-channel UI setting).
const INSIGHTS_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;
// Minimum lifetime thumbnail impressions for a video to appear in ANY packaging
// ranking — per-channel top/bottom AND cross-channel overperformers. Below this, CTR
// is statistically meaningless (unlisted / dead / barely-seen videos), and such a
// video must never be injected into the AI as a "top example to emulate".
const MIN_PACKAGING_IMPRESSIONS = 1000;

export interface DistillationSummary {
  channels: number;
  videosProcessed: number;
  verdictsWritten: number;
}

/**
 * Percentile rank of `value` within `cohort` (which includes value's own entry):
 * fraction of OTHER entries strictly below it, scaled to 0..100. A single-entry
 * cohort ranks at 50 (no information either way).
 */
function percentileRank(cohort: number[], value: number): number {
  if (cohort.length <= 1) {
    return 50;
  }
  const below = cohort.filter((x) => x < value).length;
  return (below / (cohort.length - 1)) * 100;
}

/** Median of a list of numbers; null for an empty list. */
function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Round to one decimal for stored percentiles/scores (keeps JSON readable). */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export class DistillationService {
  private store: AnalyticsStoreService;

  constructor(store: AnalyticsStoreService) {
    this.store = store;
  }

  // ==================== VERDICTS ====================

  /**
   * Compute a VideoVerdict per VideoRecord for a channel.
   * - lifetime = latest snapshot
   * - firstWeek = snapshot nearest videoAgeHours 168 within ±48h (null when none
   *   exists — expected for back-catalog imports)
   * - percentiles within the channel over videos that HAVE the metric
   * - abTest carried through from a previously stored verdict (the A/B engine
   *   itself comes later)
   */
  computeVerdicts(channelId: string): VideoVerdict[] {
    const videos = this.store.listVideos(channelId);
    const previousVerdicts = new Map(
      this.store.loadVerdicts(channelId).map((v) => [v.videoId, v])
    );

    // Bucket snapshots by videoId in one pass over the monthly files.
    const snapshotsByVideo = new Map<string, Snapshot[]>();
    for (const snapshot of this.store.iterateSnapshots(channelId)) {
      const list = snapshotsByVideo.get(snapshot.videoId) || [];
      list.push(snapshot);
      snapshotsByVideo.set(snapshot.videoId, list);
    }

    // First pass: extract per-video metrics (no percentiles yet).
    interface Draft {
      video: VideoRecord;
      firstWeek: VideoVerdict['firstWeek'];
      lifetime: VideoVerdict['lifetime'] | null; // null = no snapshots at all
      topSearchTerms: string[];
    }
    const drafts: Draft[] = videos.map((video) => {
      const snapshots = (snapshotsByVideo.get(video.videoId) || [])
        .slice()
        .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));

      const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
      const firstWeekSnapshot = this.pickFirstWeekSnapshot(snapshots);

      // Cross-source merge: a video's metrics are split across sources — impressions
      // and CTR come from the studio-extension snapshots, retention/subs/traffic from
      // the analytics-api snapshots. Taking a single "latest" snapshot would read
      // null for whichever source didn't sync last, so instead take the latest
      // NON-NULL value per field across all of the video's snapshots.
      const latestNonNull = <T>(get: (s: Snapshot) => T | null | undefined): T | null => {
        for (let i = snapshots.length - 1; i >= 0; i--) {
          const v = get(snapshots[i]);
          if (v !== null && v !== undefined) return v;
        }
        return null;
      };

      const firstWeek: VideoVerdict['firstWeek'] = firstWeekSnapshot
        ? {
            impressions: firstWeekSnapshot.impressions,
            ctr: firstWeekSnapshot.impressionsCtr,
            views: firstWeekSnapshot.views,
            avgPctViewed: firstWeekSnapshot.avgPctViewed,
            retention30s: firstWeekSnapshot.retention ? firstWeekSnapshot.retention.at30s : null,
            dominantSource: this.dominantSource(firstWeekSnapshot),
          }
        : null;

      const lifetime: VideoVerdict['lifetime'] | null = latest
        ? {
            impressions: latestNonNull((s) => s.impressions),
            ctr: latestNonNull((s) => s.impressionsCtr),
            views: latestNonNull((s) => s.views) ?? 0,
            watchHours: latestNonNull((s) => s.watchHours) ?? 0,
            subsGained: latestNonNull((s) => s.subsGained),
          }
        : null;

      // Lifetime top search terms come from the latest snapshot that captured them.
      const latestWithTerms = [...snapshots].reverse().find((s) => s.topSearchTerms !== null);
      const topSearchTerms = latestWithTerms && latestWithTerms.topSearchTerms
        ? [...latestWithTerms.topSearchTerms]
            .sort((a, b) => b.views - a.views)
            .slice(0, 10)
            .map((t) => t.term)
        : [];

      return { video, firstWeek, lifetime, topSearchTerms };
    });

    // Percentile cohorts: age-matched first-week metrics, nulls excluded.
    // CTR percentile uses lifetime (cumulative) CTR — the studio-extension supplies
    // it for the whole catalog, whereas first-week CTR is null for the back-catalog
    // (no snapshot near the 168h mark). Retention still uses first-week (API-sourced).
    const ctrCohort = drafts
      .map((d) => d.lifetime?.ctr)
      .filter((v): v is number => v !== null && v !== undefined);
    const retentionCohort = drafts
      .map((d) => d.firstWeek?.retention30s)
      .filter((v): v is number => v !== null && v !== undefined);

    return drafts.map((draft) => {
      const ctr = draft.lifetime?.ctr ?? null;
      const retention30s = draft.firstWeek?.retention30s ?? null;

      const ctrPercentile = ctr !== null ? round1(percentileRank(ctrCohort, ctr)) : null;
      const retentionPercentile =
        retention30s !== null ? round1(percentileRank(retentionCohort, retention30s)) : null;

      // Mean of the two percentiles when both exist, else whichever exists, else null.
      let packagingScore: number | null;
      if (ctrPercentile !== null && retentionPercentile !== null) {
        packagingScore = round1((ctrPercentile + retentionPercentile) / 2);
      } else if (ctrPercentile !== null) {
        packagingScore = ctrPercentile;
      } else if (retentionPercentile !== null) {
        packagingScore = retentionPercentile;
      } else {
        packagingScore = null;
      }

      let outcome: VideoVerdict['outcome'];
      if (packagingScore === null) {
        outcome = 'typical';
      } else if (packagingScore >= 80) {
        outcome = 'overperformed';
      } else if (packagingScore <= 20) {
        outcome = 'underperformed';
      } else {
        outcome = 'typical';
      }

      const previous = previousVerdicts.get(draft.video.videoId);

      return {
        videoId: draft.video.videoId,
        channelId: draft.video.channelId,
        publishedAt: draft.video.publishedAt,
        titles: draft.video.titleHistory.map((span) => span.title),
        firstWeek: draft.firstWeek,
        lifetime: draft.lifetime || {
          impressions: null,
          ctr: null,
          views: 0,
          watchHours: 0,
          subsGained: null,
        },
        ctrPercentile,
        retentionPercentile,
        packagingScore,
        outcome,
        // Carry through A/B results written by the (future) A/B engine.
        abTest: previous?.abTest ?? null,
        topSearchTerms: draft.topSearchTerms,
      };
    });
  }

  /** Nearest snapshot to 168h of age within ±48h, else null (back-catalog). */
  private pickFirstWeekSnapshot(snapshots: Snapshot[]): Snapshot | null {
    let best: Snapshot | null = null;
    let bestDistance = Infinity;
    for (const snapshot of snapshots) {
      const distance = Math.abs(snapshot.videoAgeHours - FIRST_WEEK_TARGET_HOURS);
      if (distance <= FIRST_WEEK_TOLERANCE_HOURS && distance < bestDistance) {
        best = snapshot;
        bestDistance = distance;
      }
    }
    return best;
  }

  /**
   * Name of the largest trafficShare bucket for a snapshot. 'unknown' when
   * trafficShare was not captured (null) — this is data representation, not a
   * fallback: dominantSource is typed as plain string.
   */
  private dominantSource(snapshot: Snapshot): string {
    if (!snapshot.trafficShare) {
      return 'unknown';
    }
    const entries = Object.entries(snapshot.trafficShare) as Array<[string, number]>;
    entries.sort((a, b) => b[1] - a[1]);
    return entries[0][0];
  }

  // ==================== CHANNEL INSIGHTS ====================

  /**
   * Distill a channel's verdicts into ChannelInsights. Reads the verdicts
   * persisted by the last computeVerdicts run (runDistillation saves them first).
   */
  computeChannelInsights(channelId: string): ChannelInsights {
    const verdicts = this.store.loadVerdicts(channelId);
    const now = Date.now();

    // Recency window: insights — and therefore the AI prompt block — should reflect
    // CURRENT performance, so restrict the learning set to videos published within
    // INSIGHTS_WINDOW_MS. This is what keeps old, confounded, and off-topic videos
    // (including long-dead uploads) out of the baselines, rankings, and search terms.
    const windowStart = now - INSIGHTS_WINDOW_MS;
    const recent = verdicts.filter((v) => {
      const t = Date.parse(v.publishedAt);
      return !Number.isNaN(t) && t >= windowStart;
    });

    const firstWeeks = recent
      .map((v) => v.firstWeek)
      .filter((fw): fw is NonNullable<VideoVerdict['firstWeek']> => fw !== null);

    const baselines: ChannelInsights['baselines'] = {
      // CTR baseline from lifetime (cumulative) CTR — first-week CTR is null across
      // the back-catalog, so the median would be empty. (Field name kept for the schema.)
      medianCtrFirstWeek: median(recent.map((v) => v.lifetime.ctr).filter((v): v is number => v !== null)),
      medianAvgPctViewed: median(firstWeeks.map((fw) => fw.avgPctViewed).filter((v): v is number => v !== null)),
      medianRetention30s: median(firstWeeks.map((fw) => fw.retention30s).filter((v): v is number => v !== null)),
      medianFirstWeekViews: median(firstWeeks.map((fw) => fw.views)),
    };

    // Within the window, packaging rankings still need enough reach to carry a real
    // signal — exclude near-zero-impression videos (see MIN_PACKAGING_IMPRESSIONS).
    const scored = recent.filter(
      (v) => v.packagingScore !== null && (v.lifetime.impressions ?? 0) >= MIN_PACKAGING_IMPRESSIONS,
    );

    // Top ~8 by packagingScore, recency-weighted: videos published <90d ago get
    // 2x weight so fresh wins outrank equally-scored old ones.
    const topPackaging = [...scored]
      .sort((a, b) => this.recencyWeightedScore(b, now) - this.recencyWeightedScore(a, now))
      .slice(0, 8)
      .map((v) => this.toSummary(v));

    // Bottom ~5 by plain packagingScore.
    const bottomPackaging = [...scored]
      .sort((a, b) => (a.packagingScore as number) - (b.packagingScore as number))
      .slice(0, 5)
      .map((v) => this.toSummary(v));

    const abLearnings = verdicts
      .filter((v) => v.abTest !== null)
      .map((v) => ({
        variants: v.abTest!.variants,
        winner: v.abTest!.winner,
        liftPct: v.abTest!.liftPct,
      }));

    return {
      channelId,
      computedAt: new Date().toISOString(),
      videoCount: verdicts.length,
      baselines,
      topPackaging,
      bottomPackaging,
      abLearnings,
      topSearchTerms: this.aggregateChannelSearchTerms(channelId),
      aiBrief: null, // v1: reserved
    };
  }

  private recencyWeightedScore(verdict: VideoVerdict, nowMs: number): number {
    const score = verdict.packagingScore as number;
    const ageMs = nowMs - Date.parse(verdict.publishedAt);
    return ageMs < NINETY_DAYS_MS ? score * 2 : score;
  }

  private toSummary(verdict: VideoVerdict): VideoVerdictSummary {
    return {
      title: verdict.titles[verdict.titles.length - 1],
      ctr: verdict.lifetime ? verdict.lifetime.ctr : null,
      ctrPercentile: verdict.ctrPercentile,
      retention30s: verdict.firstWeek ? verdict.firstWeek.retention30s : null,
      views: verdict.lifetime.views,
    };
  }

  /**
   * Aggregate lifetime search-term views across a channel's videos, using each
   * video's LATEST snapshot that captured topSearchTerms (counters are
   * cumulative, so the latest capture is the lifetime total for that video).
   */
  private aggregateChannelSearchTerms(channelId: string): Array<{ term: string; views: number }> {
    const latestTermsByVideo = new Map<string, Array<{ term: string; views: number }>>();
    const latestCaptureByVideo = new Map<string, string>();

    for (const snapshot of this.store.iterateSnapshots(channelId)) {
      if (snapshot.topSearchTerms === null) {
        continue;
      }
      const lastSeen = latestCaptureByVideo.get(snapshot.videoId);
      if (!lastSeen || snapshot.capturedAt > lastSeen) {
        latestCaptureByVideo.set(snapshot.videoId, snapshot.capturedAt);
        latestTermsByVideo.set(snapshot.videoId, snapshot.topSearchTerms);
      }
    }

    const totals = new Map<string, number>();
    for (const terms of latestTermsByVideo.values()) {
      for (const { term, views } of terms) {
        totals.set(term, (totals.get(term) || 0) + views);
      }
    }

    return Array.from(totals.entries())
      .map(([term, views]) => ({ term, views }))
      .sort((a, b) => b.views - a.views)
      .slice(0, 10);
  }

  // ==================== CROSS-CHANNEL INSIGHTS ====================

  /**
   * Cross-channel distillation. Comparison across channels is
   * percentile-normalized only (packagingScore), never raw counts.
   */
  computeCrossChannelInsights(): CrossChannelInsights {
    const channels = this.store.listChannels();
    const now = Date.now();

    // Recent overperformers: published in the last 90d, packagingScore >= 80.
    const recentOverperformers: CrossChannelInsights['recentOverperformers'] = [];
    for (const channel of channels) {
      for (const verdict of this.store.loadVerdicts(channel.channelId)) {
        if (verdict.packagingScore === null || verdict.packagingScore < 80) {
          continue;
        }
        if ((verdict.lifetime.impressions ?? 0) < MIN_PACKAGING_IMPRESSIONS) {
          continue; // enough reach to be a real example — not a 6-view dead/unlisted video
        }
        if (now - Date.parse(verdict.publishedAt) > NINETY_DAYS_MS) {
          continue;
        }
        recentOverperformers.push({
          channelId: verdict.channelId,
          title: verdict.titles[verdict.titles.length - 1],
          packagingScore: verdict.packagingScore,
          views: verdict.lifetime.views,
        });
      }
    }
    recentOverperformers.sort((a, b) => b.packagingScore - a.packagingScore);

    return {
      computedAt: new Date().toISOString(),
      channelIds: channels.map((c) => c.channelId),
      recentOverperformers: recentOverperformers.slice(0, 10),
      risingSearchTerms: this.computeRisingSearchTerms(channels.map((c) => c.channelId)),
      aiBrief: null, // v1: reserved
    };
  }

  /**
   * Rising search terms: per-term view GROWTH in the last 90 days vs the 90
   * days prior. Because counters are lifetime-cumulative, growth in a window is
   * the diff of cumulative totals at the window boundaries (per video, then
   * summed per term across videos/channels).
   *
   * Encoding (see CrossChannelInsights type): terms with prior-window growth
   * > 0 get trendVsPriorPeriod = current/prior ratio and are ranked by ratio;
   * terms that are NEW this window (prior growth 0) get the sentinel -1 and are
   * ranked by current-window views. New terms list first — a term appearing
   * from nothing is the strongest "rising" signal.
   */
  private computeRisingSearchTerms(channelIds: string[]): CrossChannelInsights['risingSearchTerms'] {
    const now = Date.now();
    const t1 = new Date(now - NINETY_DAYS_MS).toISOString();      // current window start
    const t0 = new Date(now - 2 * NINETY_DAYS_MS).toISOString();  // prior window start

    // Per term: cumulative views at each boundary, summed across all videos.
    const cumAt = (boundary: string | null, acc: Map<string, number>, byVideo: Map<string, Snapshot[]>) => {
      for (const snapshots of byVideo.values()) {
        // Latest snapshot at-or-before the boundary that captured search terms.
        let chosen: Snapshot | null = null;
        for (const snapshot of snapshots) {
          if (snapshot.topSearchTerms === null) continue;
          if (boundary !== null && snapshot.capturedAt > boundary) continue;
          if (!chosen || snapshot.capturedAt > chosen.capturedAt) {
            chosen = snapshot;
          }
        }
        if (!chosen || !chosen.topSearchTerms) continue;
        for (const { term, views } of chosen.topSearchTerms) {
          acc.set(term, (acc.get(term) || 0) + views);
        }
      }
    };

    const cum0 = new Map<string, number>(); // at t0
    const cum1 = new Map<string, number>(); // at t1
    const cum2 = new Map<string, number>(); // now (latest)

    for (const channelId of channelIds) {
      const byVideo = new Map<string, Snapshot[]>();
      for (const snapshot of this.store.iterateSnapshots(channelId)) {
        const list = byVideo.get(snapshot.videoId) || [];
        list.push(snapshot);
        byVideo.set(snapshot.videoId, list);
      }
      for (const list of byVideo.values()) {
        list.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
      }
      cumAt(t0, cum0, byVideo);
      cumAt(t1, cum1, byVideo);
      cumAt(null, cum2, byVideo);
    }

    const newTerms: CrossChannelInsights['risingSearchTerms'] = [];
    const trendTerms: CrossChannelInsights['risingSearchTerms'] = [];

    for (const [term, total] of cum2) {
      const atT1 = cum1.get(term) || 0;
      const atT0 = cum0.get(term) || 0;
      const currentGrowth = total - atT1;
      const priorGrowth = atT1 - atT0;
      if (currentGrowth <= 0) {
        continue; // not rising
      }
      if (priorGrowth > 0) {
        trendTerms.push({
          term,
          views: currentGrowth,
          trendVsPriorPeriod: round1(currentGrowth / priorGrowth),
        });
      } else {
        newTerms.push({ term, views: currentGrowth, trendVsPriorPeriod: -1 });
      }
    }

    newTerms.sort((a, b) => b.views - a.views);
    trendTerms.sort((a, b) => b.trendVsPriorPeriod - a.trendVsPriorPeriod || b.views - a.views);

    return [...newTerms, ...trendTerms].slice(0, 12);
  }

  // ==================== FULL RUN ====================

  /**
   * Full distillation: verdicts + insights for every registered channel, then
   * cross-channel insights. Persists everything and returns a summary.
   */
  async runDistillation(): Promise<DistillationSummary> {
    const channels = this.store.listChannels();
    let videosProcessed = 0;
    let verdictsWritten = 0;

    console.log(`[Distillation] Running for ${channels.length} channel(s)...`);

    for (const channel of channels) {
      const verdicts = this.computeVerdicts(channel.channelId);
      await this.store.saveVerdicts(channel.channelId, verdicts);
      videosProcessed += this.store.listVideos(channel.channelId).length;
      verdictsWritten += verdicts.length;

      const insights = this.computeChannelInsights(channel.channelId);
      await this.store.saveChannelInsights(channel.channelId, insights);
    }

    const crossChannel = this.computeCrossChannelInsights();
    await this.store.saveCrossChannelInsights(crossChannel);

    const summary: DistillationSummary = {
      channels: channels.length,
      videosProcessed,
      verdictsWritten,
    };
    console.log(`[Distillation] Complete:`, JSON.stringify(summary));
    return summary;
  }
}
