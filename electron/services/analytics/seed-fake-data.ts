/**
 * Fake Analytics Data Seeder (DEV)
 *
 * Generates plausible correlated analytics data so distillation + insights +
 * prompt injection can be exercised end-to-end without a real extension or
 * YouTube API:
 *
 * - 3 fake channels (or seeds into already-registered channels when present)
 * - ~40 videos per channel published over the last ~10 months
 * - snapshot series per video (1d, 3d, 7d, 14d, 30d, then monthly), counters
 *   lifetime-cumulative with age-decayed growth
 * - CTR 2-12%, positively correlated with a per-video "clickbaitiness" factor;
 *   30s retention inversely correlated with the same factor
 * - a few forced clear over/underperformers per channel
 * - search terms, including "rising" terms that only appear in recent captures
 *
 * Deterministic: uses a seeded PRNG so repeat runs produce the same shape.
 */

import { ChannelRegistryEntry, Snapshot, VideoRecord } from './analytics-types';
import { AnalyticsStoreService } from './analytics-store.service';

export interface SeedSummary {
  channels: number;
  videos: number;
  snapshots: number;
  channelIds: string[];
}

/** mulberry32 — small deterministic PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FAKE_CHANNELS: ChannelRegistryEntry[] = [
  { channelId: 'UCfake-owen-unfiltered-0001', name: 'Owen Unfiltered (fake)', promptSets: [] },
  { channelId: 'UCfake-owen-morgan-0002', name: 'Owen Morgan (fake)', promptSets: [] },
  { channelId: 'UCfake-owen-fireside-0003', name: 'Owen Fireside Chat (fake)', promptSets: [] },
];

const TOPIC_POOL = [
  'street epistemology', 'flat earth debate', 'young earth creationism', 'presuppositionalism',
  'biblical contradictions', 'faith healing exposed', 'apologetics debunked', 'atheist debate',
  'religious trauma', 'megachurch finances', 'evolution evidence', 'near death experiences',
];

// Terms that only appear in RECENT captures — drives risingSearchTerms "new" sentinel.
const RISING_TERMS = ['charlie kirk debate', 'ai jesus deepfake', 'church tax scandal'];

const TITLE_TEMPLATES_CALM = [
  'A Careful Look at {topic}',
  'Understanding {topic} — Full Breakdown',
  'What the Evidence Says About {topic}',
  '{topic}: A Conversation',
];

const TITLE_TEMPLATES_CLICKBAIT = [
  'This {topic} Argument FALLS APART in Seconds',
  'He Could NOT Answer This Question About {topic}',
  'The {topic} Video They Don\'t Want You to See',
  'DESTROYED: The Worst {topic} Take Ever',
];

function titleFor(rand: () => number, topic: string, clickbaitiness: number): string {
  const pool = clickbaitiness > 0.5 ? TITLE_TEMPLATES_CLICKBAIT : TITLE_TEMPLATES_CALM;
  const template = pool[Math.floor(rand() * pool.length)];
  const capped = topic.replace(/\b\w/g, (c) => c.toUpperCase());
  return template.replace('{topic}', capped);
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Snapshot capture ages (hours): daily-ish early, then monthly. */
function captureAgesHours(maxAgeHours: number): number[] {
  const ages = [24, 72, 168, 336, 720];
  let next = 1440; // 60d
  while (next <= maxAgeHours) {
    ages.push(next);
    next += 720; // monthly after
  }
  return ages.filter((a) => a <= maxAgeHours);
}

export async function seedFakeData(store: AnalyticsStoreService): Promise<SeedSummary> {
  const rand = mulberry32(0xC0FFEE);
  const now = Date.now();

  // Seed into registered channels when present, else register the fake trio.
  let channels = store.listChannels();
  if (channels.length === 0) {
    channels = FAKE_CHANNELS;
    await store.saveChannels(channels);
    console.log('[SeedFakeData] Registered 3 fake channels');
  } else {
    console.log(`[SeedFakeData] Seeding into ${channels.length} already-registered channel(s)`);
  }

  let totalVideos = 0;
  let totalSnapshots = 0;

  for (let c = 0; c < channels.length; c++) {
    const channel = channels[c];
    const videos: VideoRecord[] = [];
    const snapshots: Snapshot[] = [];
    const videoCount = 38 + Math.floor(rand() * 5); // ~40

    for (let i = 0; i < videoCount; i++) {
      // Published over the last ~300 days so both 90d windows have coverage.
      const ageDays = 3 + rand() * 300;
      const publishedAtMs = now - ageDays * DAY_MS;
      const publishedAt = new Date(publishedAtMs).toISOString();
      const videoId = `fake-${channel.channelId.slice(-4)}-${String(i).padStart(3, '0')}`;

      // Clickbaitiness drives the CTR/retention correlation.
      let clickbaitiness = rand();
      // Force a few CLEAR over/underperformers per channel.
      const forced = i % 13 === 0 ? 'over' : i % 11 === 0 ? 'under' : null;

      // CTR 2-12%: base rises with clickbaitiness; overperformers get high CTR
      // AND high retention (great packaging), underperformers get both low.
      let baseCtr = 2 + clickbaitiness * 8 + (rand() - 0.5) * 2;      // ~2..11
      let retention30 = 72 - clickbaitiness * 28 + (rand() - 0.5) * 8; // inverse correlation
      if (forced === 'over') {
        baseCtr = 10.5 + rand() * 1.5;      // 10.5..12
        retention30 = 74 + rand() * 8;      // clearly high
      } else if (forced === 'under') {
        baseCtr = 2 + rand() * 0.8;         // 2..2.8
        retention30 = 28 + rand() * 6;      // clearly low
      }
      baseCtr = Math.min(12, Math.max(2, baseCtr));
      retention30 = Math.min(90, Math.max(20, retention30));

      const topic = TOPIC_POOL[Math.floor(rand() * TOPIC_POOL.length)];
      const title = titleFor(rand, topic, forced === 'over' ? 0.8 : forced === 'under' ? 0.2 : clickbaitiness);

      const video: VideoRecord = {
        videoId,
        channelId: channel.channelId,
        publishedAt,
        durationSec: 480 + Math.floor(rand() * 1800),
        format: 'long',
        titleHistory: [{ title, from: publishedAt, to: null, origin: 'upload' }],
      };
      videos.push(video);

      // Total lifetime impressions scale loosely with channel index + noise.
      const totalImpressions = 40000 + rand() * 360000 + c * 20000;
      const totalViews = totalImpressions * (baseCtr / 100);
      const avgViewDurationSec = video.durationSec * (retention30 / 100) * (0.45 + rand() * 0.2);
      const dominantBrowse = rand() > 0.4;
      const tau = 120 + rand() * 200; // growth time constant (hours)

      const maxAgeHours = (now - publishedAtMs) / HOUR_MS;
      for (const ageHours of captureAgesHours(maxAgeHours)) {
        const capturedAtMs = publishedAtMs + ageHours * HOUR_MS;
        const capturedAt = new Date(capturedAtMs).toISOString();
        // Cumulative growth with age decay (saturating exponential).
        const growth = 1 - Math.exp(-ageHours / tau);
        const views = Math.round(totalViews * growth);
        const impressions = Math.round(totalImpressions * growth);
        // CTR decays slightly with age (browse CTR drops once impressions widen).
        const ctrDecay = 1 - 0.15 * Math.min(1, ageHours / 2000);
        const ctr = Math.round(baseCtr * ctrDecay * 100) / 100;

        // Search terms: cumulative views per term; rising terms only appear in
        // captures within the last 60 days (so the prior 90d window has none).
        const searchTerms: Array<{ term: string; views: number }> = [
          { term: topic, views: Math.round(views * 0.06) },
          { term: `${topic} response`, views: Math.round(views * 0.02) },
        ];
        const capturedRecently = now - capturedAtMs < 60 * DAY_MS;
        if (capturedRecently) {
          const risingTerm = RISING_TERMS[(i + c) % RISING_TERMS.length];
          searchTerms.push({ term: risingTerm, views: Math.round(200 + rand() * 1200) });
        }

        const browseShare = dominantBrowse ? 0.45 + rand() * 0.1 : 0.2 + rand() * 0.1;
        const suggestedShare = dominantBrowse ? 0.25 : 0.45 + rand() * 0.1;
        const searchShare = 0.12;
        const externalShare = 0.05;
        const notificationsShare = 0.04;
        const otherShare = Math.max(0, 1 - browseShare - suggestedShare - searchShare - externalShare - notificationsShare);

        snapshots.push({
          schemaVersion: 1,
          videoId,
          channelId: channel.channelId,
          capturedAt,
          source: 'studio-extension',
          videoAgeHours: Math.round(ageHours),
          impressions,
          impressionsCtr: ctr,
          views,
          watchHours: Math.round((views * avgViewDurationSec) / 3600 * 10) / 10,
          avgViewDurationSec: Math.round(avgViewDurationSec),
          avgPctViewed: Math.round((avgViewDurationSec / video.durationSec) * 1000) / 10,
          retention: {
            at30s: Math.round(retention30 * 10) / 10,
            at60s: Math.round(retention30 * 0.82 * 10) / 10,
          },
          trafficShare: {
            browse: Math.round(browseShare * 1000) / 10,
            suggested: Math.round(suggestedShare * 1000) / 10,
            search: searchShare * 100,
            external: externalShare * 100,
            notifications: notificationsShare * 100,
            other: Math.round(otherShare * 1000) / 10,
          },
          ctrBySource: {
            browse: Math.round(ctr * 1.1 * 100) / 100,
            search: Math.round(ctr * 0.8 * 100) / 100,
            suggested: Math.round(ctr * 0.95 * 100) / 100,
          },
          topSearchTerms: searchTerms,
          subsGained: Math.round(views * 0.004),
          likes: Math.round(views * 0.045),
          comments: Math.round(views * 0.006),
          shares: Math.round(views * 0.002),
        });
      }
    }

    await store.upsertVideos(videos);
    await store.appendSnapshots(snapshots);
    totalVideos += videos.length;
    totalSnapshots += snapshots.length;
    console.log(`[SeedFakeData] ${channel.name}: ${videos.length} videos, ${snapshots.length} snapshots`);
  }

  return {
    channels: channels.length,
    videos: totalVideos,
    snapshots: totalSnapshots,
    channelIds: channels.map((ch) => ch.channelId),
  };
}
