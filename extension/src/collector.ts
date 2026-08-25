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
// TODO(v1-metadata) — VideoRecords are DEFERRED, and here is exactly why + how:
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

import type { Snapshot, VideoRecord } from './types';
import {
  fetchCatalogueInPage,
  fetchExperimentsInPage,
  toVideoRecords,
  type AbTestRecord,
  type CatalogueVideo,
} from './catalogue';
import { getChannelVideoState, recordSnapshotTimes } from './collection-state';

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
const CONTEXT_POLL_MS = 1_000;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
// Half of the ~6h SW cycle: lets a daily/weekly/monthly boundary fire on the
// NEAREST cycle rather than the one strictly after the interval elapses.
const CADENCE_SKEW_MS = 3 * HOUR_MS;

// ============================================================================
// Public entry point — called once per channel by the background cycle
// ============================================================================

export async function collectChannel(channelId: string): Promise<ChannelCollectionResult> {
  const tabId = await ensureStudioTabForChannel(channelId);
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

  // Cadence tiering (SW-side, where the last-capture state lives): keep only the
  // snapshots whose video is due this cycle. First-ever run per channel = every
  // video is due (backfill). See tierIntervalMs/isDue.
  const nowMs = Date.now();
  const prior = await getChannelVideoState(channelId);
  const dueSnapshots = injected.snapshots.filter((s) => isDue(s.videoAgeHours, prior[s.videoId], nowMs));

  // Emit VideoRecords only for videos we have not seen before (upsert-new). These now
  // come from the catalogue rather than the analytics response, so they carry real
  // publish dates; anything still unpublished is dropped by toVideoRecords rather than
  // being given an invented date.
  const known = new Set(Object.keys(prior));
  const newVideos = toVideoRecords(catalogue, channelId).filter((v) => !known.has(v.videoId));

  // Mark the emitted snapshots' capture time so cadence can skip them next cycle.
  await recordSnapshotTimes(channelId, dueSnapshots.map((s) => ({ videoId: s.videoId, capturedAt: s.capturedAt })));

  return { videos: newVideos, snapshots: dueSnapshots, abTests };
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

async function ensureStudioTabForChannel(channelId: string): Promise<number> {
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

    const rows: Array<{ videoId: string; impressions: number | null; impressionsCtr: number | null; views: number; watchHours: number; avgPctViewed: number | null }> = [];

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

      // Match a required metric column by .metric.type (never by index) and
      // return its parallel numeric array. Returns { __err } on any shape break.
      const seriesOf = (metricType: string, kinds: string[]): any => {
        const column = metricCols.find((c) => c && c.metric && c.metric.type === metricType);
        if (!column) return { __err: fail('MISSING_COLUMN', 'Required metric column ' + metricType + ' is absent from the response.') };
        for (const kind of kinds) {
          const holder = column[kind];
          const arr = holder && holder.values;
          if (Array.isArray(arr)) {
            if (arr.length !== rowCount) return { __err: fail('MISSING_COLUMN', 'Metric column ' + metricType + ' length ' + arr.length + ' != row count ' + rowCount + '.') };
            return arr;
          }
        }
        return { __err: fail('MISSING_COLUMN', 'Metric column ' + metricType + ' has none of the expected value arrays (' + kinds.join('/') + ').') };
      };

      const impArr = seriesOf('VIDEO_THUMBNAIL_IMPRESSIONS', ['counts']);
      if (impArr && impArr.__err) return impArr.__err;
      const vtrArr = seriesOf('VIDEO_THUMBNAIL_IMPRESSIONS_VTR', ['percentages']);
      if (vtrArr && vtrArr.__err) return vtrArr.__err;
      const viewsArr = seriesOf('EXTERNAL_VIEWS', ['counts']);
      if (viewsArr && viewsArr.__err) return viewsArr.__err;
      const watchArr = seriesOf('EXTERNAL_WATCH_TIME', ['milliseconds']);
      if (watchArr && watchArr.__err) return watchArr.__err;
      const avgArr = seriesOf('AVERAGE_WATCH_PERCENTAGE', ['percentages']);
      if (avgArr && avgArr.__err) return avgArr.__err;

      for (let i = 0; i < rowCount; i++) {
        const videoId = ids[i];
        if (typeof videoId !== 'string' || videoId.length === 0) return fail('MISSING_COLUMN', 'videoId at row ' + i + ' is not a non-empty string.');
        const views = toNum(viewsArr[i]);
        // EXTERNAL_WATCH_TIME comes back in MILLISECONDS (holder `milliseconds`) —
        // verified live against Studio 2026-07-22; convert to hours for the Snapshot.
        const watchMs = toNum(watchArr[i]);
        if (views === null || watchMs === null) {
          return fail('MISSING_VALUE', 'Row ' + i + ' (video ' + videoId + ') is missing a required numeric views/watch-time value.');
        }
        const watchHours = watchMs / 3600000;
        rows.push({
          videoId: videoId,
          impressions: toNum(impArr[i]),
          impressionsCtr: toNum(vtrArr[i]),
          views: views,
          watchHours: watchHours,
          avgPctViewed: toNum(avgArr[i]),
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
      schemaVersion: 1,
      videoId: r.videoId,
      channelId: channelId,
      capturedAt: capturedAt,
      source: 'studio-extension',
      // -1 = publishedAt unknown in v1 (VideoRecord metadata deferred). The store
      // accepts any finite number and its firstWeek cohort (168h +/-48h) excludes
      // -1, so this sentinel never pollutes age-matched math. See TODO(v1-metadata).
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
      subsGained: null,     // owned by the analytics-API collector in v1
      likes: null,
      comments: null,
      shares: null,
    }));

    // VideoRecords are DEFERRED in v1 (see the module header TODO(v1-metadata)).
    const videos: any[] = [];

    return { ok: true, videos: videos, snapshots: snapshots };
  } catch (err: any) {
    return fail('INJECTION_EXCEPTION', 'Unexpected error in the injected collector: ' + (err && err.message ? err.message : String(err)));
  }
}
