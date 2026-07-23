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

  // Cadence tiering (SW-side, where the last-capture state lives): keep only the
  // snapshots whose video is due this cycle. First-ever run per channel = every
  // video is due (backfill). See tierIntervalMs/isDue.
  const nowMs = Date.now();
  const prior = await getChannelVideoState(channelId);
  const dueSnapshots = injected.snapshots.filter((s) => isDue(s.videoAgeHours, prior[s.videoId], nowMs));

  // Emit VideoRecords only for videos we have not seen before (upsert-new). In
  // v1 injected.videos is [] (see TODO(v1-metadata)), so this is [] too.
  const known = new Set(Object.keys(prior));
  const newVideos = injected.videos.filter((v) => !known.has(v.videoId));

  // Mark the emitted snapshots' capture time so cadence can skip them next cycle.
  await recordSnapshotTimes(channelId, dueSnapshots.map((s) => ({ videoId: s.videoId, capturedAt: s.capturedAt })));

  return { videos: newVideos, snapshots: dueSnapshots };
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
// Managed tab: create/reuse ONE background tab, navigate it per channel
// ============================================================================

interface StudioContext { ready: boolean; channelId: string | null; hasDelegation: boolean }

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

async function waitForChannelContext(tabId: number, channelId: string): Promise<void> {
  const deadline = Date.now() + CONTEXT_TIMEOUT_MS;
  let last: StudioContext | null = null;

  while (Date.now() < deadline) {
    await sleep(CONTEXT_POLL_MS);
    let ctx: StudioContext | null = null;
    try {
      const results = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: readStudioContext });
      const first = results[0];
      ctx = first && first.result ? (first.result as StudioContext) : null;
    } catch {
      ctx = null; // frame mid-navigation / not yet injectable — keep polling
    }
    if (ctx) {
      last = ctx;
      if (ctx.channelId === channelId && ctx.hasDelegation) return;
    }
  }

  throw new StudioChannelUnavailableError(
    channelId,
    last ? `loaded context CHANNEL_ID=${last.channelId ?? 'none'}, delegation ${last.hasDelegation ? 'present' : 'absent'}` : 'window.ytcfg never became available',
  );
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

/** Probe: what channel context is currently loaded in this tab? */
function readStudioContext(): { ready: boolean; channelId: string | null; hasDelegation: boolean } {
  try {
    const cfg = (window as any).ytcfg;
    if (!cfg || typeof cfg.get !== 'function') return { ready: false, channelId: null, hasDelegation: false };
    const channelId = cfg.get('CHANNEL_ID') || null;
    const delegation = cfg.get('INNERTUBE_CONTEXT_SERIALIZED_DELEGATION_CONTEXT') || null;
    return { ready: !!channelId, channelId, hasDelegation: !!delegation };
  } catch {
    return { ready: false, channelId: null, hasDelegation: false };
  }
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
