/**
 * YouTube A/B Title Test Exporter — orchestrator.
 *
 * Drives ONE tab through YouTube Studio, reading A/B title-test results for videos on
 * the signed-in user's own channel, and writes them to a CSV download.
 *
 * Nothing is uploaded. The CSV lands in the normal Downloads folder and the user
 * decides what to do with it.
 *
 * Why it works this way: YouTube exposes no API for A/B tests — not in the Data API,
 * not in the Analytics API — so the results are only readable from Studio itself. The
 * report data ships with the video's details page, so each tested video needs one page
 * visit. Only videos the list marks as tested are visited, so a channel with thousands
 * of uploads still only costs a handful of loads.
 *
 * All the DOM work happens in injected functions (see scrapers below). They are
 * serialized deliberately — one video at a time, with pauses — because this is someone's
 * own account and hammering Studio helps nobody.
 */

/**
 * URLs are built from the tab the user already has open, NOT from a pasted channel id.
 *
 * Studio resolves a /channel/<id>/ URL against the CURRENTLY ACTIVE Google account. If
 * the signed-in default isn't the account that owns that channel — which is normal for
 * brand accounts, where several channels sit under one login — you get
 * "you don't have permission to view this page" even though the channel is yours.
 *
 * Reusing the open tab's own URL sidesteps that completely: whatever channel and account
 * the user is already looking at is the one that gets scanned. Any `authuser` /
 * `pageId` parameters are carried across every subsequent navigation to keep the same
 * account context.
 */
function accountParams(sourceUrl) {
  const params = new URLSearchParams();
  try {
    const from = new URL(sourceUrl).searchParams;
    for (const key of ['authuser', 'pageId']) {
      const value = from.get(key);
      if (value) params.set(key, value);
    }
  } catch {
    /* not a parseable URL — no account params to carry */
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

const LIST_URL = (channelId, sourceUrl) =>
  `https://studio.youtube.com/channel/${channelId}/videos/upload${accountParams(sourceUrl)}`;

const EDIT_URL = (videoId, sourceUrl) =>
  `https://studio.youtube.com/video/${videoId}/edit${accountParams(sourceUrl)}`;

/** Pull the channel id out of any Studio URL. */
function channelIdFromUrl(url) {
  return (url || '').match(/\/channel\/(UC[\w-]+)/)?.[1] ?? null;
}

/**
 * Pause between video page loads, randomized.
 *
 * The jitter matters more than the average: a perfectly regular interval sustained over
 * dozens of page loads is a far cleaner automation signal than the request rate itself.
 * This also roughly halves the rate versus a fixed short delay.
 */
const DELAY_MIN_MS = 2000;
const DELAY_MAX_MS = 5000;

/**
 * Recycle the working tab every N videos.
 *
 * YouTube Studio is a heavy Polymer app, and Chrome REUSES the same renderer process for
 * successive same-origin navigations. Driving 200+ video pages through one tab therefore
 * grows a single renderer's heap monotonically — it is only reclaimed when the tab
 * closes. On a long unattended run that is the entire memory problem; the scan's own data
 * is about 1 MB.
 *
 * Closing and reopening the tab periodically forces the renderer to be torn down and its
 * memory returned, which keeps a full-channel scan flat instead of ever-growing.
 */
const RECYCLE_EVERY_N_VIDEOS = 20;
const jitteredDelay = () =>
  DELAY_MIN_MS + Math.floor(Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS));

const state = {
  running: false,
  /** Tab being driven, so the on-page overlay can be addressed directly. */
  workingTabId: null,
  channelId: null,
  /** The tab WE created and are responsible for closing. Never the user's own tab. */
  ownedTabId: null,
  queueIndex: 0,
  queueTotal: 0,
  cancelled: false,
  phase: 'idle',
  message: '',
  scanned: 0,
  total: 0,
  found: 0,
  rows: [],
  error: null,
};

function setState(patch) {
  Object.assign(state, patch);
  const payload = { type: 'progress', state: publicState() };
  // Popup may be closed; ignore the "no receiver" rejection.
  chrome.runtime.sendMessage(payload).catch(() => {});
  // The on-page overlay lives in the tab being driven, and runtime.sendMessage does not
  // reach content scripts — it needs an explicit tabs.sendMessage.
  if (state.workingTabId) {
    chrome.tabs.sendMessage(state.workingTabId, payload).catch(() => {});
  }
}

function publicState() {
  const { rows, ...rest } = state;
  return {
    ...rest,
    rowCount: rows.length,
    queueLabel: state.queueTotal > 1 ? `Channel ${state.queueIndex} of ${state.queueTotal}` : '',
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- persistence
//
// MV3 service workers are killed after ~30s idle, taking every in-memory variable with
// them. Holding a finished run only in memory meant the results silently evaporated
// shortly after the scan ended — the popup still showed the last message it had
// received, so it LOOKED complete while the data was already gone.
//
// Rows are therefore written to chrome.storage.local as they are collected, and restored
// on worker start-up. unlimitedStorage is requested because a full channel is a few MB.

const STORE_KEY = 'runState';
let persistQueue = Promise.resolve();

function persist() {
  const snapshot = {
    rows: state.rows,
    phase: state.phase,
    message: state.message,
    scanned: state.scanned,
    total: state.total,
    found: state.found,
    channelId: state.channelId,
    savedAt: Date.now(),
  };
  persistQueue = persistQueue
    .then(() => chrome.storage.local.set({ [STORE_KEY]: snapshot }))
    .catch((err) => console.error('[exporter] persist failed', err));
  return persistQueue;
}

let restorePromise = null;

/** Rehydrate after a worker restart. Every message handler awaits this first. */
function ensureRestored() {
  if (!restorePromise) {
    restorePromise = chrome.storage.local
      .get(STORE_KEY)
      .then(({ [STORE_KEY]: stored }) => {
        // Never clobber a run that is actually in progress in this worker.
        if (!stored || state.running || state.rows.length) return;
        state.rows = Array.isArray(stored.rows) ? stored.rows : [];
        state.phase = stored.phase || 'idle';
        state.message = stored.message || '';
        state.scanned = stored.scanned || 0;
        state.total = stored.total || 0;
        state.found = stored.found || 0;
        state.channelId = stored.channelId || null;
      })
      .catch((err) => console.error('[exporter] restore failed', err));
  }
  return restorePromise;
}

/**
 * Keep the worker alive for the duration of a run.
 *
 * The scan's own chrome.* calls mostly reset the idle timer, but the gaps between videos
 * are long enough to be risky, and a worker death mid-run would strand the scan.
 */
function setKeepalive(on) {
  // Guarded: an undeclared or unavailable API must never take the whole worker down.
  // Touching chrome.alarms at top level without the "alarms" permission throws during
  // service-worker registration and bricks the entire extension.
  if (!chrome.alarms) return;
  try {
    if (on) chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
    else chrome.alarms.clear('keepalive');
  } catch (err) {
    console.warn('[exporter] keepalive unavailable', err);
  }
}

if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener(() => {
    // Exists purely to wake the worker; touching state is enough.
    void state.running;
  });
}

/** Badge so a finished run is visible even with every window closed. */
function setBadge(text, color = '#ff6b35') {
  if (!chrome.action?.setBadgeText) return;
  chrome.action.setBadgeText({ text: text || '' }).catch(() => {});
  if (text) chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
}

// ---------------------------------------------------------------- injected scrapers
// These run in the page. They must be self-contained — no closures over anything here.

/**
 * Enumerate every video in the Studio content list, ACROSS ALL PAGES.
 *
 * The list is paginated (30 per page by default) — not infinite-scroll — so it must be
 * walked with the pager. The footer reads "1–30 of about 776"; that string changing is
 * the reliable signal that a page turn actually completed, since the row elements are
 * recycled rather than replaced.
 *
 * Deduplicates by videoId: pages can overlap if the list re-sorts mid-walk, and a video
 * counted twice would produce duplicate CSV rows.
 *
 * Returns the A/B label when present ("A/B Test running" / "A/B Test completed"), which
 * is how we decide which videos are worth opening at all.
 */
async function scrapeVideoList(emptyPageStreakLimit) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- persistence
//
// MV3 service workers are killed after ~30s idle, taking every in-memory variable with
// them. Holding a finished run only in memory meant the results silently evaporated
// shortly after the scan ended — the popup still showed the last message it had
// received, so it LOOKED complete while the data was already gone.
//
// Rows are therefore written to chrome.storage.local as they are collected, and restored
// on worker start-up. unlimitedStorage is requested because a full channel is a few MB.

const STORE_KEY = 'runState';
let persistQueue = Promise.resolve();

function persist() {
  const snapshot = {
    rows: state.rows,
    phase: state.phase,
    message: state.message,
    scanned: state.scanned,
    total: state.total,
    found: state.found,
    channelId: state.channelId,
    savedAt: Date.now(),
  };
  persistQueue = persistQueue
    .then(() => chrome.storage.local.set({ [STORE_KEY]: snapshot }))
    .catch((err) => console.error('[exporter] persist failed', err));
  return persistQueue;
}

let restorePromise = null;

/** Rehydrate after a worker restart. Every message handler awaits this first. */
function ensureRestored() {
  if (!restorePromise) {
    restorePromise = chrome.storage.local
      .get(STORE_KEY)
      .then(({ [STORE_KEY]: stored }) => {
        // Never clobber a run that is actually in progress in this worker.
        if (!stored || state.running || state.rows.length) return;
        state.rows = Array.isArray(stored.rows) ? stored.rows : [];
        state.phase = stored.phase || 'idle';
        state.message = stored.message || '';
        state.scanned = stored.scanned || 0;
        state.total = stored.total || 0;
        state.found = stored.found || 0;
        state.channelId = stored.channelId || null;
      })
      .catch((err) => console.error('[exporter] restore failed', err));
  }
  return restorePromise;
}

/**
 * Keep the worker alive for the duration of a run.
 *
 * The scan's own chrome.* calls mostly reset the idle timer, but the gaps between videos
 * are long enough to be risky, and a worker death mid-run would strand the scan.
 */
function setKeepalive(on) {
  // Guarded: an undeclared or unavailable API must never take the whole worker down.
  // Touching chrome.alarms at top level without the "alarms" permission throws during
  // service-worker registration and bricks the entire extension.
  if (!chrome.alarms) return;
  try {
    if (on) chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
    else chrome.alarms.clear('keepalive');
  } catch (err) {
    console.warn('[exporter] keepalive unavailable', err);
  }
}

if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener(() => {
    // Exists purely to wake the worker; touching state is enough.
    void state.running;
  });
}

/** Badge so a finished run is visible even with every window closed. */
function setBadge(text, color = '#ff6b35') {
  if (!chrome.action?.setBadgeText) return;
  chrome.action.setBadgeText({ text: text || '' }).catch(() => {});
  if (text) chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
}

  const footerText = () =>
    document.querySelector('ytcp-table-footer')?.innerText?.trim() || '';

  const collectPage = (into) => {
    for (const row of document.querySelectorAll('ytcp-video-row')) {
      const href = row.querySelector('a[href*="/video/"]')?.getAttribute('href') || '';
      const videoId = href.match(/\/video\/([^/]+)/)?.[1] || null;
      if (!videoId || into.has(videoId)) continue;

      const lines = (row.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
      const abLabel = lines.find((l) => /a\/b test/i.test(l)) || null;

      // Title = first line that isn't a duration, a bare number, or the A/B label.
      // Duration badges sort first in this component.
      const title =
        lines.find(
          (l) =>
            !/^\d+:\d+/.test(l) &&
            !/a\/b test/i.test(l) &&
            !/^[\d,.%]+$/.test(l) &&
            l.length > 3,
        ) || null;

      into.set(videoId, { videoId, title, abLabel });
    }
  };

  const byId = new Map();
  let pagesWalked = 0;
  let emptyStreak = 0;
  let stoppedEarly = false;

  // Hard page cap: generous enough for a very large channel, bounded so a pager that
  // never disables can't spin forever.
  for (let page = 0; page < 600; page++) {
    // Wait for rows to be present on this page.
    for (let i = 0; i < 40; i++) {
      if (document.querySelectorAll('ytcp-video-row').length) break;
      await sleep(300);
    }

    const beforeCount = [...byId.values()].filter((v) => v.abLabel).length;
    collectPage(byId);
    pagesWalked++;
    const foundHere = [...byId.values()].filter((v) => v.abLabel).length - beforeCount;

    // A/B testing is recent and the list is date-descending, so tested videos cluster at
    // the top. Once several consecutive pages have none, the rest of the back catalogue
    // is almost certainly barren — stop rather than paging through years of uploads.
    // Reported explicitly so an early stop is never mistaken for a complete scan.
    if (emptyPageStreakLimit > 0) {
      emptyStreak = foundHere === 0 ? emptyStreak + 1 : 0;
      if (emptyStreak >= emptyPageStreakLimit) {
        stoppedEarly = true;
        break;
      }
    }

    const next = document.querySelector('ytcp-icon-button#navigate-after');
    const done =
      !next || next.hasAttribute('disabled') || next.getAttribute('aria-disabled') === 'true';
    if (done) break;

    const before = footerText();
    next.click();

    // A page turn is confirmed by the footer range changing, not by a timer.
    let turned = false;
    for (let i = 0; i < 50; i++) {
      await sleep(300);
      if (footerText() !== before) {
        turned = true;
        break;
      }
    }
    if (!turned) break; // pager stopped responding — return what we have rather than looping
    await sleep(400);
  }

  return { videos: [...byId.values()], footer: footerText(), pagesWalked, stoppedEarly };
}

/**
 * Lifetime per-video analytics for the whole channel, in ONE request.
 *
 * Uses Studio's own internal analytics endpoint rather than scraping the analytics UI —
 * impressions and impressions-CTR are not available in the public YouTube Analytics API
 * at all, and this returns every video on the channel in a single call instead of one
 * page load each.
 *
 * MUST run in the MAIN world: it needs window.ytcfg and the SAPISID cookie, neither of
 * which an isolated content script can reach.
 *
 * Hard-won details, all verified live — do not "simplify" these away:
 *  - Auth is SAPISIDHASH: sha1(`${ts} ${SAPISID} ${origin}`), plus credentials:'include'.
 *  - Brand (non-primary) channels 403 unless the delegation context is sent as the
 *    X-YouTube-Delegation-Context HEADER *and* X-Goog-AuthUser — not just in the body.
 *    The primary channel works without them, which makes this fail confusingly.
 *  - Metric columns must be matched by `.metric.type`, NEVER by index.
 *  - EXTERNAL_WATCH_TIME arrives under a `milliseconds` holder, not `counts`.
 *  - pageOffset > 0 returns HTTP 400 — offset paging is unsupported. One big pageSize is
 *    the only option, so a full page means the catalogue may exceed one request and we
 *    fail loudly rather than silently truncating.
 */
async function fetchLifetimeAnalytics(channelId) {
  const ORIGIN = 'https://studio.youtube.com';
  const ENDPOINT = 'https://studio.youtube.com/youtubei/v1/yta_web/join?alt=json';
  const PAGE = 10000;

  const fail = (code, message) => ({ ok: false, code, message });

  try {
    const readCookie = (name) => {
      for (const pair of (document.cookie ? document.cookie.split('; ') : [])) {
        const eq = pair.indexOf('=');
        const key = eq === -1 ? pair : pair.slice(0, eq);
        if (key === name) return eq === -1 ? '' : decodeURIComponent(pair.slice(eq + 1));
      }
      return null;
    };
    const sapisid = readCookie('SAPISID') || readCookie('__Secure-3PAPISID');
    if (!sapisid) return fail('NO_SAPISID', 'Not signed in to YouTube Studio (no SAPISID cookie).');

    const sha1Hex = async (input) => {
      const bytes = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input)));
      let hex = '';
      for (const b of bytes) hex += b.toString(16).padStart(2, '0');
      return hex;
    };
    const ts = Math.floor(Date.now() / 1000);
    const authorization = `SAPISIDHASH ${ts}_${await sha1Hex(`${ts} ${sapisid} ${ORIGIN}`)}`;

    const cfg = window.ytcfg;
    if (!cfg || typeof cfg.get !== 'function') return fail('YTCFG_MISSING', 'Studio page not fully loaded.');
    const innertube = cfg.get('INNERTUBE_CONTEXT');
    const clientVersion = innertube?.client?.clientVersion;
    if (!clientVersion) return fail('YTCFG_MISSING', 'Studio client version unavailable.');

    const activeChannel = cfg.get('CHANNEL_ID');
    if (activeChannel !== channelId) {
      return fail('CHANNEL_MISMATCH', `Studio is on channel ${activeChannel}, not ${channelId}.`);
    }
    const delegation = cfg.get('INNERTUBE_CONTEXT_SERIALIZED_DELEGATION_CONTEXT');
    if (!delegation) return fail('NO_DELEGATION', 'Studio delegation context missing — reload the page.');
    const authUser = cfg.get('SESSION_INDEX') != null ? String(cfg.get('SESSION_INDEX')) : '0';
    const visitorData = innertube?.client?.visitorData || null;

    // All-time window: 2008-01-01 .. tomorrow (exclusive), in the page's local timezone.
    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const exclusiveEnd =
      tomorrow.getFullYear() * 10000 + (tomorrow.getMonth() + 1) * 100 + tomorrow.getDate();

    const body = {
      context: {
        client: { clientName: 62, clientVersion },
        user: { serializedDelegationContext: delegation },
      },
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
            timeRange: { dateIdRange: { inclusiveStart: 20080101, exclusiveEnd } },
            limit: { pageSize: PAGE, pageOffset: 0 },
            currency: 'USD',
            returnDataInNewFormat: true,
            limitedToBatchedData: false,
          },
        },
      }],
    };

    let resp;
    try {
      resp = await fetch(ENDPOINT, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authorization,
          'X-Origin': ORIGIN,
          'X-Goog-AuthUser': authUser,
          'X-YouTube-Delegation-Context': delegation,
          'X-YouTube-Client-Name': '62',
          'X-YouTube-Client-Version': clientVersion,
          ...(visitorData ? { 'X-Goog-Visitor-Id': visitorData } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (netErr) {
      return fail('NETWORK', `Network error: ${netErr?.message || String(netErr)}`);
    }

    if (resp.status === 401 || resp.status === 403) return fail('HTTP_AUTH', `Analytics rejected (HTTP ${resp.status}).`);
    if (resp.status === 429) return fail('HTTP_RATELIMIT', 'Analytics rate limited (HTTP 429).');
    if (!resp.ok) return fail('HTTP_ERROR', `Analytics returned HTTP ${resp.status}.`);

    let data;
    try { data = await resp.json(); } catch { return fail('BAD_JSON', 'Analytics response was not JSON.'); }

    const node = Array.isArray(data?.results) && data.results.find((r) => r?.value?.resultTable);
    if (!node) return fail('NO_RESULT_TABLE', 'Analytics response had no result table.');
    const table = node.value.resultTable;

    const ids = table?.dimensionColumns?.[0]?.strings?.values;
    if (!Array.isArray(ids)) return fail('MISSING_COLUMN', 'Analytics response had no videoId column.');
    const rowCount = ids.length;
    const metricCols = Array.isArray(table.metricColumns) ? table.metricColumns : [];

    // Match by metric type, never by index — column order is not guaranteed.
    const seriesOf = (metricType, kinds) => {
      const column = metricCols.find((c) => c?.metric?.type === metricType);
      if (!column) return null;
      for (const kind of kinds) {
        const arr = column[kind]?.values;
        if (Array.isArray(arr) && arr.length === rowCount) return arr;
      }
      return null;
    };

    const impressions = seriesOf('VIDEO_THUMBNAIL_IMPRESSIONS', ['counts']);
    const ctr = seriesOf('VIDEO_THUMBNAIL_IMPRESSIONS_VTR', ['percentages']);
    const views = seriesOf('EXTERNAL_VIEWS', ['counts']);
    const watchMs = seriesOf('EXTERNAL_WATCH_TIME', ['milliseconds']);
    const avgPct = seriesOf('AVERAGE_WATCH_PERCENTAGE', ['percentages']);
    if (!views || !watchMs) return fail('MISSING_COLUMN', 'Analytics response was missing views or watch time.');

    const toNum = (v) => {
      if (typeof v === 'number') return Number.isFinite(v) ? v : null;
      if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
      return null;
    };

    const rows = [];
    for (let i = 0; i < rowCount; i++) {
      const videoId = ids[i];
      if (typeof videoId !== 'string' || !videoId) continue;
      const ms = toNum(watchMs[i]);
      rows.push({
        videoId,
        impressions: impressions ? toNum(impressions[i]) : null,
        impressionsCtrPct: ctr ? toNum(ctr[i]) : null,
        views: toNum(views[i]),
        // EXTERNAL_WATCH_TIME is milliseconds, not seconds — verified live.
        watchHours: ms === null ? null : ms / 3600000,
        avgPctViewed: avgPct ? toNum(avgPct[i]) : null,
      });
    }

    // Offset paging is unsupported, so a completely full page means the catalogue may
    // exceed one request. Say so rather than silently dropping the overflow.
    const truncated = rowCount >= PAGE;
    return { ok: true, rows, truncated };
  } catch (err) {
    return fail('EXCEPTION', `Unexpected error: ${err?.message || String(err)}`);
  }
}

/**
 * Open the A/B test report on a video details page and parse it.
 *
 * Returns { status, variants[], ranFrom, ranTo } or { status: 'none' } when the video
 * has no test. Never throws for "no test" — that's an expected outcome, not an error.
 */
async function scrapeReport() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- persistence
//
// MV3 service workers are killed after ~30s idle, taking every in-memory variable with
// them. Holding a finished run only in memory meant the results silently evaporated
// shortly after the scan ended — the popup still showed the last message it had
// received, so it LOOKED complete while the data was already gone.
//
// Rows are therefore written to chrome.storage.local as they are collected, and restored
// on worker start-up. unlimitedStorage is requested because a full channel is a few MB.

const STORE_KEY = 'runState';
let persistQueue = Promise.resolve();

function persist() {
  const snapshot = {
    rows: state.rows,
    phase: state.phase,
    message: state.message,
    scanned: state.scanned,
    total: state.total,
    found: state.found,
    channelId: state.channelId,
    savedAt: Date.now(),
  };
  persistQueue = persistQueue
    .then(() => chrome.storage.local.set({ [STORE_KEY]: snapshot }))
    .catch((err) => console.error('[exporter] persist failed', err));
  return persistQueue;
}

let restorePromise = null;

/** Rehydrate after a worker restart. Every message handler awaits this first. */
function ensureRestored() {
  if (!restorePromise) {
    restorePromise = chrome.storage.local
      .get(STORE_KEY)
      .then(({ [STORE_KEY]: stored }) => {
        // Never clobber a run that is actually in progress in this worker.
        if (!stored || state.running || state.rows.length) return;
        state.rows = Array.isArray(stored.rows) ? stored.rows : [];
        state.phase = stored.phase || 'idle';
        state.message = stored.message || '';
        state.scanned = stored.scanned || 0;
        state.total = stored.total || 0;
        state.found = stored.found || 0;
        state.channelId = stored.channelId || null;
      })
      .catch((err) => console.error('[exporter] restore failed', err));
  }
  return restorePromise;
}

/**
 * Keep the worker alive for the duration of a run.
 *
 * The scan's own chrome.* calls mostly reset the idle timer, but the gaps between videos
 * are long enough to be risky, and a worker death mid-run would strand the scan.
 */
function setKeepalive(on) {
  // Guarded: an undeclared or unavailable API must never take the whole worker down.
  // Touching chrome.alarms at top level without the "alarms" permission throws during
  // service-worker registration and bricks the entire extension.
  if (!chrome.alarms) return;
  try {
    if (on) chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
    else chrome.alarms.clear('keepalive');
  } catch (err) {
    console.warn('[exporter] keepalive unavailable', err);
  }
}

if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener(() => {
    // Exists purely to wake the worker; touching state is enough.
    void state.running;
  });
}

/** Badge so a finished run is visible even with every window closed. */
function setBadge(text, color = '#ff6b35') {
  if (!chrome.action?.setBadgeText) return;
  chrome.action.setBadgeText({ text: text || '' }).catch(() => {});
  if (text) chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
}
  const visAll = (sel) =>
    [...document.querySelectorAll(sel)].filter((e) => e.getBoundingClientRect().height > 0);

  // Wait for the details form to exist at all.
  for (let i = 0; i < 40; i++) {
    if (visAll('ytcp-video-metadata-editor, div#textbox').length) break;
    await sleep(300);
  }

  // The A/B section offers "View test report" once results are ready.
  let reportBtn = null;
  for (let i = 0; i < 20; i++) {
    reportBtn = visAll('ytcp-button, button, tp-yt-paper-button').find((b) =>
      /test report/i.test((b.textContent || '').trim()),
    );
    if (reportBtn) break;
    await sleep(300);
  }
  if (!reportBtn) return { status: 'none' };

  reportBtn.click();

  // Wait for the report dialog.
  let dialog = null;
  for (let i = 0; i < 30; i++) {
    dialog = visAll('tp-yt-paper-dialog, ytcp-dialog').find((d) =>
      /a\/b test report/i.test(d.textContent || ''),
    );
    if (dialog) break;
    await sleep(300);
  }
  if (!dialog) return { status: 'report-did-not-open' };

  // Each variant is one .ytcpVideoExperimentResultsDialogExperimentOption block.
  // Fall back to walking up from the thumbnails if Studio renames that class.
  let rowEls = [...dialog.querySelectorAll('div.ytcpVideoExperimentResultsDialogExperimentOption')];
  if (rowEls.length === 0) {
    const seen = new Set();
    for (const thumb of dialog.querySelectorAll('ytcp-thumbnail')) {
      let n = thumb.parentElement;
      for (let i = 0; i < 8 && n; i++, n = n.parentElement) {
        if (/\d+(\.\d+)?%/.test(n.innerText || '')) break;
      }
      if (n && !seen.has(n)) {
        seen.add(n);
        rowEls.push(n);
      }
    }
  }

  const variants = rowEls.map((row, index) => {
    const lines = (row.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const text = row.innerText || '';
    const share = text.match(/(\d+(?:\.\d+)?)%/)?.[1] ?? null;

    // Title = first line that isn't a duration, the channel name line, a percentage,
    // or one of the status/action strings.
    const title =
      lines.find(
        (l) =>
          !/^\d+:\d+/.test(l) &&
          !/%$/.test(l) &&
          !/^watch time share$/i.test(l) &&
          !/^set this option$/i.test(l) &&
          !/^winner$/i.test(l) &&
          !/^now visible to all viewers$/i.test(l) &&
          l.length > 3,
      ) || null;

    return {
      index: index + 1,
      title,
      watchTimeSharePct: share === null ? null : Number(share),
      isWinner: /\bwinner\b/i.test(text),
      isLive: /now visible to all viewers/i.test(text),
    };
  });

  // Footer: "Test finished. Ran from July 23, 2026 at 2:00PM to July 23, 2026 at 8:59PM"
  const dialogText = dialog.innerText || '';
  // Studio ends the sentence with a period, which lands inside the second capture.
  const ran = dialogText.match(/Ran from (.+?) to (.+?)(?:\n|$)/i);
  const trimDate = (s) => (s ? s.trim().replace(/[.\s]+$/, '') : null);
  // The headline is the dialog's own verdict line. Keep the raw text when it isn't one
  // of the phrases we know, so an unrecognised outcome can be diagnosed from the CSV
  // instead of collapsing to a useless "unknown".
  const headlineText = (dialogText.split('\n').map((l) => l.trim()).find(
    (l) => l && !/^a\/b test report$/i.test(l) && !/^title only$/i.test(l) &&
           !/^thumbnail only$/i.test(l) && !/^title and thumbnail$/i.test(l),
  ) || '').slice(0, 80);

  const headline = /we have a winner/i.test(dialogText)
    ? 'winner'
    : /performed the same|performed same|no clear winner|too close/i.test(dialogText)
      ? 'performed-same'
      : /inconclusive/i.test(dialogText)
        ? 'inconclusive'
        : /still (running|in progress)|test in progress|results (are )?not ready/i.test(dialogText)
          ? 'running'
          : `unrecognised: ${headlineText}`;

  // Close the dialog without touching "New test".
  const close =
    dialog.querySelector('ytcp-icon-button#close-button') ||
    [...dialog.querySelectorAll('ytcp-icon-button, button')].find((b) =>
      /close/i.test(b.getAttribute('aria-label') || ''),
    ) ||
    [...dialog.querySelectorAll('ytcp-button')].find((b) => /^done$/i.test((b.textContent || '').trim()));
  if (close) close.click();

  return {
    status: 'ok',
    outcome: headline,
    variants,
    ranFrom: trimDate(ran?.[1]),
    ranTo: trimDate(ran?.[2]),
    headlineText,
  };
}

// ---------------------------------------------------------------- orchestration

async function waitForTabLoad(tabId, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return;
    if (Date.now() > deadline) throw new Error('Timed out loading a Studio page');
    await sleep(400);
  }
}

/**
 * Replace the working tab with a fresh one, releasing the old renderer process.
 *
 * Returns the new tab id, or the original if recycling failed — a failure here should
 * cost memory, never the run.
 */
async function recycleTab(oldTabId) {
  try {
    const fresh = await chrome.tabs.create({ url: 'about:blank', active: true });
    await chrome.tabs.remove(oldTabId).catch(() => {});
    await waitForTabLoad(fresh.id, 15000).catch(() => {});
    return fresh.id;
  } catch (err) {
    console.warn('[exporter] tab recycle failed, continuing on the existing tab', err);
    return oldTabId;
  }
}

/** Close the dedicated working tab, freeing its renderer entirely. */
async function closeTab(tabId) {
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    /* already gone */
  }
}

async function inject(tabId, func, args = [], world = 'ISOLATED') {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func, args, world });
  return result?.result;
}

async function run(sourceTabId, emptyPageStreakLimit) {
  setState({ phase: 'listing', message: 'Loading your video list…', scanned: 0, total: 0, found: 0 });

  // Read the channel and account context from the tab the user pointed us at, but do NOT
  // drive that tab. Two reasons:
  //   1. Hijacking a tab the user is using is rude, and they lose their place.
  //   2. chrome.tabs.update does not focus a tab, so driving a BACKGROUND Studio tab made
  //      the scan invisible — no visible navigation, no overlay — and looked broken while
  //      working perfectly. Anyone with two Studio tabs open could hit this.
  // Instead we open one dedicated, visible working tab and drive that.
  const startTab = await chrome.tabs.get(sourceTabId);
  const sourceUrl = startTab.url || '';
  const channelId = channelIdFromUrl(sourceUrl);
  if (!channelId) {
    throw new Error(
      'That Studio tab is not on a channel page. Open Studio → Content, then try again.',
    );
  }

  state.channelId = channelId;

  // Dedicated working tab, opened ACTIVE so the operator can always see what is happening.
  const workTab = await chrome.tabs.create({
    url: LIST_URL(channelId, sourceUrl),
    active: true,
    index: startTab.index + 1,
    windowId: startTab.windowId,
  });
  let tabId = workTab.id;
  state.workingTabId = tabId;
  state.ownedTabId = tabId;
  await waitForTabLoad(tabId);
  await sleep(3000);

  // Fail clearly on the permission interstitial rather than reporting "no videos".
  const denied = await inject(tabId, () =>
    /don't have permission|do not have permission/i.test(document.body?.innerText || ''),
  );
  if (denied) {
    throw new Error(
      "Studio says you don't have permission for this channel. Switch to the right " +
        'account in Studio, open Content, and run the scan from that tab.',
    );
  }

  // Lifetime analytics first: one request covers the entire channel, so it is both the
  // cheapest step and the one that defines the row set the A/B results are merged into.
  const analyticsById = new Map();
  setState({ message: 'Fetching lifetime analytics for the whole channel…' });
  const analytics = await inject(tabId, fetchLifetimeAnalytics, [channelId], 'MAIN');

  if (analytics?.ok) {
    for (const row of analytics.rows) analyticsById.set(row.videoId, row);
    setState({
      message:
        `Lifetime analytics for ${analytics.rows.length} videos.` +
        // The query sorts by views descending and the endpoint refuses pageOffset > 0,
        // so a full page means we have the TOP 10,000 by views and cannot reach the
        // rest. Say exactly that rather than implying full coverage.
        (analytics.truncated
          ? ' CAPPED: this channel exceeds 10,000 videos, so analytics covers only the top 10,000 by views. A/B results are unaffected.'
          : ''),
    });
  } else {
    // Not fatal: the A/B export is still worth producing without analytics columns.
    setState({
      message: `Analytics unavailable (${analytics?.code || 'unknown'}) — continuing with A/B results only.`,
    });
  }

  setState({ message: 'Reading your video list (this walks every page)…' });
  const listing = await inject(tabId, scrapeVideoList, [emptyPageStreakLimit]);
  const videos = listing?.videos;
  if (!Array.isArray(videos) || videos.length === 0) {
    throw new Error('Could not read the video list. Make sure you are signed in to YouTube Studio.');
  }

  // Resume: anything already exported successfully is skipped. Rows whose outcome was an
  // error are NOT treated as done, so a retry picks them up.
  const alreadyDone = new Set(
    state.rows
      .filter((r) => r.testOutcome && !String(r.testOutcome).startsWith('error'))
      .map((r) => r.videoId),
  );

  // Only videos the list marks as tested are worth opening.
  const allTested = videos.filter((v) => v.abLabel);
  const tested = allTested.filter((v) => !alreadyDone.has(v.videoId));
  const skipped = allTested.length - tested.length;
  setState({
    phase: 'scraping',
    total: tested.length,
    message:
      `${videos.length} videos across ${listing.pagesWalked} page(s), ` +
      `${tested.length} with A/B tests to read` +
      (skipped ? ` (${skipped} already in the resumed CSV).` : '.') +
      // Never let an early stop look like a complete scan.
      (listing.stoppedEarly
        ? ` Stopped early: ${emptyPageStreakLimit} consecutive pages had no tests. Untick "stop early" to scan everything.`
        : ''),
  });

  if (tested.length === 0) {
    setState({ phase: 'done', message: 'No A/B tests found on this channel.' });
    return;
  }

  // A handful of failures is normal; a long unbroken run of them means something
  // systemic (dead tab, sign-out, Studio redesign) and continuing just fills the CSV
  // with noise.
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 8;

  // Every emitted row carries the video's lifetime analytics, so the CSV is a single
  // joined table rather than two that have to be reconciled later.
  const withAnalytics = (base) => {
    const a = analyticsById.get(base.videoId);
    return {
      ...base,
      impressions: a?.impressions ?? '',
      impressionsCtrPct: a?.impressionsCtrPct ?? '',
      views: a?.views ?? '',
      watchHours: a?.watchHours === null || a?.watchHours === undefined ? '' : a.watchHours.toFixed(2),
      avgPctViewed: a?.avgPctViewed ?? '',
    };
  };

  for (const video of tested) {
    if (state.cancelled) {
      setState({ phase: 'cancelled', message: 'Stopped. Partial results kept.' });
      await finishRun('Scan stopped');
      return;
    }

    setState({ message: `Reading “${video.title || video.videoId}”…` });

    // The working tab can vanish mid-run — closed by the user, or crashed. Without this
    // check every subsequent navigation throws, each one caught by the handler below,
    // silently manufacturing an error row per video and grinding through the whole
    // channel producing nothing. Recreate it once; give up loudly if that fails.
    try {
      await chrome.tabs.get(tabId);
    } catch {
      setState({ message: 'Working tab was closed — reopening…' });
      try {
        const fresh = await chrome.tabs.create({ url: 'about:blank', active: true });
        tabId = fresh.id;
        state.workingTabId = tabId;
        state.ownedTabId = tabId;
        await waitForTabLoad(tabId, 15000).catch(() => {});
      } catch (err) {
        setState({
          phase: 'error',
          error: 'The working tab was closed and could not be reopened. Partial results kept.',
        });
        await finishRun('Scan stopped');
        return;
      }
    }

    try {
      await chrome.tabs.update(tabId, { url: EDIT_URL(video.videoId, sourceUrl) });
      await waitForTabLoad(tabId);
      const report = await inject(tabId, scrapeReport);

      if (report?.status === 'ok') {
        consecutiveFailures = 0;
        for (const variant of report.variants) {
          state.rows.push(withAnalytics({
            videoId: video.videoId,
            videoUrl: `https://youtu.be/${video.videoId}`,
            currentTitle: video.title ?? '',
            testStatus: video.abLabel ?? '',
            // The list label is authoritative about whether a test has concluded: a
            // running test shows live shares but no verdict, which is a state rather
            // than a parse failure and must not be conflated with one.
            testOutcome: /running/i.test(video.abLabel || '') ? 'running' : (report.outcome ?? ''),
            variantIndex: variant.index,
            variantTitle: variant.title ?? '',
            watchTimeSharePct: variant.watchTimeSharePct ?? '',
            isWinner: variant.isWinner ? 'yes' : 'no',
            isCurrentlyLive: variant.isLive ? 'yes' : 'no',
            ranFrom: report.ranFrom ?? '',
            ranTo: report.ranTo ?? '',
          }));
        }
        setState({ found: state.found + 1 });
      } else {
        // Running tests have no report yet — expected, not an error.
        state.rows.push(withAnalytics({
          videoId: video.videoId,
          videoUrl: `https://youtu.be/${video.videoId}`,
          currentTitle: video.title ?? '',
          testStatus: video.abLabel ?? '',
          testOutcome: report?.status === 'none' ? 'no-report-yet' : (report?.status ?? 'unreadable'),
          variantIndex: '',
          variantTitle: '',
          watchTimeSharePct: '',
          isWinner: '',
          isCurrentlyLive: '',
          ranFrom: '',
          ranTo: '',
        }));
      }
    } catch (error) {
      consecutiveFailures++;
      // Record and continue — one bad video must not lose the whole run.
      state.rows.push(withAnalytics({
        videoId: video.videoId,
        videoUrl: `https://youtu.be/${video.videoId}`,
        currentTitle: video.title ?? '',
        testStatus: video.abLabel ?? '',
        testOutcome: `error: ${error?.message || String(error)}`,
        variantIndex: '',
        variantTitle: '',
        watchTimeSharePct: '',
        isWinner: '',
        isCurrentlyLive: '',
        ranFrom: '',
        ranTo: '',
      }));
    }

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      setState({
        phase: 'error',
        error:
          `Stopped after ${consecutiveFailures} videos in a row failed to produce a report. ` +
          'Something systemic is wrong — check you are still signed in to Studio. Partial results kept.',
      });
      await finishRun('Scan stopped early');
      return;
    }

    setState({ scanned: state.scanned + 1 });
    // Throttled: writing a few MB after every single video is wasteful, but losing more
    // than a handful of videos to a crash is worse.
    if (state.scanned % 5 === 0) void persist();

    // Hand the accumulated renderer heap back to the OS. See RECYCLE_EVERY_N_VIDEOS.
    if (state.scanned % RECYCLE_EVERY_N_VIDEOS === 0) {
      tabId = await recycleTab(tabId);
      state.workingTabId = tabId;
      state.ownedTabId = tabId;
    }

    // Stop immediately if Studio starts pushing back. Continuing into a throttle turns a
    // soft rate-limit into something that looks a lot more deliberate.
    const blocked = await inject(tabId, () => {
      const text = document.body?.innerText || '';
      if (/unusual traffic|are you a robot|verify you'?re human|recaptcha/i.test(text)) return 'captcha';
      if (/too many requests|rate limit/i.test(text)) return 'rate-limit';
      if (/don'?t have permission|do not have permission/i.test(text)) return 'permission';
      return null;
    }).catch(() => null);

    if (blocked) {
      setState({
        phase: 'error',
        error:
          blocked === 'permission'
            ? 'Studio returned a permission error partway through. Partial results kept.'
            : `Studio started rate-limiting (${blocked}). Stopped early — partial results kept. Wait a while before retrying.`,
      });
      await finishRun('Scan stopped early');
      return;
    }

    await sleep(jitteredDelay());
  }

  // Videos with no A/B test still belong in the export — lifetime analytics for the whole
  // catalogue is the larger half of the training signal. Titles come from the list walk,
  // so they are blank for videos on pages the early-exit skipped.
  // Resumed rows carry analytics from whenever they were exported. Refresh them from
  // this run's figures so the whole file is internally consistent.
  for (const row of state.rows) {
    const a = analyticsById.get(row.videoId);
    if (!a) continue;
    row.impressions = a.impressions ?? '';
    row.impressionsCtrPct = a.impressionsCtrPct ?? '';
    row.views = a.views ?? '';
    row.watchHours = a.watchHours === null ? '' : a.watchHours.toFixed(2);
    row.avgPctViewed = a.avgPctViewed ?? '';
  }

  const emitted = new Set(state.rows.map((r) => r.videoId));
  const titleById = new Map(videos.map((v) => [v.videoId, v.title ?? '']));
  let analyticsOnly = 0;

  for (const [videoId, a] of analyticsById) {
    if (emitted.has(videoId)) continue;
    analyticsOnly++;
    state.rows.push({
      videoId,
      videoUrl: `https://youtu.be/${videoId}`,
      currentTitle: titleById.get(videoId) ?? '',
      testStatus: '',
      testOutcome: 'no-test',
      variantIndex: '',
      variantTitle: '',
      watchTimeSharePct: '',
      isWinner: '',
      isCurrentlyLive: '',
      ranFrom: '',
      ranTo: '',
      impressions: a.impressions ?? '',
      impressionsCtrPct: a.impressionsCtrPct ?? '',
      views: a.views ?? '',
      watchHours: a.watchHours === null ? '' : a.watchHours.toFixed(2),
      avgPctViewed: a.avgPctViewed ?? '',
    });
  }

  setState({
    phase: 'done',
    message:
      `Done. ${state.found} test report(s) read` +
      (analyticsOnly ? `, plus lifetime analytics for ${analyticsOnly} other video(s).` : '.'),
  });
  // Close the dedicated working tab: it is ours, nobody wants it left behind, and a
  // 2,900-row Studio list is the heaviest thing on the page.
  await closeTab(tabId);
  state.ownedTabId = null;
  await finishRun('Scan complete');
}

/**
 * Terminal housekeeping: persist, save the CSV automatically, and make the result
 * visible even if every window is closed.
 *
 * The CSV is written WITHOUT a save dialog on purpose — the whole point is to start a
 * long scan and walk away, and a modal waiting for a click would defeat that (and, if
 * the worker were killed first, lose the run entirely).
 */
async function finishRun(headline) {
  await persist();
  // NB: the keepalive is deliberately NOT cleared here — with a multi-channel queue this
  // runs between channels, and dropping the alarm mid-queue would leave the worker
  // unprotected during the next one. It is cleared once, when the whole run ends.

  if (state.rows.length === 0) {
    setBadge('!', '#b3261e');
    return;
  }

  let savedAs = null;
  try {
    savedAs = await downloadCsv(false);
  } catch (err) {
    console.error('[exporter] auto-save failed', err);
  }

  setBadge(String(state.rows.length > 999 ? '999+' : state.rows.length));

  try {
    await chrome.notifications.create(`ab-export-${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icon128.png',
      title: headline,
      message:
        `${state.rows.length} rows` +
        (savedAs ? ` saved to your Downloads folder as ${savedAs}` : ' ready — open the extension to download'),
      priority: 2,
    });
  } catch (err) {
    console.error('[exporter] notification failed', err);
  }
}

// ---------------------------------------------------------------- CSV

const CSV_COLUMNS = [
  'videoId',
  'videoUrl',
  'currentTitle',
  // Lifetime, whole-channel analytics — repeated on every variant row of a video so the
  // file is one self-contained table.
  'impressions',
  'impressionsCtrPct',
  'views',
  'watchHours',
  'avgPctViewed',
  // A/B test result; blank for videos that were never tested.
  'testStatus',
  'testOutcome',
  'variantIndex',
  'variantTitle',
  'watchTimeSharePct',
  'isWinner',
  'isCurrentlyLive',
  'ranFrom',
  'ranTo',
];

/**
 * Drop duplicate rows before export.
 *
 * A scan resets `rows`, so this is belt-and-braces rather than load-bearing — but a
 * re-sorting list can hand back the same video on two pages, and duplicate variant rows
 * would quietly skew anything trained on the CSV.
 */
function dedupeRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = `${row.videoId}::${row.variantIndex}::${row.variantTitle}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function toCsv(rows) {
  const escape = (value) => {
    const s = value === null || value === undefined ? '' : String(value);
    // Always quote: titles routinely contain commas, quotes and apostrophes.
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = [CSV_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map((c) => escape(row[c])).join(','));
  }
  return lines.join('\r\n');
}

/**
 * A downloadable URL for the CSV.
 *
 * Small exports use a data: URL, which needs nothing extra. Large ones go through an
 * offscreen document, because a service worker has no URL.createObjectURL and data: URLs
 * hit a size ceiling — a big channel would otherwise fail to auto-save at the very end
 * of a long unattended run, which is the worst possible moment to lose it.
 */
const DATA_URL_LIMIT = 1_000_000;

async function csvUrl(csv) {
  const dataUrl = `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
  if (dataUrl.length <= DATA_URL_LIMIT) return dataUrl;

  try {
    const existing = await chrome.runtime.getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (!existing || existing.length === 0) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['BLOBS'],
        justification: 'Create a blob URL for a large CSV export.',
      });
    }
    const res = await chrome.runtime.sendMessage({ type: 'make-blob-url', text: csv });
    if (res?.ok && res.url) return res.url;
    console.error('[exporter] offscreen blob failed', res?.error);
  } catch (err) {
    console.error('[exporter] offscreen unavailable', err);
  }
  // Fall back to the data URL and let chrome.downloads decide — better to try than to
  // refuse outright.
  return dataUrl;
}

async function downloadCsv(saveAs = true) {
  await ensureRestored();
  if (state.rows.length === 0) throw new Error('Nothing to export yet.');

  const csv = toCsv(dedupeRows(state.rows));
  const url = await csvUrl(csv);
  // Local time, not UTC: toISOString() produced names that disagreed with the file's own
  // modified time by the timezone offset. Colons are excluded because they are illegal in
  // Windows filenames — this ships to Windows and Linux users too.
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  // Only [A-Za-z0-9._-] survives, so the name is valid on every platform Chrome runs on.
  const safeChannel = String(state.channelId || 'channel').replace(/[^A-Za-z0-9_-]/g, '');
  const filename = `ab-title-tests-${safeChannel}-${stamp}.csv`;
  await chrome.downloads.download({ url, filename, saveAs });
  return filename;
}

// ---------------------------------------------------------------- messaging

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    // The worker may have restarted since the last run; rehydrate before answering
    // anything, or a finished export looks empty.
    await ensureRestored();

    switch (message?.type) {
      case 'get-state':
        return publicState();

      case 'capability-check': {
        // Surfaced in the popup so a missing permission is visible rather than silent.
        return {
          storage: typeof chrome.storage?.local?.set === 'function',
          downloads: typeof chrome.downloads?.download === 'function',
          notifications: typeof chrome.notifications?.create === 'function',
          scripting: typeof chrome.scripting?.executeScript === 'function',
        };
      }

      case 'clear': {
        state.rows = [];
        state.phase = 'idle';
        state.message = '';
        state.scanned = 0;
        state.total = 0;
        state.found = 0;
        await chrome.storage.local.remove(STORE_KEY);
        setBadge('');
        setState({});
        return publicState();
      }

      case 'find-studio-tabs': {
        // One entry per DISTINCT channel across all open Studio tabs. Scanning uses each
        // channel's own tab, so its account context (authuser/pageId) comes along for
        // free — no channel-id entry and no way to get the account wrong.
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const activeChannel = channelIdFromUrl(activeTab?.url);

        const tabs = await chrome.tabs.query({ url: 'https://studio.youtube.com/*' });
        const byChannel = new Map();
        for (const tab of tabs) {
          const channelId = channelIdFromUrl(tab.url);
          if (!channelId || byChannel.has(channelId)) continue;
          byChannel.set(channelId, {
            tabId: tab.id,
            channelId,
            title: tab.title || channelId,
            isActive: channelId === activeChannel,
          });
        }
        // The tab the user is actually looking at comes first and is the default, so the
        // obvious choice is never ambiguous.
        return [...byChannel.values()].sort((a, b) => Number(b.isActive) - Number(a.isActive));
      }

      case 'find-studio-tab': {
        // Prefer the active tab if it's already a Studio channel page.
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (active && channelIdFromUrl(active.url)) {
          return { tabId: active.id, url: active.url, channelId: channelIdFromUrl(active.url) };
        }
        const candidates = await chrome.tabs.query({ url: 'https://studio.youtube.com/*' });
        const match = candidates.find((t) => channelIdFromUrl(t.url));
        return match
          ? { tabId: match.id, url: match.url, channelId: channelIdFromUrl(match.url) }
          : null;
      }

      case 'start': {
        // Concurrent runs are impossible (single shared state) AND undesirable — the
        // request rate is what triggers Studio throttling. Say so instead of silently
        // ignoring the click.
        if (state.running) {
          return { ...publicState(), rejected: 'A scan is already running. Stop it first, or wait for it to finish.' };
        }
        if (!message.tabId) {
          setState({ phase: 'error', error: 'No Studio tab selected.' });
          return publicState();
        }
        Object.assign(state, {
          running: true,
          cancelled: false,
          // Seed from a resumed CSV when one was supplied.
          rows: Array.isArray(message.resumeRows) ? message.resumeRows : [],
          scanned: 0,
          total: 0,
          found: 0,
          error: null,
          workingTabId: message.tabId,
          channelId: null,
        });
        setBadge('');
        setKeepalive(true);
        try {
          // Sequential by design. Channels are scanned one at a time, each saving its own
          // CSV before the next begins, so a long unattended run covers every channel
          // without ever multiplying the load on Studio.
          const jobs = Array.isArray(message.jobs) && message.jobs.length
            ? message.jobs
            : [{ tabId: message.tabId }];

          for (let i = 0; i < jobs.length; i++) {
            if (state.cancelled) break;
            state.queueIndex = i + 1;
            state.queueTotal = jobs.length;

            if (i > 0) {
              // Fresh row set per channel: each gets its own file, and merging channels
              // into one table would make the export ambiguous.
              state.rows = [];
              state.scanned = 0;
              state.total = 0;
              state.found = 0;
              state.channelId = null;
            }
            state.workingTabId = jobs[i].tabId;
            setBadge('');

            await run(jobs[i].tabId, Number.isInteger(message.emptyPageStreakLimit) ? message.emptyPageStreakLimit : 3);

            // finishRun() has already saved this channel's CSV and notified.
            if (i < jobs.length - 1) await sleep(3000);
          }
        } catch (error) {
          setState({ phase: 'error', error: error?.message || String(error) });
          await finishRun('Scan failed');
        } finally {
          // Our tab, our responsibility — a stopped or failed run must not leave a
          // half-driven Studio tab sitting there consuming a renderer.
          if (state.ownedTabId) {
            await closeTab(state.ownedTabId);
            state.ownedTabId = null;
          }
          state.running = false;
          setKeepalive(false);
          await persist();
          setState({});
        }
        return publicState();
      }

      case 'cancel':
        state.cancelled = true;
        return publicState();

      case 'download':
        await downloadCsv(message.saveAs !== false);
        setBadge('');
        return { ok: true };

      default:
        return null;
    }
  })().then(sendResponse, (error) => sendResponse({ error: error?.message || String(error) }));
  return true;
});
