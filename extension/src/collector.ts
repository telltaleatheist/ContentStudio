// Studio analytics collector — IMPLEMENTED (v1).
//
// ============================================================================
// ARCHITECTURE — why collection runs in a PAGE, not the service worker
// ============================================================================
// The signed request to Studio's internal analytics endpoint needs two things
// that only exist inside a loaded studio.youtube.com PAGE (MAIN world):
//   (a) the SAPISID cookie (via document.cookie) to compute SAPISIDHASH, and
//   (b) window.ytcfg (client version + the per-channel serialized delegation
//       context that scopes the query to one of the user's channels).
// Neither exists in the MV3 service-worker context. So the service worker DRIVES
// a studio.youtube.com tab and runs the collection via
//   chrome.scripting.executeScript({ target:{tabId}, world:'MAIN', func, args })
// executeScript returns the injected function's (awaited) return value back to
// the SW. `collectStudioAnalyticsInPage` below is that function: fully
// self-contained (it inlines the SAPISIDHASH crypto, ytcfg read, fetch,
// pagination, and resultTable parsing) so it can also be pasted verbatim into a
// live Studio MAIN-world console for validation — it closes over NOTHING.
//
// MULTI-CHANNEL: ytcfg reflects whichever channel's Studio page is loaded. For
// each configured channel we navigate ONE managed tab to
//   https://studio.youtube.com/channel/<channelId>/analytics
// and poll (bounded) until window.ytcfg is present AND its CHANNEL_ID equals the
// requested channel AND a delegation context is present, THEN inject. If the
// context never matches (e.g. the user is not signed into that channel) we throw
// StudioChannelUnavailableError for that channel; the background cycle records it
// per-channel and moves on to the next channel (record-and-continue isolation).
//
// FAILURE DISCIPLINE (no fallbacks): non-200 / missing resultTable / missing
// required column each throw a DISTINCT named error (auth vs shape vs rate-limit
// vs http vs tab vs channel-unavailable). No partial or guessed snapshot is ever
// produced. Columns are matched by .metric.type, never by index. A metric value
// missing for a row is null, never 0.
//
// ----------------------------------------------------------------------------
// TODO(v1-metadata) — RESOLVED: the catalogue (catalogue.ts) supplies VideoRecords, and since
// 0.2.11 collectChannel sets each snapshot's videoAgeHours from it (withVideoAges). The
// original note, kept for the history:
// ----------------------------------------------------------------------------
// The CORE analytics query returns only videoIds. A VALID VideoRecord needs a
// real publishedAt: ContentStudio's ingest (validateVideoRecord) REJECTS any
// publishedAt that is not a parseable ISO date, and titleHistory[].from likewise.
// There is no confirmed Studio metadata endpoint in STUDIO-COLLECTOR-SPEC.md, so
// per the project's no-guessing rule we emit NO VideoRecords rather than
// 400-guaranteed placeholders. Snapshots (below) still flow — they key by videoId
// and join to VideoRecords whenever those land. Consequence: without publishedAt
// we cannot compute videoAgeHours (set to the -1 "unknown" sentinel) and cannot
// tier by age, so every video is collected every cycle until metadata lands.
// To UNBLOCK: on studio.youtube.com/channel/<id>/videos open DevTools > Network,
// capture the POST .../youtubei/v1/creator/get_creator_videos (or
// list_creator_videos) request — its `mask` and response path to
// title / timePublishedSeconds / lengthSeconds — then add that fetch inside
// collectStudioAnalyticsInPage, build VideoRecords (title, publishedAt from
// timePublishedSeconds, durationSec from lengthSeconds, format long/short/live),
// set videoAgeHours = (capturedAt - publishedAt)/3600000, and return them in
// `videos`. Cadence tiering below then activates automatically — no other change.
// ============================================================================

import type { ChannelDay, Snapshot, VideoFirstWeek, VideoRecord } from './types';
import {
  fetchCatalogueInPage,
  fetchExperimentsInPage,
  toVideoRecords,
  type AbTestRecord,
  type CatalogueVideo,
} from './catalogue';
import { getChannelVideoState, getFirstWeekState, recordFirstWeeks, recordSnapshotTimes } from './collection-state';

/**
 * The popup badge reads this to render the collector status line. Now that
 * collection is implemented it is true (the badge shows "Active").
 */
export const COLLECTOR_IMPLEMENTED = true;

/**
 * Retained for backwards compatibility: background.ts imports this name and
 * special-cases it. The collector no longer throws it (collection is
 * implemented); real failures throw the StudioCollectionError subclasses below.
 */
export class CollectorNotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CollectorNotImplementedError';
  }
}

export interface ChannelCollectionResult {
  videos: VideoRecord[];
  snapshots: Snapshot[];
  /** Decided A/B title tests — these become ChannelInsights.abLearnings. */
  abTests: AbTestRecord[];
  /** The channel's per-day series over the rolling window (see collectChannelDaysInPage). */
  days: ChannelDay[];
  /** First-week totals for uploads whose first week closed since the last cycle (see collectFirstWeeksInPage). */
  firstWeeks: VideoFirstWeek[];
}

// ============================================================================
// Distinct named errors — one per failure mode, surfaced per-channel in the popup
// ============================================================================

export class StudioCollectionError extends Error {
  readonly channelId: string;
  readonly code: string;
  constructor(name: string, channelId: string, code: string, message: string) {
    super(message);
    this.name = name;
    this.channelId = channelId;
    this.code = code;
  }
}
/** Not signed in / delegation rejected / ytcfg absent / HTTP 401|403. */
export class StudioAuthError extends StudioCollectionError {
  constructor(channelId: string, code: string, message: string) { super('StudioAuthError', channelId, code, message); }
}
/** HTTP 429 from the analytics endpoint. */
export class StudioRateLimitError extends StudioCollectionError {
  constructor(channelId: string, code: string, message: string) { super('StudioRateLimitError', channelId, code, message); }
}
/** Response shape changed: no resultTable, missing required column, bad JSON, etc. */
export class StudioShapeError extends StudioCollectionError {
  constructor(channelId: string, code: string, message: string) { super('StudioShapeError', channelId, code, message); }
}
/** Unexpected non-2xx (not 401/403/429) or a network error inside the page. */
export class StudioHttpError extends StudioCollectionError {
  constructor(channelId: string, code: string, message: string) { super('StudioHttpError', channelId, code, message); }
}
/** The managed tab never loaded the requested channel's context in time. */
export class StudioChannelUnavailableError extends StudioCollectionError {
  constructor(channelId: string, detail: string) {
    super('StudioChannelUnavailableError', channelId, 'CHANNEL_UNAVAILABLE',
      `Studio never loaded channel ${channelId} (${detail}) — is the user signed into that channel?`);
  }
}
/** Could not create/drive the tab, or executeScript itself failed. */
export class StudioTabError extends StudioCollectionError {
  constructor(channelId: string, code: string, message: string) { super('StudioTabError', channelId, code, message); }
}
/**
 * No Studio tab is open on this channel and this pass is not allowed to open one.
 *
 * A DEFERRAL, not a failure: nothing was collected, nothing is wrong, and the next pass
 * that finds a tab (or the operator pressing Sync now) will pick it up. Its own class so
 * the cycle can log it as the routine event it is instead of an error, and so the popup
 * can say "waiting for a Studio tab" rather than showing a red line every six hours.
 */
export class NoStudioTabError extends StudioCollectionError {
  constructor(channelId: string, detail: string) {
    super('NoStudioTabError', channelId, 'NO_STUDIO_TAB',
      `No open studio.youtube.com tab is on channel ${channelId}, and a background pass ` +
      `does not open one (${detail}). Open Studio on that channel, or press "Sync now".`);
  }
}

// ============================================================================
// Constants
// ============================================================================

// The Studio analytics endpoint does NOT support pageOffset pagination — a
// pageOffset > 0 returns HTTP 400 ("invalid argument"), verified live 2026-07-22.
// It returns up to `pageSize` rows in a single request. The endpoint also caps
// pageSize: 10000 is accepted (verified returning a full multi-thousand-video
// catalog in one call), 15000+ returns HTTP 400. So 10000 is the safe maximum —
// large enough for any realistic channel, under the cap. Channels exceeding it
// trip the PAGE_CAP fail-loud guard below rather than being silently truncated.
const PAGE_SIZE = 10000;
const STUDIO_TAB_KEY = 'studioCollectorTabId';
const CONTEXT_TIMEOUT_MS = 30_000;
// The per-day series is re-fetched whole every cycle and upserted by day on the
// ContentStudio side, so late Studio revisions (viewer cohorts arrive ~2 days late)
// overwrite the early numbers. 400 days (since 0.2.11; 35 before) is a year plus five
// weeks, so a week can be read against the same week a year earlier. It is still three
// requests per channel; the largest is DAY x TRAFFIC_SOURCE_TYPE at <= 400 x 13 rows,
// under the 10,000-row page. A queued fetch is ~0.7 MB per channel and the outbox keeps
// one per channel (see enqueueChannelDays).
const CHANNEL_DAYS_WINDOW = 400;
// First-week totals (collectFirstWeeksInPage): uploads published within this many days are
// eligible, which covers the distiller's 180-day insights window with a margin...
const FIRST_WEEK_LOOKBACK_DAYS = 200;
// ...once their seven days are over and Studio has had this many more days to settle them.
const FIRST_WEEK_SETTLE_DAYS = 3;
// One request per distinct publish day; the first run backfills the whole lookback, so it is
// spread over cycles rather than sent as one burst.
const FIRST_WEEK_MAX_REQUESTS_PER_CYCLE = 30;
const CONTEXT_POLL_MS = 1_000;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
// Half of the ~6h SW cycle: lets a daily/weekly/monthly boundary fire on the
// NEAREST cycle rather than the one strictly after the interval elapses.
const CADENCE_SKEW_MS = 3 * HOUR_MS;

// ============================================================================
// Public entry point — called once per channel by the background cycle
// ============================================================================

/**
 * Whether this pass may put a Studio tab on screen.
 *
 * `false` for the six-hourly alarm, `true` only when the operator asked for a sync. See
 * ensureStudioTabForChannel for why the distinction exists at all.
 */
export interface CollectOptions {
  mayOpenTab: boolean;
}

export async function collectChannel(
  channelId: string,
  options: CollectOptions,
): Promise<ChannelCollectionResult> {
  const tabId = await ensureStudioTabForChannel(channelId, options.mayOpenTab);
  const injected = await runInjectedCollection(tabId, channelId);
  if (!injected.ok) throw mapInjectedError(injected, channelId);

  // Catalogue: real publishedAt/title/duration for every video. This is what resolves
  // TODO(v1-metadata) — the analytics query returns only videoIds, and a VideoRecord
  // needs a parseable publishedAt, so before list_creator_videos was reconnoitred we
  // correctly emitted none. Ages now become real, which makes the cadence tiering below
  // and the age-matched percentiles in distillation actually work.
  const catalogueResult = await runInjectedCatalogue(tabId, channelId);
  if (!catalogueResult.ok) throw mapCatalogueError(catalogueResult, channelId);
  const catalogue: CatalogueVideo[] = catalogueResult.videos;

  // Decided A/B tests for the same channel — the winners that feed abLearnings and,
  // through it, the metadata-generation prompt.
  const experimentResult = await runInjectedExperiments(
    tabId,
    channelId,
    catalogue.map((v) => v.videoId),
  );
  if (!experimentResult.ok) throw mapCatalogueError(experimentResult, channelId);
  const abTests: AbTestRecord[] = experimentResult.tests;

  // The channel's per-day series (Home feed card). Two cheap requests; a failure here is
  // the channel's failure like every other call above — nothing half-collected is kept.
  const daysResult = await runInjectedChannelDays(tabId, channelId);
  if (!daysResult.ok) throw mapInjectedError(daysResult, channelId);
  const days: ChannelDay[] = daysResult.days;

  // Every snapshot takes its real age from the catalogue. Until 0.2.11 every extension
  // snapshot kept the injected -1 "unknown" sentinel even after the catalogue landed, so the
  // cadence below never tiered (every video every cycle, ~6,300 snapshots a cycle across the
  // three channels) and ContentStudio's first-week pick (age 168 h +/- 48 h) never matched an
  // extension snapshot. A video the catalogue gives no publish date (never published) keeps -1.
  const snapshots = withVideoAges(injected.snapshots, catalogue, channelId);

  // First-week totals for long/live uploads whose first seven days closed and settled since
  // they were last sent. A video's lifetime counters say nothing about its first week once it
  // is older, so this is what lets every upload of the lookback be compared on the same
  // window — including the ones published after 2026-08-27, whose snapshots carry no engaged
  // views. Capped per cycle; the rest wait for the next one.
  const firstWeekState = await getFirstWeekState(channelId);
  const windows = planFirstWeeks(catalogue, firstWeekState, new Date(), {
    lookbackDays: FIRST_WEEK_LOOKBACK_DAYS,
    settleDays: FIRST_WEEK_SETTLE_DAYS,
    maxWindows: FIRST_WEEK_MAX_REQUESTS_PER_CYCLE,
  });
  let firstWeeks: VideoFirstWeek[] = [];
  if (windows.length > 0) {
    const firstWeekResult = await runInjectedFirstWeeks(tabId, channelId, windows);
    if (!firstWeekResult.ok) throw mapInjectedError(firstWeekResult, channelId);
    firstWeeks = toFirstWeeks(windows, firstWeekResult.windows, channelId, new Date().toISOString());
  }

  // Cadence tiering (SW-side, where the last-capture state lives): keep only the
  // snapshots whose video is due this cycle. First-ever run per channel = every
  // video is due (backfill). See tierIntervalMs/isDue.
  const nowMs = Date.now();
  const prior = await getChannelVideoState(channelId);
  const dueSnapshots = snapshots.filter((s) => isDue(s.videoAgeHours, prior[s.videoId], nowMs));

  // Emit a VideoRecord for EVERY catalogue video, every cycle — not only unseen ones.
  // A title changes after first sight: YouTube applies the winner of a title test, or
  // the operator edits it. Until 2026-10-21 only unseen videos were sent, so the store
  // kept the upload-day title for life, and two decided tests on the main channel had
  // the LOSING title on record with the winner's numbers. The store merges title
  // history and only appends a span when the live title differs, so the re-send costs
  // one read of videos.json per cycle and nothing on disk when nothing changed. The
  // catalogue carries real publish dates; anything still unpublished is dropped by
  // toVideoRecords rather than being given an invented date.
  const videos = toVideoRecords(catalogue, channelId);

  // Mark the emitted snapshots' capture time so cadence can skip them next cycle.
  await recordSnapshotTimes(channelId, dueSnapshots.map((s) => ({ videoId: s.videoId, capturedAt: s.capturedAt })));
  // Recorded at collection time, like the snapshot times: the records go into the durable
  // outbox right after this returns, and a refused one stays queued there, not lost.
  await recordFirstWeeks(channelId, firstWeeks.map((f) => f.videoId), FIRST_WEEK_LOOKBACK_DAYS + 30);

  return { videos, snapshots: dueSnapshots, abTests, days, firstWeeks };
}

/** Set each snapshot's videoAgeHours from the catalogue's publish date (see collectChannel). */
export function withVideoAges(snapshots: Snapshot[], catalogue: CatalogueVideo[], channelId: string): Snapshot[] {
  const publishedById = new Map<string, string>();
  for (const v of catalogue) if (v.publishedAt) publishedById.set(v.videoId, v.publishedAt);
  return snapshots.map((s) => {
    const publishedAt = publishedById.get(s.videoId);
    if (publishedAt === undefined) return s;
    const ageMs = Date.parse(s.capturedAt) - Date.parse(publishedAt);
    if (!Number.isFinite(ageMs)) {
      throw new StudioShapeError(channelId, 'BAD_PUBLISHED_AT',
        `Video ${s.videoId}: cannot age a snapshot captured ${s.capturedAt} against publishedAt "${publishedAt}".`);
    }
    return { ...s, videoAgeHours: ageMs / HOUR_MS };
  });
}

/** One publish day's first-week request: the videos published that (local) day. */
export interface FirstWeekWindow {
  firstDay: string;       // 'YYYY-MM-DD', the local publish day
  lastDay: string;        // firstDay + 6
  startDateId: number;    // firstDay as a Studio date id (inclusive)
  endDateId: number;      // firstDay + 7 (exclusive)
  videos: Array<{ videoId: string; publishedAt: string }>;
}

/**
 * Which first weeks to fetch this cycle: long/live uploads (Shorts count views differently and
 * the distiller leaves them out) published on a local day within `lookbackDays` of today,
 * whose seven days ended at least `settleDays` ago, not already sent. One window per publish
 * day, newest first, at most `maxWindows`. The local calendar is the one the per-day series
 * uses (the Studio page's, which is this machine's).
 */
export function planFirstWeeks(
  catalogue: CatalogueVideo[],
  sent: Record<string, string>,
  now: Date,
  limits: { lookbackDays: number; settleDays: number; maxWindows: number },
): FirstWeekWindow[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayMs = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const addDays = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const key = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const dateId = (d: Date): number => d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  const earliest = addDays(today, -limits.lookbackDays).getTime();
  // The newest publish day whose window [D, D+7) ended settleDays or more before today.
  const latest = addDays(today, -(7 + limits.settleDays)).getTime();

  const byDay = new Map<string, FirstWeekWindow>();
  for (const v of catalogue) {
    if (!v.publishedAt || v.isShort || sent[v.videoId] !== undefined) continue;
    const published = new Date(v.publishedAt);
    if (Number.isNaN(published.getTime())) {
      throw new Error(`Catalogue video ${v.videoId} has publishedAt "${v.publishedAt}", not a date.`);
    }
    const day = new Date(dayMs(published));
    if (day.getTime() < earliest || day.getTime() > latest) continue;
    const k = key(day);
    let window = byDay.get(k);
    if (!window) {
      window = {
        firstDay: k,
        lastDay: key(addDays(day, 6)),
        startDateId: dateId(day),
        endDateId: dateId(addDays(day, 7)),
        videos: [],
      };
      byDay.set(k, window);
    }
    window.videos.push({ videoId: v.videoId, publishedAt: v.publishedAt });
  }
  return Array.from(byDay.values())
    .sort((a, b) => b.firstDay.localeCompare(a.firstDay))
    .slice(0, limits.maxWindows);
}

/** What collectFirstWeeksInPage returns per window: the requested videos' rows, by id. */
export interface FirstWeekRows {
  startDateId: number;
  rows: Record<string, {
    views: number; engagedViews: number; watchHours: number;
    impressions: number | null; impressionsCtr: number | null; avgPctViewed: number | null;
  }>;
}

/**
 * Join the planned windows with Studio's answer. A requested video with no row in its week had
 * no views that week (the query returns every video with activity in the range), so it is 0
 * views / 0 engaged / 0 hours with impressions, CTR and avg % viewed null — not reported.
 * A window Studio's answer does not carry is a shape failure, never an empty week.
 */
export function toFirstWeeks(
  windows: FirstWeekWindow[],
  answered: FirstWeekRows[],
  channelId: string,
  capturedAt: string,
): VideoFirstWeek[] {
  const byStart = new Map(answered.map((a) => [a.startDateId, a]));
  const out: VideoFirstWeek[] = [];
  for (const window of windows) {
    const answer = byStart.get(window.startDateId);
    if (!answer) {
      throw new StudioShapeError(channelId, 'MISSING_VALUE', `First-week answer has no window starting ${window.firstDay}.`);
    }
    for (const v of window.videos) {
      const row = answer.rows[v.videoId];
      out.push({
        schemaVersion: 1,
        videoId: v.videoId,
        channelId,
        publishedAt: v.publishedAt,
        firstDay: window.firstDay,
        lastDay: window.lastDay,
        capturedAt,
        source: 'studio-extension',
        views: row ? row.views : 0,
        engagedViews: row ? row.engagedViews : 0,
        watchHours: row ? row.watchHours : 0,
        impressions: row ? row.impressions : null,
        impressionsCtr: row ? row.impressionsCtr : null,
        avgPctViewed: row ? row.avgPctViewed : null,
      });
    }
  }
  return out;
}

/** Injected catalogue fetch — MAIN world, same as the analytics collector. */
async function runInjectedCatalogue(tabId: number, channelId: string): Promise<any> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: fetchCatalogueInPage,
    args: [channelId],
  });
  return results[0]?.result;
}

/** Injected A/B results fetch — MAIN world. */
async function runInjectedExperiments(
  tabId: number,
  channelId: string,
  videoIds: string[],
): Promise<any> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: fetchExperimentsInPage,
    args: [channelId, videoIds],
  });
  return results[0]?.result;
}

/** Map a catalogue/experiment failure onto the same named errors the collector uses. */
function mapCatalogueError(failure: any, channelId: string): Error {
  const message = failure?.message || 'Studio catalogue call failed';
  const code = String(failure?.kind || 'unknown').toUpperCase().replace(/-/g, '_');
  switch (failure?.kind) {
    case 'no-sapisid':
    case 'ytcfg-missing':
      return new StudioAuthError(channelId, code, message);
    case 'channel-mismatch':
      return new StudioChannelUnavailableError(channelId, message);
    case 'http':
      return failure.status === 429
        ? new StudioRateLimitError(channelId, code, message)
        : new StudioHttpError(channelId, code, message);
    case 'shape':
      return new StudioShapeError(channelId, code, message);
    default:
      return new StudioHttpError(channelId, code, message);
  }
}

// ============================================================================
// Cadence tiering
// ============================================================================

/**
 * How long to wait between snapshots for a video of the given age.
 *   ageHours < 0  -> unknown age (v1 metadata gap): collect EVERY cycle.
 *   < 7d          -> every cycle       7-28d -> daily
 *   28-365d       -> weekly            > 1y  -> monthly
 * The `< 0` branch is the only reason v1 collects everything every cycle; the
 * moment real ages arrive (metadata capture) real tiering kicks in unchanged.
 */
function tierIntervalMs(ageHours: number): number {
  if (ageHours < 0) return 0;
  if (ageHours < 7 * 24) return 0;
  if (ageHours < 28 * 24) return DAY_MS;
  if (ageHours < 365 * 24) return 7 * DAY_MS;
  return 30 * DAY_MS;
}

function isDue(ageHours: number, lastIso: string | undefined, nowMs: number): boolean {
  if (!lastIso) return true; // never captured -> backfill
  const interval = tierIntervalMs(ageHours);
  if (interval === 0) return true;
  const last = Date.parse(lastIso);
  if (Number.isNaN(last)) return true; // corrupt state -> re-collect rather than skip
  return nowMs - last >= interval - CADENCE_SKEW_MS;
}

// ============================================================================
// Managed tab: create/reuse ONE background tab, navigate it per channel, and
// CLOSE it when the cycle ends — see closeCollectorTab for why that matters.
// ============================================================================

interface StudioContext {
  ready: boolean;
  channelId: string | null;
  hasDelegation: boolean;
  /**
   * Whether window.ytcfg existed at all. Load-bearing for diagnosis: no ytcfg means the
   * tab is not on a Studio app page (a sign-in or account-chooser interstitial, say),
   * which is a completely different fault from Studio loading the WRONG channel. Without
   * this both reported the same "CHANNEL_ID=none".
   */
  ytcfgPresent: boolean;
  /**
   * The document the probe actually ran in. executeScript targets the tab's CURRENT top
   * frame, which is not necessarily the one chrome.tabs.get reports — if those two
   * disagree we were reading a document we never asked for, and the whole "Studio didn't
   * load" reading is wrong.
   */
  href: string;
  readyState: string;
}

/** What the tab's DOM looks like from the ISOLATED world, captured only on failure. */
interface TabDom {
  readyState: string;
  href: string;
  title: string;
  /** Studio's Angular root element. Present <=> the Studio app itself booted. */
  studioApp: boolean;
  scripts: number;
}

async function getStoredTabId(): Promise<number | null> {
  try {
    const s = await chrome.storage.session.get(STUDIO_TAB_KEY);
    const id = s[STUDIO_TAB_KEY];
    return typeof id === 'number' ? id : null;
  } catch {
    return null;
  }
}

async function setStoredTabId(id: number | null): Promise<void> {
  if (id === null) await chrome.storage.session.remove(STUDIO_TAB_KEY);
  else await chrome.storage.session.set({ [STUDIO_TAB_KEY]: id });
}

async function tabExists(tabId: number): Promise<boolean> {
  try {
    const t = await chrome.tabs.get(tabId);
    return !!t && t.id === tabId;
  } catch {
    return false;
  }
}

/**
 * A tab the OPERATOR already has open that is sitting on the channel we want.
 *
 * The probe is the real test and the only one worth trusting. A url match says the tab is
 * on Studio, not that Studio finished booting, not which channel ytcfg ended up on (the
 * operator can switch accounts inside one tab without the url changing), and not that a
 * delegation context is present. readStudioContext answers all three, and it is the SAME
 * probe the injected collection requires to succeed, so a tab this accepts is a tab the
 * fetch will work in.
 *
 * A candidate that cannot be probed is skipped rather than thrown on — being un-injectable
 * is a fact ABOUT that tab (still loading, discarded, a Chrome error page), not a failure
 * of the scan. Every skip is recorded and travels out in `notes` so that "no tab found"
 * can say what it looked at instead of being a bare no.
 *
 * The collector's OWN tab is excluded: adopting it would make closeCollectorTab's
 * ownership question unanswerable.
 */
async function findStudioTabOnChannel(
  channelId: string,
): Promise<{ tabId: number | null; notes: string[] }> {
  const notes: string[] = [];
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({ url: 'https://studio.youtube.com/*' });
  } catch (err) {
    throw new StudioTabError(channelId, 'TAB_QUERY_FAILED', `Could not list studio.youtube.com tabs: ${msg(err)}`);
  }

  const ownId = await getStoredTabId();
  if (tabs.length === 0) return { tabId: null, notes: ['no studio.youtube.com tab is open'] };

  for (const tab of tabs) {
    if (typeof tab.id !== 'number' || tab.id === ownId) continue;
    if (tab.discarded) {
      notes.push(`tab ${tab.id} is discarded`);
      continue;
    }
    let ctx: StudioContext | null = null;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: readStudioContext,
      });
      ctx = (results[0]?.result as StudioContext | undefined) ?? null;
    } catch (err) {
      notes.push(`tab ${tab.id} could not be probed (${msg(err)})`);
      continue;
    }
    if (!ctx || !ctx.ytcfgPresent) {
      notes.push(`tab ${tab.id} has no ytcfg yet (readyState ${ctx?.readyState ?? 'unknown'})`);
      continue;
    }
    if (ctx.channelId !== channelId) {
      notes.push(`tab ${tab.id} is on channel ${ctx.channelId ?? 'none'}`);
      continue;
    }
    if (!ctx.hasDelegation) {
      notes.push(`tab ${tab.id} is on the right channel but carries no delegation context`);
      continue;
    }
    return { tabId: tab.id, notes };
  }

  return { tabId: null, notes };
}

/**
 * The tab this channel's collection will run in, and whether WE opened it.
 *
 * ─── WHY THIS PREFERS A TAB THE OPERATOR ALREADY HAS ───
 *
 * The collector needs a page in the target channel's Studio context because the analytics
 * endpoint only answers to one (ytcfg's CHANNEL_ID and delegation context — see
 * collectStudioAnalytics). It does NOT need that page to be one we made. Opening our own
 * was simply the easiest way to guarantee the context, and the cost of that convenience
 * landed entirely on the operator: a tab appearing unbidden every six hours, including
 * mid-livestream. That is not a cosmetic complaint. A tab that shows up during a broadcast
 * is a tab that gets closed in a hurry, and closing it mid-pass kills the injected fetch
 * ("Frame with ID 0 was removed") and loses that channel's collection anyway.
 *
 * So: adopt first. The operator keeps Studio pinned, that tab already has exactly the
 * context we need, and injecting a MAIN-world fetch into it changes nothing they can see —
 * no navigation, no DOM writes, and it is emphatically not ours to close.
 *
 * ─── WHY A BACKGROUND PASS CANNOT FALL BACK TO OPENING ONE ───
 *
 * Because that is the behaviour being fixed. If the alarm may open a tab when adoption
 * misses, it opens one every time the pinned tab is on a different channel — which, with
 * three channels and one pinned tab, is most of the time. The deferral is the point: the
 * unattended path uses what is there or waits, and only the operator's own "Sync now"
 * is allowed to put something on screen.
 */
async function ensureStudioTabForChannel(channelId: string, mayOpenTab: boolean): Promise<number> {
  const adopted = await findStudioTabOnChannel(channelId);
  if (adopted.tabId !== null) return adopted.tabId;

  if (!mayOpenTab) {
    throw new NoStudioTabError(
      channelId,
      adopted.notes.length ? adopted.notes.join('; ') : 'no candidate tabs',
    );
  }

  const url = `https://studio.youtube.com/channel/${channelId}/analytics`;
  let tabId = await getStoredTabId();
  if (tabId !== null && !(await tabExists(tabId))) tabId = null;

  try {
    if (tabId === null) {
      const tab = await chrome.tabs.create({ url, active: false });
      if (typeof tab.id !== 'number') {
        throw new StudioTabError(channelId, 'NO_TAB_ID', 'chrome.tabs.create returned no tab id.');
      }
      tabId = tab.id;
    } else {
      await chrome.tabs.update(tabId, { url });
    }
  } catch (err) {
    if (err instanceof StudioTabError) throw err;
    throw new StudioTabError(channelId, 'TAB_DRIVE_FAILED', `Could not open/navigate a studio.youtube.com tab: ${msg(err)}`);
  }

  // Stored ONLY on the path that created it. The id in session storage is the answer to
  // "which tab is ours to close", and an adopted tab must never be able to answer it.
  await setStoredTabId(tabId);
  await waitForChannelContext(tabId, channelId);
  return tabId;
}

/**
 * Close the collector's tab. Called once at the end of every cycle.
 *
 * The tab exists ONLY to host the injected fetches — it is never shown, never interacted
 * with, and is dead weight the moment the last channel is done. Leaving it open (which is
 * what happened before) leaked one visible YouTube Studio tab per cycle, because the id
 * that makes the tab reusable lives in chrome.storage.session and Chrome wipes that on
 * every extension reload, update and browser restart. The next cycle then found no id,
 * opened a fresh tab, and the previous one stayed open forever with nothing to reclaim it.
 *
 * Scoping the tab to the cycle removes that class of leak entirely rather than papering
 * over it: there is no cross-cycle state left to go stale. It also rules out the tempting
 * alternative of persisting the id in storage.local, which would be actively unsafe —
 * Chrome reissues tab ids from zero after a browser restart, so a remembered id could
 * name one of the operator's own tabs, and we would navigate or close it.
 */
export async function closeCollectorTab(): Promise<void> {
  const tabId = await getStoredTabId();
  if (tabId === null) return;

  // Forget it FIRST. Whatever happens below, the next cycle must not try to drive a tab
  // we have already decided we are done with.
  await setStoredTabId(null);

  // Already gone is a normal end state — the operator can close it by hand mid-cycle —
  // so check rather than treating the resulting remove() rejection as a fault.
  if (!(await tabExists(tabId))) return;
  await chrome.tabs.remove(tabId);
}

/**
 * Poll the managed tab until Studio has loaded the requested channel's context.
 *
 * On timeout this reports WHICH of several very different faults occurred. It previously
 * collapsed all of them into "CHANNEL_ID=none, delegation absent — is the user signed
 * into that channel?", which is unactionable and often simply wrong: the same text
 * appeared whether the tab was sitting on a Google sign-in page, had been discarded by
 * Chrome under memory pressure, was still loading, or had loaded a DIFFERENT channel.
 * The 'window.ytcfg never became available' branch was unreachable — readStudioContext
 * always returns an object, so `last` was never null once a single poll completed.
 */
async function waitForChannelContext(tabId: number, channelId: string): Promise<void> {
  const deadline = Date.now() + CONTEXT_TIMEOUT_MS;
  let last: StudioContext | null = null;
  let injectionError: string | null = null;
  let probes = 0;
  let answers = 0;
  let sawYtcfg = false;

  while (Date.now() < deadline) {
    await sleep(CONTEXT_POLL_MS);
    probes++;
    let ctx: StudioContext | null = null;
    try {
      const results = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: readStudioContext });
      const first = results[0];
      ctx = first && first.result ? (first.result as StudioContext) : null;
      injectionError = null;
    } catch (err) {
      // Frame mid-navigation / not yet injectable — keep polling, but REMEMBER why, so a
      // tab that was never injectable at all can say so instead of looking like Studio
      // loaded without a channel.
      ctx = null;
      injectionError = msg(err);
    }
    if (ctx) {
      answers++;
      if (ctx.ytcfgPresent) sawYtcfg = true;
      last = ctx;
      if (ctx.channelId === channelId && ctx.hasDelegation) return;
    }
  }

  throw new StudioChannelUnavailableError(
    channelId,
    await describeStuckTab(tabId, { last, probes, answers, sawYtcfg, injectionError }),
  );
}

interface WaitEvidence {
  /** The FINAL reading — i.e. the tab's state at the moment we gave up. */
  last: StudioContext | null;
  probes: number;
  answers: number;
  /**
   * Whether ytcfg was seen in ANY probe, not just the last one. Kept separately because
   * "never appeared" is a claim about the whole window: a tab that loaded Studio and then
   * navigated away would otherwise be reported as one that never loaded it.
   */
  sawYtcfg: boolean;
  injectionError: string | null;
}

/**
 * Explain, in the operator's terms, why the tab never reached the wanted channel.
 *
 * Reads the tab's real URL and state at failure time — that single fact separates "not
 * signed in" from "Chrome killed the tab" from "Studio is just slow", which is the whole
 * difference between an actionable error and a shrug.
 */
async function describeStuckTab(tabId: number, evidence: WaitEvidence): Promise<string> {
  const { last, probes, answers, sawYtcfg, injectionError } = evidence;

  let tab: chrome.tabs.Tab | null = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return 'the collector tab disappeared while loading';
  }

  const url = tab.url || tab.pendingUrl || '';
  const where = url ? url.split('?')[0] : 'an unknown page';
  const seconds = Math.round(CONTEXT_TIMEOUT_MS / 1000);
  const status = tab.status ?? 'unknown';

  // Chrome evicts background tabs under memory pressure; the tab survives as a shell that
  // cannot be scripted. Naming this is the difference between a real diagnosis and a
  // mystery, and it has bitten this extension before.
  if (tab.discarded) {
    return `Chrome discarded the collector tab under memory pressure (was at ${where})`;
  }

  if (!url.startsWith('https://studio.youtube.com/')) {
    return `the tab was redirected to ${where} instead of Studio — sign in to this channel, or it may not be on this Google account`;
  }

  // Studio answered, with a channel — the useful cases, reported first.
  if (last?.ytcfgPresent && last.channelId) {
    return last.hasDelegation
      ? `Studio loaded a different channel (${last.channelId}) — this account may not have access to the requested one`
      : `Studio loaded channel ${last.channelId} but no delegation context, so its API calls would be rejected`;
  }

  // ANSWERS = 0 is its own fault, and used to be misreported as "window.ytcfg never
  // appeared". It is not the same claim: we never got a reading at all, so we know nothing
  // about ytcfg. executeScript resolving with no result (an empty results[], or a result
  // of undefined because the injected probe threw) produces exactly this and is invisible
  // otherwise — no exception is raised for the catch above to record.
  if (answers === 0) {
    const why = injectionError
      ? `the page could not be scripted (${injectionError})`
      : 'the injected probe returned no value';
    return `the collector could not read ${where} — ${probes} probes, none answered: ${why}; tab status ${status}${await domSuffix(tabId)}`;
  }

  if (!sawYtcfg) {
    return `Studio did not initialize at ${where} within ${seconds}s — window.ytcfg never appeared in any of ${answers} readings; tab status ${status}${await domSuffix(tabId)}`;
  }

  // ytcfg was there at some point but is not now: the tab moved under us mid-wait.
  if (!last?.ytcfgPresent) {
    return `the tab left Studio while loading — window.ytcfg was present earlier but gone by ${last?.href ?? where} (tab status ${status})`;
  }

  // ytcfg present but no CHANNEL_ID: the app is up and simply has not published a channel.
  return `Studio loaded at ${where} but never published a channel id within ${seconds}s (tab status ${status}, document ${last.readyState})`;
}

/**
 * A one-line DOM reading for the failure message, from the ISOLATED world.
 *
 * Worth the extra call precisely when the MAIN-world probe came back empty, because the
 * two worlds fail independently: `studioApp` says whether the Studio application actually
 * rendered, which separates "Studio is up but ytcfg moved/renamed" (our bug, and a silent
 * data-loss risk) from "this page is not Studio at all" (an interstitial, an error page,
 * or a renderer that never ran the page's scripts). Best-effort — a failure to read the
 * DOM is itself reported rather than hidden.
 */
async function domSuffix(tabId: number): Promise<string> {
  let dom: TabDom | null = null;
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId }, func: readTabDom });
    dom = (results[0]?.result as TabDom | undefined) ?? null;
  } catch (err) {
    return `; DOM unreadable (${msg(err)})`;
  }
  if (!dom) return '; DOM probe returned nothing';
  return `; document ${dom.readyState}, ${dom.scripts} scripts, Studio app ${dom.studioApp ? 'rendered' : 'ABSENT'}, title ${JSON.stringify(dom.title)}`;
}

// ============================================================================
// Inject the collection and map its discriminated result to typed errors
// ============================================================================

type InjectedOk = { ok: true; videos: VideoRecord[]; snapshots: Snapshot[] };
type InjectedErr = { ok: false; code: string; message: string; status?: number };
type InjectedResult = InjectedOk | InjectedErr;

async function runInjectedCollection(tabId: number, channelId: string): Promise<InjectedResult> {
  let results: chrome.scripting.InjectionResult<InjectedResult>[];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: collectStudioAnalyticsInPage,
      args: [channelId, { pageSize: PAGE_SIZE }],
    });
  } catch (err) {
    throw new StudioTabError(channelId, 'INJECTION_FAILED', `executeScript failed: ${msg(err)}`);
  }
  const first = results[0];
  if (!first || first.result === undefined || first.result === null) {
    throw new StudioTabError(channelId, 'NO_RESULT', 'Injected collection returned no result.');
  }
  return first.result;
}

type InjectedFirstWeeksResult = { ok: true; windows: FirstWeekRows[] } | InjectedErr;

/** Injected first-week fetch — MAIN world; same failure codes as the analytics collector. */
async function runInjectedFirstWeeks(
  tabId: number,
  channelId: string,
  windows: FirstWeekWindow[],
): Promise<InjectedFirstWeeksResult> {
  let results: chrome.scripting.InjectionResult<InjectedFirstWeeksResult>[];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: collectFirstWeeksInPage,
      args: [channelId, {
        windows: windows.map((w) => ({ startDateId: w.startDateId, endDateId: w.endDateId, videoIds: w.videos.map((v) => v.videoId) })),
      }],
    });
  } catch (err) {
    throw new StudioTabError(channelId, 'INJECTION_FAILED', `executeScript (first weeks) failed: ${msg(err)}`);
  }
  const first = results[0];
  if (!first || first.result === undefined || first.result === null) {
    throw new StudioTabError(channelId, 'NO_RESULT', 'Injected first-week collection returned no result.');
  }
  return first.result;
}

type InjectedDaysResult = { ok: true; days: ChannelDay[] } | InjectedErr;

/** Injected per-day fetch — MAIN world; same failure codes as the analytics collector. */
async function runInjectedChannelDays(tabId: number, channelId: string): Promise<InjectedDaysResult> {
  let results: chrome.scripting.InjectionResult<InjectedDaysResult>[];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: collectChannelDaysInPage,
      args: [channelId, { windowDays: CHANNEL_DAYS_WINDOW }],
    });
  } catch (err) {
    throw new StudioTabError(channelId, 'INJECTION_FAILED', `executeScript (channel days) failed: ${msg(err)}`);
  }
  const first = results[0];
  if (!first || first.result === undefined || first.result === null) {
    throw new StudioTabError(channelId, 'NO_RESULT', 'Injected channel-days collection returned no result.');
  }
  return first.result;
}

function mapInjectedError(err: InjectedErr, channelId: string): StudioCollectionError {
  const message = err.message || `Studio collection failed (${err.code}).`;
  switch (err.code) {
    case 'NO_SAPISID':
    case 'NO_DELEGATION':
    case 'YTCFG_MISSING':
    case 'HTTP_AUTH':
      return new StudioAuthError(channelId, err.code, message);
    case 'HTTP_RATELIMIT':
      return new StudioRateLimitError(channelId, err.code, message);
    case 'CHANNEL_MISMATCH':
      return new StudioChannelUnavailableError(channelId, message);
    case 'HTTP_ERROR':
    case 'NETWORK':
      return new StudioHttpError(channelId, err.code, message);
    case 'NO_RESULT_TABLE':
    case 'MISSING_COLUMN':
    case 'MISSING_VALUE':
    case 'BAD_JSON':
    case 'TOO_MANY_PAGES':
    case 'INJECTION_EXCEPTION':
    default:
      return new StudioShapeError(channelId, err.code, message);
  }
}

// ============================================================================
// Small SW-side helpers
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ============================================================================
// INJECTED (MAIN-world) FUNCTIONS — self-contained, close over NOTHING.
// These run inside the studio.youtube.com page. They may reference only their
// own args + page globals (window, document, crypto, fetch). Everything they
// need is inlined so they can be pasted straight into a Studio console.
// ============================================================================

/**
 * Probe: what channel context is currently loaded in this tab?
 *
 * Exported because the nav strip's data source injects the same probe into the operator's
 * OWN Studio tab to learn which channel it is on (see nav-source.ts). One probe, so the
 * two callers cannot drift into disagreeing about what "this tab has a Studio session"
 * means.
 */
export function readStudioContext(): {
  ready: boolean;
  channelId: string | null;
  hasDelegation: boolean;
  ytcfgPresent: boolean;
  href: string;
  readyState: string;
} {
  // Read outside the try: if THESE throw there is nothing sensible to report, and a probe
  // that cannot describe where it ran is worse than no probe.
  const href = location.href;
  const readyState = document.readyState;
  try {
    const cfg = (window as any).ytcfg;
    if (!cfg || typeof cfg.get !== 'function') {
      return { ready: false, channelId: null, hasDelegation: false, ytcfgPresent: false, href, readyState };
    }
    const channelId = cfg.get('CHANNEL_ID') || null;
    const delegation = cfg.get('INNERTUBE_CONTEXT_SERIALIZED_DELEGATION_CONTEXT') || null;
    return { ready: !!channelId, channelId, hasDelegation: !!delegation, ytcfgPresent: true, href, readyState };
  } catch {
    // ytcfg existed but threw — record that, so this isn't mistaken for "not on Studio".
    return { ready: false, channelId: null, hasDelegation: false, ytcfgPresent: true, href, readyState };
  }
}

/**
 * Probe: what does the tab's DOM look like? Runs in the ISOLATED world so it still
 * answers in situations where the MAIN world does not.
 */
function readTabDom(): {
  readyState: string;
  href: string;
  title: string;
  studioApp: boolean;
  scripts: number;
} {
  return {
    readyState: document.readyState,
    href: location.href,
    title: document.title,
    studioApp: !!document.querySelector('ytcp-app'),
    scripts: document.scripts.length,
  };
}

/**
 * Collect one channel's per-video lifetime analytics from Studio's internal
 * yta_web/join endpoint. Returns a discriminated result (errors are DATA, not
 * throws, so they survive the executeScript boundary with their code intact):
 *   { ok: true, videos: VideoRecord[], snapshots: Snapshot[] }
 *   { ok: false, code, message, status? }
 *
 * Standalone use (paste into a studio.youtube.com MAIN-world console on the
 * target channel's analytics page):
 *   await collectStudioAnalyticsInPage('UCxxxxxxxxxxxxxxxxxxxxxx', { pageSize: 500 })
 */
export async function collectStudioAnalyticsInPage(
  channelId: string,
  config: { pageSize?: number },
): Promise<any> {
  const PAGE = config && typeof config.pageSize === 'number' && config.pageSize > 0 ? config.pageSize : 10000;
  const ORIGIN = 'https://studio.youtube.com';
  const ENDPOINT = 'https://studio.youtube.com/youtubei/v1/yta_web/join?alt=json';
  const MAX_PAGES = 200; // runaway guard (100k videos)

  const fail = (code: string, message: string, extra?: any): any => Object.assign({ ok: false, code, message }, extra || {});

  try {
    // ---- auth: SAPISIDHASH from the SAPISID cookie ----
    const readCookie = (name: string): string | null => {
      const jar = document.cookie ? document.cookie.split('; ') : [];
      for (const pair of jar) {
        const eq = pair.indexOf('=');
        const key = eq === -1 ? pair : pair.slice(0, eq);
        if (key === name) return eq === -1 ? '' : decodeURIComponent(pair.slice(eq + 1));
      }
      return null;
    };
    const sapisid = readCookie('SAPISID') || readCookie('__Secure-3PAPISID');
    if (!sapisid) return fail('NO_SAPISID', 'SAPISID cookie is not present on studio.youtube.com — the user is not signed in.');

    const sha1Hex = async (input: string): Promise<string> => {
      const bytes = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input)));
      let hex = '';
      for (const b of bytes) hex += b.toString(16).padStart(2, '0');
      return hex;
    };
    const ts = Math.floor(Date.now() / 1000);
    const authorization = 'SAPISIDHASH ' + ts + '_' + (await sha1Hex(ts + ' ' + sapisid + ' ' + ORIGIN));

    // ---- context from ytcfg ----
    const cfg = (window as any).ytcfg;
    if (!cfg || typeof cfg.get !== 'function') return fail('YTCFG_MISSING', 'window.ytcfg is not available — not a loaded Studio page.');
    const innertube = cfg.get('INNERTUBE_CONTEXT');
    const clientVersion = innertube && innertube.client && innertube.client.clientVersion;
    if (!clientVersion) return fail('YTCFG_MISSING', 'ytcfg INNERTUBE_CONTEXT.client.clientVersion is missing.');
    const activeChannel = cfg.get('CHANNEL_ID');
    if (activeChannel !== channelId) return fail('CHANNEL_MISMATCH', 'ytcfg CHANNEL_ID (' + activeChannel + ') does not match requested channel (' + channelId + ').');
    const delegation = cfg.get('INNERTUBE_CONTEXT_SERIALIZED_DELEGATION_CONTEXT');
    if (!delegation) return fail('NO_DELEGATION', 'ytcfg INNERTUBE_CONTEXT_SERIALIZED_DELEGATION_CONTEXT is missing — tab is not a signed-in channel context.');
    // Brand (non-primary) channels require the delegation ALSO as the
    // X-YouTube-Delegation-Context header plus the auth-user index; without them
    // the analytics call 403s "caller does not have permission" for any channel
    // that isn't the Google account's default. Verified live 2026-07-22. The
    // primary channel happens to work without them, which is why it succeeded.
    const authUser = (cfg.get('SESSION_INDEX') != null) ? String(cfg.get('SESSION_INDEX')) : '0';
    const visitorData = (innertube.client && innertube.client.visitorData) || null;

    // ---- all-time timeRange: [2008-01-01, tomorrow) in the page's local tz ----
    const nowDate = new Date();
    const tomo = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() + 1);
    const exclusiveEnd = tomo.getFullYear() * 10000 + (tomo.getMonth() + 1) * 100 + tomo.getDate();

    const context = {
      client: { clientName: 62, clientVersion: clientVersion },
      user: { serializedDelegationContext: delegation },
    };

    const buildBody = (pageOffset: number): any => ({
      context,
      nodes: [{
        key: 'TABLE_QUERY',
        value: {
          query: {
            dimensions: [{ type: 'VIDEO' }],
            metrics: [
              { type: 'VIDEO_THUMBNAIL_IMPRESSIONS' },
              { type: 'VIDEO_THUMBNAIL_IMPRESSIONS_VTR' },
              { type: 'EXTERNAL_VIEWS' },
              { type: 'EXTERNAL_WATCH_TIME' },
              { type: 'AVERAGE_WATCH_PERCENTAGE' },
              // Added in 0.2.11 (names verified live 2026-10-21 on DAY and VIDEO).
              { type: 'ENGAGED_VIEWS' },
              { type: 'TOTAL_ESTIMATED_EARNINGS' },
              { type: 'CPM' },
              { type: 'RATINGS_LIKES' },
              { type: 'COMMENTS' },
              { type: 'SHARINGS' },
              { type: 'SUBSCRIBERS_GAINED' },
              { type: 'SUBSCRIBERS_LOST' },
            ],
            restricts: [{ dimension: { type: 'USER' }, inValues: [channelId] }],
            orders: [{ metric: { type: 'EXTERNAL_VIEWS' }, direction: 'ANALYTICS_ORDER_DIRECTION_DESC' }],
            timeRange: { dateIdRange: { inclusiveStart: 20080101, exclusiveEnd: exclusiveEnd } },
            limit: { pageSize: PAGE, pageOffset: pageOffset },
            currency: 'USD',
            returnDataInNewFormat: true,
            limitedToBatchedData: false,
          },
        },
      }],
    });

    const toNum = (v: any): number | null => {
      if (typeof v === 'number') return Number.isFinite(v) ? v : null;
      if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
      return null;
    };

    // Studio sends money as USD x1000 in the `earnings` holder (TOTAL_ESTIMATED_EARNINGS
    // 1000110 = $1,000.11, CPM 16501 = $16.50; checked against Studio's own UI 2026-10-21).
    // A row Studio lists in undefinedValueIndices (CPM where no ads ran) arrives here as null.
    const toUsd = (v: any): number | null => {
      const n = toNum(v);
      return n === null ? null : n / 1000;
    };

    const rows: Array<{
      videoId: string; impressions: number | null; impressionsCtr: number | null; views: number; watchHours: number; avgPctViewed: number | null;
      engagedViews: number; estimatedEarnings: number | null; cpm: number | null;
      likes: number | null; comments: number | null; shares: number | null; subsGained: number | null; subsLost: number | null;
    }> = [];

    for (let page = 0; page < MAX_PAGES; page++) {
      const pageOffset = page * PAGE;
      let resp: Response;
      try {
        resp = await fetch(ENDPOINT, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': authorization,
            'X-Origin': ORIGIN,
            'X-Goog-AuthUser': authUser,
            'X-YouTube-Delegation-Context': delegation,
            'X-YouTube-Client-Name': '62',
            'X-YouTube-Client-Version': clientVersion,
            ...(visitorData ? { 'X-Goog-Visitor-Id': visitorData } : {}),
          },
          body: JSON.stringify(buildBody(pageOffset)),
        });
      } catch (netErr: any) {
        return fail('NETWORK', 'Network error calling the Studio analytics endpoint: ' + (netErr && netErr.message ? netErr.message : String(netErr)));
      }
      if (resp.status === 401 || resp.status === 403) return fail('HTTP_AUTH', 'Studio analytics endpoint returned HTTP ' + resp.status + ' — auth/delegation rejected.', { status: resp.status });
      if (resp.status === 429) return fail('HTTP_RATELIMIT', 'Studio analytics endpoint returned HTTP 429 — rate limited.', { status: 429 });
      if (!resp.ok) return fail('HTTP_ERROR', 'Studio analytics endpoint returned HTTP ' + resp.status + '.', { status: resp.status });

      let data: any;
      try { data = await resp.json(); } catch { return fail('BAD_JSON', 'Studio analytics response body was not valid JSON.'); }

      const results = data && data.results;
      if (!Array.isArray(results)) return fail('NO_RESULT_TABLE', 'Response had no results[] array.');
      const node = results.find((r: any) => r && r.value && r.value.resultTable);
      if (!node) return fail('NO_RESULT_TABLE', 'No results[] entry carried a resultTable.');
      const table = node.value.resultTable;

      const dimCol = table && table.dimensionColumns && table.dimensionColumns[0];
      const ids = dimCol && dimCol.strings && dimCol.strings.values;
      if (!Array.isArray(ids)) return fail('MISSING_COLUMN', 'resultTable.dimensionColumns[0].strings.values (videoIds) is missing.');
      const rowCount = ids.length;
      const metricCols: any[] = Array.isArray(table.metricColumns) ? table.metricColumns : [];

      // Match a metric column by .metric.type (never by index), read its NAMED value holder,
      // and return the parallel array with null at every undefined index. Returns { __err }
      // on any shape break.
      // In the new-format response a metric column may carry, beside its value holder,
      // `undefinedValueIndices` (rows where Studio has NO value; the value array still holds 0
      // there). Measured live 2026-10-21 on a 3,057-row per-video table: CPM 798 such rows,
      // TOTAL_ESTIMATED_EARNINGS 503, VTR 9, views/engaged views 1. Those rows are null — not
      // captured, never a real-looking 0. A required metric's null still fails as MISSING_VALUE.
      // `columnAnomalies` is informational and ignored.
      const seriesOf = (metricType: string, holderName: string): any => {
        const column = metricCols.find((c) => c && c.metric && c.metric.type === metricType);
        if (!column) return { __err: fail('MISSING_COLUMN', 'Required metric column ' + metricType + ' is absent from the response.') };
        const arr = column[holderName] && column[holderName].values;
        if (!Array.isArray(arr)) return { __err: fail('MISSING_COLUMN', 'Metric column ' + metricType + ' has no ' + holderName + '.values array (keys: ' + Object.keys(column).join(', ') + ').') };
        if (arr.length !== rowCount) return { __err: fail('MISSING_COLUMN', 'Metric column ' + metricType + ' length ' + arr.length + ' != row count ' + rowCount + '.') };
        const undef = column.undefinedValueIndices;
        if (undef === undefined) return arr;
        if (!Array.isArray(undef) || undef.some((i: any) => !Number.isInteger(i) || i < 0 || i >= rowCount)) {
          return { __err: fail('MISSING_COLUMN', 'Metric column ' + metricType + ' has an unreadable undefinedValueIndices (' + JSON.stringify(undef).slice(0, 80) + ').') };
        }
        const out = arr.slice();
        for (const i of undef) out[i] = null;
        return out;
      };

      const impArr = seriesOf('VIDEO_THUMBNAIL_IMPRESSIONS', 'counts');
      if (impArr && impArr.__err) return impArr.__err;
      const vtrArr = seriesOf('VIDEO_THUMBNAIL_IMPRESSIONS_VTR', 'percentages');
      if (vtrArr && vtrArr.__err) return vtrArr.__err;
      const viewsArr = seriesOf('EXTERNAL_VIEWS', 'counts');
      if (viewsArr && viewsArr.__err) return viewsArr.__err;
      const watchArr = seriesOf('EXTERNAL_WATCH_TIME', 'milliseconds');
      if (watchArr && watchArr.__err) return watchArr.__err;
      const avgArr = seriesOf('AVERAGE_WATCH_PERCENTAGE', 'percentages');
      if (avgArr && avgArr.__err) return avgArr.__err;

      // The 0.2.11 metrics; holders verified live 2026-10-21 (Fireside): counts, and
      // `earnings` for the two money metrics.
      const engagedArr = seriesOf('ENGAGED_VIEWS', 'counts'); if (engagedArr.__err) return engagedArr.__err;
      const earnArr = seriesOf('TOTAL_ESTIMATED_EARNINGS', 'earnings'); if (earnArr.__err) return earnArr.__err;
      const cpmArr = seriesOf('CPM', 'earnings'); if (cpmArr.__err) return cpmArr.__err;
      const likesArr = seriesOf('RATINGS_LIKES', 'counts'); if (likesArr.__err) return likesArr.__err;
      const commentsArr = seriesOf('COMMENTS', 'counts'); if (commentsArr.__err) return commentsArr.__err;
      const sharesArr = seriesOf('SHARINGS', 'counts'); if (sharesArr.__err) return sharesArr.__err;
      const gainedArr = seriesOf('SUBSCRIBERS_GAINED', 'counts'); if (gainedArr.__err) return gainedArr.__err;
      const lostArr = seriesOf('SUBSCRIBERS_LOST', 'counts'); if (lostArr.__err) return lostArr.__err;

      for (let i = 0; i < rowCount; i++) {
        const videoId = ids[i];
        if (typeof videoId !== 'string' || videoId.length === 0) return fail('MISSING_COLUMN', 'videoId at row ' + i + ' is not a non-empty string.');
        const views = toNum(viewsArr[i]);
        // EXTERNAL_WATCH_TIME comes back in MILLISECONDS (holder `milliseconds`) —
        // verified live against Studio 2026-07-22; convert to hours for the Snapshot.
        const watchMs = toNum(watchArr[i]);
        // Engaged views are what ContentStudio compares videos on (raw views include Home-feed
        // autoplay previews from 2026-08-27), so they are required like views.
        const engagedViews = toNum(engagedArr[i]);
        if (views === null || watchMs === null || engagedViews === null) {
          return fail('MISSING_VALUE', 'Row ' + i + ' (video ' + videoId + ') is missing a required numeric views/engaged-views/watch-time value.');
        }
        const watchHours = watchMs / 3600000;
        rows.push({
          videoId: videoId,
          impressions: toNum(impArr[i]),
          impressionsCtr: toNum(vtrArr[i]),
          views: views,
          watchHours: watchHours,
          avgPctViewed: toNum(avgArr[i]),
          engagedViews: engagedViews,
          estimatedEarnings: toUsd(earnArr[i]),
          cpm: toUsd(cpmArr[i]),
          likes: toNum(likesArr[i]),
          comments: toNum(commentsArr[i]),
          shares: toNum(sharesArr[i]),
          subsGained: toNum(gainedArr[i]),
          subsLost: toNum(lostArr[i]),
        });
      }

      // Single request only: offset paging is unsupported (see PAGE_SIZE note), so
      // PAGE is sized to cover a whole channel. A completely full page means the
      // catalog may exceed one request — fail loud rather than silently dropping the
      // overflow videos.
      if (rowCount >= PAGE) return fail('PAGE_CAP', 'Channel returned a full page of ' + PAGE + ' rows; catalog may exceed a single request and offset paging is unsupported.');
      break;
    }

    const capturedAt = new Date().toISOString();
    const snapshots = rows.map((r) => ({
      schemaVersion: 2,
      videoId: r.videoId,
      channelId: channelId,
      capturedAt: capturedAt,
      source: 'studio-extension',
      // -1 = age unknown HERE: this page function has no publish dates. collectChannel
      // replaces it from the catalogue (withVideoAges) for every video that has one.
      videoAgeHours: -1,
      impressions: r.impressions,
      impressionsCtr: r.impressionsCtr,
      views: r.views,
      watchHours: r.watchHours,
      avgViewDurationSec: null,
      avgPctViewed: r.avgPctViewed,
      retention: null,
      trafficShare: null,   // TODO(v2): dimension TRAFFIC_SOURCE_TYPE -> trafficShare + ctrBySource
      ctrBySource: null,    // TODO(v2): VTR of the browse/search/suggested source rows
      topSearchTerms: null, // TODO(v2): dimension TRAFFIC_SOURCE_DETAIL + restrict TRAFFIC_SOURCE_TYPE==YT_SEARCH
      // Filled since 0.2.11. They were null with the note "owned by the analytics-API
      // collector", but that collector (electron api-collector.service) last ran 2026-07-23;
      // nothing has filled them since.
      subsGained: r.subsGained,
      likes: r.likes,
      comments: r.comments,
      shares: r.shares,
      engagedViews: r.engagedViews,
      estimatedEarnings: r.estimatedEarnings,
      cpm: r.cpm,
      subsLost: r.subsLost,
    }));

    // VideoRecords are DEFERRED in v1 (see the module header TODO(v1-metadata)).
    const videos: any[] = [];

    return { ok: true, videos: videos, snapshots: snapshots };
  } catch (err: any) {
    return fail('INJECTION_EXCEPTION', 'Unexpected error in the injected collector: ' + (err && err.message ? err.message : String(err)));
  }
}

/**
 * Collect one channel's PER-DAY series over the last `windowDays` days (today included,
 * page-local calendar) from the same yta_web/join endpoint. Two requests:
 *   1. DAY                         -> impressions, CTR, views, watch time, new/returning
 *                                     viewers, net subscribers
 *   2. DAY x TRAFFIC_SOURCE_TYPE   -> impressions, CTR, views per source
 * joined by day into ChannelDay rows. Returns a discriminated result like
 * collectStudioAnalyticsInPage:
 *   { ok: true, days: ChannelDay[] }   (ascending by day)
 *   { ok: false, code, message, status? }
 *
 * Self-contained for the same reason as collectStudioAnalyticsInPage (it runs through
 * executeScript world:'MAIN' and closes over NOTHING), so it repeats that function's auth,
 * ytcfg and request code rather than sharing it. Standalone use, in a Studio console on the
 * target channel:
 *   await collectChannelDaysInPage('UCxxxxxxxxxxxxxxxxxxxxxx', { windowDays: 35 })
 *
 * A day Studio returns no DAY row for is not emitted: it is not known to be zero.
 */
export async function collectChannelDaysInPage(
  channelId: string,
  config: { windowDays: number },
): Promise<any> {
  const ORIGIN = 'https://studio.youtube.com';
  const ENDPOINT = 'https://studio.youtube.com/youtubei/v1/yta_web/join?alt=json';
  // The endpoint's page cap (10,000 accepted, 15,000 rejected; see PAGE_SIZE). A 400-day
  // window by ~13 traffic sources is ~5,200 rows, over the 5,000 this used to ask for.
  const PAGE = 10000;

  const fail = (code: string, message: string, extra?: any): any => Object.assign({ ok: false, code, message }, extra || {});

  try {
    const windowDays = config && typeof config.windowDays === 'number' && config.windowDays > 0 ? Math.floor(config.windowDays) : 0;
    if (windowDays <= 0) return fail('INJECTION_EXCEPTION', 'collectChannelDaysInPage needs a positive config.windowDays.');

    // ---- auth: SAPISIDHASH from the SAPISID cookie (as collectStudioAnalyticsInPage) ----
    const readCookie = (name: string): string | null => {
      const jar = document.cookie ? document.cookie.split('; ') : [];
      for (const pair of jar) {
        const eq = pair.indexOf('=');
        const key = eq === -1 ? pair : pair.slice(0, eq);
        if (key === name) return eq === -1 ? '' : decodeURIComponent(pair.slice(eq + 1));
      }
      return null;
    };
    const sapisid = readCookie('SAPISID') || readCookie('__Secure-3PAPISID');
    if (!sapisid) return fail('NO_SAPISID', 'SAPISID cookie is not present on studio.youtube.com — the user is not signed in.');

    const sha1Hex = async (input: string): Promise<string> => {
      const bytes = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input)));
      let hex = '';
      for (const b of bytes) hex += b.toString(16).padStart(2, '0');
      return hex;
    };
    const ts = Math.floor(Date.now() / 1000);
    const authorization = 'SAPISIDHASH ' + ts + '_' + (await sha1Hex(ts + ' ' + sapisid + ' ' + ORIGIN));

    // ---- context from ytcfg ----
    const cfg = (window as any).ytcfg;
    if (!cfg || typeof cfg.get !== 'function') return fail('YTCFG_MISSING', 'window.ytcfg is not available — not a loaded Studio page.');
    const innertube = cfg.get('INNERTUBE_CONTEXT');
    const clientVersion = innertube && innertube.client && innertube.client.clientVersion;
    if (!clientVersion) return fail('YTCFG_MISSING', 'ytcfg INNERTUBE_CONTEXT.client.clientVersion is missing.');
    const activeChannel = cfg.get('CHANNEL_ID');
    if (activeChannel !== channelId) return fail('CHANNEL_MISMATCH', 'ytcfg CHANNEL_ID (' + activeChannel + ') does not match requested channel (' + channelId + ').');
    const delegation = cfg.get('INNERTUBE_CONTEXT_SERIALIZED_DELEGATION_CONTEXT');
    if (!delegation) return fail('NO_DELEGATION', 'ytcfg INNERTUBE_CONTEXT_SERIALIZED_DELEGATION_CONTEXT is missing — tab is not a signed-in channel context.');
    // Brand channels need the delegation header + auth-user index too (verified 2026-07-22).
    const authUser = (cfg.get('SESSION_INDEX') != null) ? String(cfg.get('SESSION_INDEX')) : '0';
    const visitorData = (innertube.client && innertube.client.visitorData) || null;

    // ---- window: [today - (windowDays-1), tomorrow) in the page's local calendar ----
    const nowDate = new Date();
    const dateId = (d: Date): number => d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    const inclusiveStart = dateId(new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - (windowDays - 1)));
    const exclusiveEnd = dateId(new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() + 1));

    const context = {
      client: { clientName: 62, clientVersion: clientVersion },
      user: { serializedDelegationContext: delegation },
    };

    const toNum = (v: any): number | null => {
      if (typeof v === 'number') return Number.isFinite(v) ? v : null;
      if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
      return null;
    };

    // One TABLE_QUERY → its resultTable, or a fail() object (marked __fail).
    const runQuery = async (label: string, dimensions: any[], metrics: string[]): Promise<any> => {
      const body = {
        context,
        nodes: [{
          key: 'TABLE_QUERY',
          value: {
            query: {
              dimensions: dimensions,
              metrics: metrics.map((type) => ({ type })),
              restricts: [{ dimension: { type: 'USER' }, inValues: [channelId] }],
              orders: [{ metric: { type: 'EXTERNAL_VIEWS' }, direction: 'ANALYTICS_ORDER_DIRECTION_DESC' }],
              timeRange: { dateIdRange: { inclusiveStart: inclusiveStart, exclusiveEnd: exclusiveEnd } },
              limit: { pageSize: PAGE, pageOffset: 0 },
              currency: 'USD',
              returnDataInNewFormat: true,
              limitedToBatchedData: false,
            },
          },
        }],
      };
      let resp: Response;
      try {
        resp = await fetch(ENDPOINT, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': authorization,
            'X-Origin': ORIGIN,
            'X-Goog-AuthUser': authUser,
            'X-YouTube-Delegation-Context': delegation,
            'X-YouTube-Client-Name': '62',
            'X-YouTube-Client-Version': clientVersion,
            ...(visitorData ? { 'X-Goog-Visitor-Id': visitorData } : {}),
          },
          body: JSON.stringify(body),
        });
      } catch (netErr: any) {
        return { __fail: fail('NETWORK', 'Network error calling the Studio analytics endpoint (' + label + '): ' + (netErr && netErr.message ? netErr.message : String(netErr))) };
      }
      if (resp.status === 401 || resp.status === 403) return { __fail: fail('HTTP_AUTH', 'Studio analytics endpoint returned HTTP ' + resp.status + ' (' + label + ') — auth/delegation rejected.', { status: resp.status }) };
      if (resp.status === 429) return { __fail: fail('HTTP_RATELIMIT', 'Studio analytics endpoint returned HTTP 429 (' + label + ') — rate limited.', { status: 429 }) };
      if (!resp.ok) return { __fail: fail('HTTP_ERROR', 'Studio analytics endpoint returned HTTP ' + resp.status + ' (' + label + ').', { status: resp.status }) };
      let data: any;
      try { data = await resp.json(); } catch { return { __fail: fail('BAD_JSON', 'Studio analytics response body (' + label + ') was not valid JSON.') }; }
      const results = data && data.results;
      if (!Array.isArray(results)) return { __fail: fail('NO_RESULT_TABLE', 'Response (' + label + ') had no results[] array.') };
      const node = results.find((r: any) => r && r.value && r.value.resultTable);
      if (!node) return { __fail: fail('NO_RESULT_TABLE', 'No results[] entry (' + label + ') carried a resultTable.') };
      return { table: node.value.resultTable };
    };

    // A dimension column by .dimension.type (never by index) and the named value holder.
    const dimensionOf = (label: string, table: any, type: string, holder: string): any => {
      const cols: any[] = Array.isArray(table.dimensionColumns) ? table.dimensionColumns : [];
      const column = cols.find((c) => c && c.dimension && c.dimension.type === type);
      const arr = column && column[holder] && column[holder].values;
      if (!Array.isArray(arr)) return { __err: fail('MISSING_COLUMN', 'Dimension column ' + type + '.' + holder + '.values is absent from the ' + label + ' response.') };
      return arr;
    };
    // A metric column by .metric.type and its parallel array, checked against the row count.
    // Columns may list `undefinedValueIndices` beside the holder: those rows are null (see
    // collectStudioAnalyticsInPage). A required metric's null still fails as MISSING_VALUE.
    const metricOf = (label: string, table: any, type: string, holder: string, rowCount: number): any => {
      const cols: any[] = Array.isArray(table.metricColumns) ? table.metricColumns : [];
      const column = cols.find((c) => c && c.metric && c.metric.type === type);
      if (!column) return { __err: fail('MISSING_COLUMN', 'Required metric column ' + type + ' is absent from the ' + label + ' response.') };
      const arr = column[holder] && column[holder].values;
      if (!Array.isArray(arr)) return { __err: fail('MISSING_COLUMN', 'Metric column ' + type + ' (' + label + ') has no ' + holder + '.values array.') };
      if (arr.length !== rowCount) return { __err: fail('MISSING_COLUMN', 'Metric column ' + type + ' (' + label + ') length ' + arr.length + ' != row count ' + rowCount + '.') };
      const undef = column.undefinedValueIndices;
      if (undef === undefined) return arr;
      if (!Array.isArray(undef) || undef.some((n: any) => !Number.isInteger(n) || n < 0 || n >= rowCount)) {
        return { __err: fail('MISSING_COLUMN', 'Metric column ' + type + ' (' + label + ') has an unreadable undefinedValueIndices.') };
      }
      const out = arr.slice();
      for (const n of undef) out[n] = null;
      return out;
    };
    // Money is USD x1000 in the `earnings` holder (TOTAL_ESTIMATED_EARNINGS 1000110 =
    // $1,000.11, CPM 16501 = $16.50, checked against Studio's UI 2026-10-21). A row in the
    // column's undefinedValueIndices (CPM where no ads ran) is null, never $0.
    const toUsd = (v: any): number | null => {
      const n = toNum(v);
      return n === null ? null : n / 1000;
    };

    // DAY comes back as integer date ids (20261019) in the `dateIds` holder.
    const dayKey = (id: any): string | null => {
      const n = toNum(id);
      if (n === null || !Number.isInteger(n) || n < 19000101 || n > 99991231) return null;
      const s = String(n);
      return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
    };

    // ======== Query 1: per day ========
    const q1 = await runQuery('per-day', [{ type: 'DAY' }], [
      'VIDEO_THUMBNAIL_IMPRESSIONS', 'VIDEO_THUMBNAIL_IMPRESSIONS_VTR', 'EXTERNAL_VIEWS', 'EXTERNAL_WATCH_TIME',
      'NEW_VIEWERS', 'RETURNING_VIEWERS', 'SUBSCRIBERS_NET_CHANGE',
      'ENGAGED_VIEWS', 'TOTAL_ESTIMATED_EARNINGS', 'CPM', 'RATINGS_LIKES', 'COMMENTS', 'SHARINGS',
      'SUBSCRIBERS_GAINED', 'SUBSCRIBERS_LOST',
    ]);
    if (q1.__fail) return q1.__fail;
    const t1 = q1.table;
    const days1 = dimensionOf('per-day', t1, 'DAY', 'dateIds');
    if (days1.__err) return days1.__err;
    const n1 = days1.length;
    if (n1 >= PAGE) return fail('PAGE_CAP', 'Per-day query returned a full page of ' + PAGE + ' rows; offset paging is unsupported.');
    const imp1 = metricOf('per-day', t1, 'VIDEO_THUMBNAIL_IMPRESSIONS', 'counts', n1); if (imp1.__err) return imp1.__err;
    const vtr1 = metricOf('per-day', t1, 'VIDEO_THUMBNAIL_IMPRESSIONS_VTR', 'percentages', n1); if (vtr1.__err) return vtr1.__err;
    const views1 = metricOf('per-day', t1, 'EXTERNAL_VIEWS', 'counts', n1); if (views1.__err) return views1.__err;
    const watch1 = metricOf('per-day', t1, 'EXTERNAL_WATCH_TIME', 'milliseconds', n1); if (watch1.__err) return watch1.__err;
    const newV1 = metricOf('per-day', t1, 'NEW_VIEWERS', 'counts', n1); if (newV1.__err) return newV1.__err;
    const retV1 = metricOf('per-day', t1, 'RETURNING_VIEWERS', 'counts', n1); if (retV1.__err) return retV1.__err;
    const subs1 = metricOf('per-day', t1, 'SUBSCRIBERS_NET_CHANGE', 'counts', n1); if (subs1.__err) return subs1.__err;
    const engaged1 = metricOf('per-day', t1, 'ENGAGED_VIEWS', 'counts', n1); if (engaged1.__err) return engaged1.__err;
    const earn1 = metricOf('per-day', t1, 'TOTAL_ESTIMATED_EARNINGS', 'earnings', n1); if (earn1.__err) return earn1.__err;
    const cpm1 = metricOf('per-day', t1, 'CPM', 'earnings', n1); if (cpm1.__err) return cpm1.__err;
    const likes1 = metricOf('per-day', t1, 'RATINGS_LIKES', 'counts', n1); if (likes1.__err) return likes1.__err;
    const comments1 = metricOf('per-day', t1, 'COMMENTS', 'counts', n1); if (comments1.__err) return comments1.__err;
    const shares1 = metricOf('per-day', t1, 'SHARINGS', 'counts', n1); if (shares1.__err) return shares1.__err;
    const gained1 = metricOf('per-day', t1, 'SUBSCRIBERS_GAINED', 'counts', n1); if (gained1.__err) return gained1.__err;
    const lost1 = metricOf('per-day', t1, 'SUBSCRIBERS_LOST', 'counts', n1); if (lost1.__err) return lost1.__err;

    const capturedAt = new Date().toISOString();
    const emptySource = (): any => ({ impressions: null, impressionsCtr: null, views: 0 });
    const emptyLocation = (): any => ({ views: 0, engagedViews: 0, watchHours: 0 });
    const byDay = new Map<string, any>();
    for (let i = 0; i < n1; i++) {
      const day = dayKey(days1[i]);
      if (day === null) return fail('MISSING_VALUE', 'Per-day row ' + i + ' has an unreadable DAY id (' + JSON.stringify(days1[i]) + ').');
      if (byDay.has(day)) return fail('MISSING_VALUE', 'Per-day response carries day ' + day + ' twice.');
      const views = toNum(views1[i]);
      const watchMs = toNum(watch1[i]);
      const engagedViews = toNum(engaged1[i]);
      if (views === null || watchMs === null || engagedViews === null) return fail('MISSING_VALUE', 'Day ' + day + ' is missing a required numeric views/engaged-views/watch-time value.');
      let newViewers = toNum(newV1[i]);
      let returningViewers = toNum(retV1[i]);
      // Observed live 2026-10-21: for the most recent ~2 days Studio has not computed the
      // viewer cohorts yet and returns NEW_VIEWERS=0 and RETURNING_VIEWERS=0 while the day
      // already has views. That is "not computed yet", not zero, so it is stored as null; a
      // later cycle re-fetches the day and overwrites it with the real numbers.
      if (newViewers === 0 && returningViewers === 0 && views > 0) {
        newViewers = null;
        returningViewers = null;
      }
      byDay.set(day, {
        schemaVersion: 2,
        channelId: channelId,
        day: day,
        capturedAt: capturedAt,
        source: 'studio-extension',
        impressions: toNum(imp1[i]),
        impressionsCtr: toNum(vtr1[i]),
        views: views,
        // EXTERNAL_WATCH_TIME is in MILLISECONDS (holder `milliseconds`), as in the per-video query.
        watchHours: watchMs / 3600000,
        newViewers: newViewers,
        returningViewers: returningViewers,
        subsNetChange: toNum(subs1[i]),
        bySource: {
          browse: emptySource(), suggested: emptySource(), search: emptySource(), channel: emptySource(),
          playlist: emptySource(), direct: emptySource(), external: emptySource(), notification: emptySource(),
          shorts: emptySource(), endScreen: emptySource(), other: emptySource(),
        },
        otherSources: [],
        engagedViews: engagedViews,
        estimatedEarnings: toUsd(earn1[i]),
        cpm: toUsd(cpm1[i]),
        likes: toNum(likes1[i]),
        comments: toNum(comments1[i]),
        shares: toNum(shares1[i]),
        subsGained: toNum(gained1[i]),
        subsLost: toNum(lost1[i]),
        byLocation: {
          browse: emptyLocation(), watch: emptyLocation(), shortsFeed: emptyLocation(),
          channel: emptyLocation(), embedded: emptyLocation(), other: emptyLocation(),
        },
        otherLocations: [],
      });
    }

    // ======== Query 2: per day per traffic source ========
    const q2 = await runQuery('per-day-per-source', [{ type: 'DAY' }, { type: 'TRAFFIC_SOURCE_TYPE' }], [
      'VIDEO_THUMBNAIL_IMPRESSIONS', 'VIDEO_THUMBNAIL_IMPRESSIONS_VTR', 'EXTERNAL_VIEWS',
    ]);
    if (q2.__fail) return q2.__fail;
    const t2 = q2.table;
    const days2 = dimensionOf('per-day-per-source', t2, 'DAY', 'dateIds');
    if (days2.__err) return days2.__err;
    const sources2 = dimensionOf('per-day-per-source', t2, 'TRAFFIC_SOURCE_TYPE', 'enumValues');
    if (sources2.__err) return sources2.__err;
    const n2 = days2.length;
    if (sources2.length !== n2) return fail('MISSING_COLUMN', 'TRAFFIC_SOURCE_TYPE column length ' + sources2.length + ' != DAY column length ' + n2 + '.');
    if (n2 >= PAGE) return fail('PAGE_CAP', 'Per-source query returned a full page of ' + PAGE + ' rows; offset paging is unsupported.');
    const imp2 = metricOf('per-day-per-source', t2, 'VIDEO_THUMBNAIL_IMPRESSIONS', 'counts', n2); if (imp2.__err) return imp2.__err;
    const vtr2 = metricOf('per-day-per-source', t2, 'VIDEO_THUMBNAIL_IMPRESSIONS_VTR', 'percentages', n2); if (vtr2.__err) return vtr2.__err;
    const views2 = metricOf('per-day-per-source', t2, 'EXTERNAL_VIEWS', 'counts', n2); if (views2.__err) return views2.__err;

    // Studio enum -> our key. SUBSCRIBER is YouTube's "Browse features" (Home + the
    // subscriptions feed), NOT the subscriber count. Anything not named here — YT_OTHER_PAGE,
    // HASHTAGS, or an enum Studio adds later — is folded into `other` and its name recorded
    // in otherSources, so nothing disappears unnamed.
    const SOURCE_KEYS: Record<string, string> = {
      SUBSCRIBER: 'browse',
      YT_RELATED: 'suggested',
      YT_SEARCH: 'search',
      YT_CHANNEL: 'channel',
      PLAYLIST: 'playlist',
      UNKNOWN_MOBILE_OR_DIRECT: 'direct',
      EXT_URL: 'external',
      NOTIFICATION: 'notification',
      SHORTS: 'shorts',
      END_SCREEN: 'endScreen',
    };
    const seen = new Set<string>();
    const otherNames = new Map<string, Set<string>>();
    for (let i = 0; i < n2; i++) {
      const day = dayKey(days2[i]);
      if (day === null) return fail('MISSING_VALUE', 'Per-source row ' + i + ' has an unreadable DAY id (' + JSON.stringify(days2[i]) + ').');
      const studioName = sources2[i];
      if (typeof studioName !== 'string' || studioName.length === 0) return fail('MISSING_VALUE', 'Per-source row ' + i + ' (' + day + ') has no TRAFFIC_SOURCE_TYPE name.');
      const row = byDay.get(day);
      // The per-source rows split the per-day totals, so a source row for a day the per-day
      // query did not return means the two answers disagree — refuse rather than guess.
      if (!row) return fail('MISSING_VALUE', 'Per-source response has day ' + day + ' (' + studioName + ') that the per-day response does not.');
      const views = toNum(views2[i]);
      if (views === null) return fail('MISSING_VALUE', 'Day ' + day + ' source ' + studioName + ' has no numeric views value.');
      const impressions = toNum(imp2[i]);
      const ctr = toNum(vtr2[i]);
      const key = SOURCE_KEYS[studioName];
      if (key) {
        if (seen.has(day + '|' + key)) return fail('MISSING_VALUE', 'Per-source response carries ' + studioName + ' twice for day ' + day + '.');
        seen.add(day + '|' + key);
        row.bySource[key] = { impressions: impressions, impressionsCtr: ctr, views: views };
      } else {
        const other = row.bySource.other;
        other.views += views;
        // Summed over the folded rows that HAVE impressions; stays null if none do.
        if (impressions !== null) other.impressions = (other.impressions === null ? 0 : other.impressions) + impressions;
        if (!otherNames.has(day)) otherNames.set(day, new Set<string>());
        otherNames.get(day)!.add(studioName);
      }
    }
    for (const [day, names] of otherNames) {
      const row = byDay.get(day);
      row.otherSources = Array.from(names).sort();
      const other = row.bySource.other;
      // A folded bucket has no CTR of its own from Studio; it is derived only when there is
      // a positive impressions figure to divide by.
      other.impressionsCtr = typeof other.impressions === 'number' && other.impressions > 0
        ? (other.views / other.impressions) * 100
        : null;
    }

    // ======== Query 3: per day per playback location ========
    // Where the view happened, as opposed to which surface sent the viewer. From 2026-08-27
    // YouTube counts inline Home-feed autoplay previews as views: on the main channel BROWSE
    // went from 181 views / 181 engaged on 08-26 to 5,276 views / 713 engaged on 08-27. This
    // split is what shows that per day.
    const q3 = await runQuery('per-day-per-location', [{ type: 'DAY' }, { type: 'PLAYBACK_LOCATION_TYPE' }], [
      'EXTERNAL_VIEWS', 'ENGAGED_VIEWS', 'EXTERNAL_WATCH_TIME',
    ]);
    if (q3.__fail) return q3.__fail;
    const t3 = q3.table;
    const days3 = dimensionOf('per-day-per-location', t3, 'DAY', 'dateIds');
    if (days3.__err) return days3.__err;
    // Location names are in `enumValues`, like TRAFFIC_SOURCE_TYPE (verified live 2026-10-21).
    const locations3 = dimensionOf('per-day-per-location', t3, 'PLAYBACK_LOCATION_TYPE', 'enumValues');
    if (locations3.__err) return locations3.__err;
    const n3 = days3.length;
    if (locations3.length !== n3) return fail('MISSING_COLUMN', 'PLAYBACK_LOCATION_TYPE column length ' + locations3.length + ' != DAY column length ' + n3 + '.');
    if (n3 >= PAGE) return fail('PAGE_CAP', 'Per-location query returned a full page of ' + PAGE + ' rows; offset paging is unsupported.');
    const views3 = metricOf('per-day-per-location', t3, 'EXTERNAL_VIEWS', 'counts', n3); if (views3.__err) return views3.__err;
    const engaged3 = metricOf('per-day-per-location', t3, 'ENGAGED_VIEWS', 'counts', n3); if (engaged3.__err) return engaged3.__err;
    const watch3 = metricOf('per-day-per-location', t3, 'EXTERNAL_WATCH_TIME', 'milliseconds', n3); if (watch3.__err) return watch3.__err;

    // Studio enum -> our key, as for traffic sources. Seen live over 400 days (2026-10-21):
    // WATCH, BROWSE, SHORTS_FEED, EMBEDDED, IMMERSIVE_LIVE_FEED, CHANNEL. Anything else —
    // IMMERSIVE_LIVE_FEED included, or a future enum — is summed into `other` and named in
    // otherLocations.
    const LOCATION_KEYS: Record<string, string> = {
      BROWSE: 'browse',
      WATCH: 'watch',
      SHORTS_FEED: 'shortsFeed',
      CHANNEL: 'channel',
      EMBEDDED: 'embedded',
    };
    const seenLocation = new Set<string>();
    const otherLocationNames = new Map<string, Set<string>>();
    for (let i = 0; i < n3; i++) {
      const day = dayKey(days3[i]);
      if (day === null) return fail('MISSING_VALUE', 'Per-location row ' + i + ' has an unreadable DAY id (' + JSON.stringify(days3[i]) + ').');
      const studioName = locations3[i];
      if (typeof studioName !== 'string' || studioName.length === 0) return fail('MISSING_VALUE', 'Per-location row ' + i + ' (' + day + ') has no PLAYBACK_LOCATION_TYPE name.');
      const row = byDay.get(day);
      if (!row) return fail('MISSING_VALUE', 'Per-location response has day ' + day + ' (' + studioName + ') that the per-day response does not.');
      const views = toNum(views3[i]);
      const engagedViews = toNum(engaged3[i]);
      const watchMs = toNum(watch3[i]);
      if (views === null || engagedViews === null || watchMs === null) {
        return fail('MISSING_VALUE', 'Day ' + day + ' location ' + studioName + ' is missing a numeric views/engaged-views/watch-time value.');
      }
      const key = LOCATION_KEYS[studioName] || 'other';
      if (key !== 'other') {
        if (seenLocation.has(day + '|' + key)) return fail('MISSING_VALUE', 'Per-location response carries ' + studioName + ' twice for day ' + day + '.');
        seenLocation.add(day + '|' + key);
      } else {
        if (!otherLocationNames.has(day)) otherLocationNames.set(day, new Set<string>());
        otherLocationNames.get(day)!.add(studioName);
      }
      const target = row.byLocation[key];
      target.views += views;
      target.engagedViews += engagedViews;
      target.watchHours += watchMs / 3600000;
    }
    for (const [day, names] of otherLocationNames) {
      byDay.get(day).otherLocations = Array.from(names).sort();
    }

    const days = Array.from(byDay.values()).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    return { ok: true, days: days };
  } catch (err: any) {
    return fail('INJECTION_EXCEPTION', 'Unexpected error in the injected channel-days collector: ' + (err && err.message ? err.message : String(err)));
  }
}

/**
 * Collect first-week totals: one VIDEO query per window, timeRange = the window's seven days
 * [startDateId, endDateId), restricted to the channel only (the VIDEO dimension and the USER
 * restrict are what the lifetime query already uses; no per-video restrict is needed), and
 * the rows for the window's requested videos picked out by id. Returns
 *   { ok: true, windows: [{ startDateId, rows: { [videoId]: {...} } }] }
 *   { ok: false, code, message, status? }
 * A requested video with no row is left out of `rows`; collectChannel reads that as no views
 * that week. Self-contained like the other page functions. Standalone use:
 *   await collectFirstWeeksInPage('UC…', { windows: [{ startDateId: 20261001, endDateId: 20261008, videoIds: ['…'] }] })
 */
export async function collectFirstWeeksInPage(
  channelId: string,
  config: { windows: Array<{ startDateId: number; endDateId: number; videoIds: string[] }> },
): Promise<any> {
  const ORIGIN = 'https://studio.youtube.com';
  const ENDPOINT = 'https://studio.youtube.com/youtubei/v1/yta_web/join?alt=json';
  const PAGE = 10000;

  const fail = (code: string, message: string, extra?: any): any => Object.assign({ ok: false, code, message }, extra || {});

  try {
    const windows = config && Array.isArray(config.windows) ? config.windows : null;
    if (!windows) return fail('INJECTION_EXCEPTION', 'collectFirstWeeksInPage needs config.windows.');

    // ---- auth + context, as collectStudioAnalyticsInPage ----
    const readCookie = (name: string): string | null => {
      const jar = document.cookie ? document.cookie.split('; ') : [];
      for (const pair of jar) {
        const eq = pair.indexOf('=');
        const key = eq === -1 ? pair : pair.slice(0, eq);
        if (key === name) return eq === -1 ? '' : decodeURIComponent(pair.slice(eq + 1));
      }
      return null;
    };
    const sapisid = readCookie('SAPISID') || readCookie('__Secure-3PAPISID');
    if (!sapisid) return fail('NO_SAPISID', 'SAPISID cookie is not present on studio.youtube.com — the user is not signed in.');
    const sha1Hex = async (input: string): Promise<string> => {
      const bytes = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input)));
      let hex = '';
      for (const b of bytes) hex += b.toString(16).padStart(2, '0');
      return hex;
    };
    const ts = Math.floor(Date.now() / 1000);
    const authorization = 'SAPISIDHASH ' + ts + '_' + (await sha1Hex(ts + ' ' + sapisid + ' ' + ORIGIN));
    const cfg = (window as any).ytcfg;
    if (!cfg || typeof cfg.get !== 'function') return fail('YTCFG_MISSING', 'window.ytcfg is not available — not a loaded Studio page.');
    const innertube = cfg.get('INNERTUBE_CONTEXT');
    const clientVersion = innertube && innertube.client && innertube.client.clientVersion;
    if (!clientVersion) return fail('YTCFG_MISSING', 'ytcfg INNERTUBE_CONTEXT.client.clientVersion is missing.');
    const activeChannel = cfg.get('CHANNEL_ID');
    if (activeChannel !== channelId) return fail('CHANNEL_MISMATCH', 'ytcfg CHANNEL_ID (' + activeChannel + ') does not match requested channel (' + channelId + ').');
    const delegation = cfg.get('INNERTUBE_CONTEXT_SERIALIZED_DELEGATION_CONTEXT');
    if (!delegation) return fail('NO_DELEGATION', 'ytcfg INNERTUBE_CONTEXT_SERIALIZED_DELEGATION_CONTEXT is missing — tab is not a signed-in channel context.');
    const authUser = (cfg.get('SESSION_INDEX') != null) ? String(cfg.get('SESSION_INDEX')) : '0';
    const visitorData = (innertube.client && innertube.client.visitorData) || null;
    const context = {
      client: { clientName: 62, clientVersion: clientVersion },
      user: { serializedDelegationContext: delegation },
    };

    const toNum = (v: any): number | null => {
      if (typeof v === 'number') return Number.isFinite(v) ? v : null;
      if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
      return null;
    };

    const out: any[] = [];
    for (const w of windows) {
      const label = 'first week from ' + w.startDateId;
      const body = {
        context,
        nodes: [{
          key: 'TABLE_QUERY',
          value: {
            query: {
              dimensions: [{ type: 'VIDEO' }],
              metrics: [
                { type: 'EXTERNAL_VIEWS' }, { type: 'ENGAGED_VIEWS' }, { type: 'EXTERNAL_WATCH_TIME' },
                { type: 'VIDEO_THUMBNAIL_IMPRESSIONS' }, { type: 'VIDEO_THUMBNAIL_IMPRESSIONS_VTR' },
                { type: 'AVERAGE_WATCH_PERCENTAGE' },
              ],
              restricts: [{ dimension: { type: 'USER' }, inValues: [channelId] }],
              orders: [{ metric: { type: 'EXTERNAL_VIEWS' }, direction: 'ANALYTICS_ORDER_DIRECTION_DESC' }],
              timeRange: { dateIdRange: { inclusiveStart: w.startDateId, exclusiveEnd: w.endDateId } },
              limit: { pageSize: PAGE, pageOffset: 0 },
              currency: 'USD',
              returnDataInNewFormat: true,
              limitedToBatchedData: false,
            },
          },
        }],
      };
      let resp: Response;
      try {
        resp = await fetch(ENDPOINT, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': authorization,
            'X-Origin': ORIGIN,
            'X-Goog-AuthUser': authUser,
            'X-YouTube-Delegation-Context': delegation,
            'X-YouTube-Client-Name': '62',
            'X-YouTube-Client-Version': clientVersion,
            ...(visitorData ? { 'X-Goog-Visitor-Id': visitorData } : {}),
          },
          body: JSON.stringify(body),
        });
      } catch (netErr: any) {
        return fail('NETWORK', 'Network error calling the Studio analytics endpoint (' + label + '): ' + (netErr && netErr.message ? netErr.message : String(netErr)));
      }
      if (resp.status === 401 || resp.status === 403) return fail('HTTP_AUTH', 'Studio analytics endpoint returned HTTP ' + resp.status + ' (' + label + ') — auth/delegation rejected.', { status: resp.status });
      if (resp.status === 429) return fail('HTTP_RATELIMIT', 'Studio analytics endpoint returned HTTP 429 (' + label + ') — rate limited.', { status: 429 });
      if (!resp.ok) return fail('HTTP_ERROR', 'Studio analytics endpoint returned HTTP ' + resp.status + ' (' + label + ').', { status: resp.status });
      let data: any;
      try { data = await resp.json(); } catch { return fail('BAD_JSON', 'Studio analytics response body (' + label + ') was not valid JSON.'); }
      const results = data && data.results;
      if (!Array.isArray(results)) return fail('NO_RESULT_TABLE', 'Response (' + label + ') had no results[] array.');
      const node = results.find((r: any) => r && r.value && r.value.resultTable);
      if (!node) return fail('NO_RESULT_TABLE', 'No results[] entry (' + label + ') carried a resultTable.');
      const table = node.value.resultTable;

      const dimCols: any[] = Array.isArray(table.dimensionColumns) ? table.dimensionColumns : [];
      const videoCol = dimCols.find((c) => c && c.dimension && c.dimension.type === 'VIDEO');
      const ids = videoCol && videoCol.strings && videoCol.strings.values;
      if (!Array.isArray(ids)) return fail('MISSING_COLUMN', 'Dimension column VIDEO.strings.values is absent from the ' + label + ' response.');
      const rowCount = ids.length;
      if (rowCount >= PAGE) return fail('PAGE_CAP', 'First-week query (' + label + ') returned a full page of ' + PAGE + ' rows; offset paging is unsupported.');
      const metricCols: any[] = Array.isArray(table.metricColumns) ? table.metricColumns : [];
      // Named holder; rows in the column's undefinedValueIndices are null (see
      // collectStudioAnalyticsInPage), and a required metric's null fails as MISSING_VALUE.
      const series = (type: string, holder: string): any => {
        const column = metricCols.find((c) => c && c.metric && c.metric.type === type);
        if (!column) return { __err: fail('MISSING_COLUMN', 'Required metric column ' + type + ' is absent from the ' + label + ' response.') };
        const arr = column[holder] && column[holder].values;
        if (!Array.isArray(arr)) return { __err: fail('MISSING_COLUMN', 'Metric column ' + type + ' (' + label + ') has no ' + holder + '.values array.') };
        if (arr.length !== rowCount) return { __err: fail('MISSING_COLUMN', 'Metric column ' + type + ' (' + label + ') length ' + arr.length + ' != row count ' + rowCount + '.') };
        const undef = column.undefinedValueIndices;
        if (undef === undefined) return arr;
        if (!Array.isArray(undef) || undef.some((n: any) => !Number.isInteger(n) || n < 0 || n >= rowCount)) {
          return { __err: fail('MISSING_COLUMN', 'Metric column ' + type + ' (' + label + ') has an unreadable undefinedValueIndices.') };
        }
        const out = arr.slice();
        for (const n of undef) out[n] = null;
        return out;
      };
      const views = series('EXTERNAL_VIEWS', 'counts'); if (views.__err) return views.__err;
      const engaged = series('ENGAGED_VIEWS', 'counts'); if (engaged.__err) return engaged.__err;
      const watch = series('EXTERNAL_WATCH_TIME', 'milliseconds'); if (watch.__err) return watch.__err;
      const imp = series('VIDEO_THUMBNAIL_IMPRESSIONS', 'counts'); if (imp.__err) return imp.__err;
      const vtr = series('VIDEO_THUMBNAIL_IMPRESSIONS_VTR', 'percentages'); if (vtr.__err) return vtr.__err;
      const avg = series('AVERAGE_WATCH_PERCENTAGE', 'percentages'); if (avg.__err) return avg.__err;

      const wanted = new Set(w.videoIds);
      const rows: Record<string, any> = {};
      for (let i = 0; i < rowCount; i++) {
        const videoId = ids[i];
        if (!wanted.has(videoId)) continue;
        if (rows[videoId]) return fail('MISSING_VALUE', 'First-week response (' + label + ') carries video ' + videoId + ' twice.');
        const v = toNum(views[i]);
        const e = toNum(engaged[i]);
        const ms = toNum(watch[i]);
        if (v === null || e === null || ms === null) {
          return fail('MISSING_VALUE', 'Video ' + videoId + ' (' + label + ') is missing a numeric views/engaged-views/watch-time value.');
        }
        rows[videoId] = {
          views: v, engagedViews: e, watchHours: ms / 3600000,
          impressions: toNum(imp[i]), impressionsCtr: toNum(vtr[i]), avgPctViewed: toNum(avg[i]),
        };
      }
      out.push({ startDateId: w.startDateId, rows: rows });
    }
    return { ok: true, windows: out };
  } catch (err: any) {
    return fail('INJECTION_EXCEPTION', 'Unexpected error in the injected first-week collector: ' + (err && err.message ? err.message : String(err)));
  }
}
