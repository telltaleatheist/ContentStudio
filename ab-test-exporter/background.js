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
 * The whole video catalogue — id, TITLE, DESCRIPTION, and A/B experiment — in bulk.
 *
 * This replaces walking the Studio content list page by page. Studio's own list is backed
 * by creator/list_creator_videos, and asking it directly is better in every way: it pages
 * 100 at a time via pageToken (no DOM, no clicking), and the `mask` lets us request
 * fields the page never displays.
 *
 * Critically it returns the FULL description (verified: 2,149 chars, untruncated), which
 * is the training input — the reason this data is being collected at all.
 *
 * It also carries videoCreatorExperiment, so A/B VARIANT TITLES, the experiment state and
 * the WINNING ARM all arrive here rather than needing one page visit per tested video.
 * Only the watch-time share percentages are absent; those exist solely in the report
 * dialog, which is why the per-video pass is still offered as an option.
 *
 * MUST run in the MAIN world: needs window.ytcfg and the SAPISID cookie.
 */
async function fetchCreatorVideos(channelId, maxPages) {
  const ORIGIN = 'https://studio.youtube.com';
  const ENDPOINT = 'https://studio.youtube.com/youtubei/v1/creator/list_creator_videos?alt=json';
  const PAGE_SIZE = 100; // server caps here; larger values are silently clamped

  const fail = (code, message) => ({ ok: false, code, message });

  try {
    const readCookie = (name) => {
      for (const pair of (document.cookie ? document.cookie.split('; ') : [])) {
        const eq = pair.indexOf('=');
        if ((eq === -1 ? pair : pair.slice(0, eq)) === name) {
          return eq === -1 ? '' : decodeURIComponent(pair.slice(eq + 1));
        }
      }
      return null;
    };
    const sapisid = readCookie('SAPISID') || readCookie('__Secure-3PAPISID');
    if (!sapisid) return fail('NO_SAPISID', 'Not signed in to YouTube Studio.');

    const sha1Hex = async (input) => {
      const bytes = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input)));
      let hex = ''; for (const b of bytes) hex += b.toString(16).padStart(2, '0');
      return hex;
    };

    const cfg = window.ytcfg;
    if (!cfg || typeof cfg.get !== 'function') return fail('YTCFG_MISSING', 'Studio page not loaded.');
    const innertube = cfg.get('INNERTUBE_CONTEXT');
    const clientVersion = innertube?.client?.clientVersion;
    const delegation = cfg.get('INNERTUBE_CONTEXT_SERIALIZED_DELEGATION_CONTEXT');
    if (!clientVersion || !delegation) return fail('YTCFG_MISSING', 'Studio context incomplete — reload the page.');
    if (cfg.get('CHANNEL_ID') !== channelId) {
      return fail('CHANNEL_MISMATCH', `Studio is on ${cfg.get('CHANNEL_ID')}, not ${channelId}.`);
    }
    const authUser = cfg.get('SESSION_INDEX') != null ? String(cfg.get('SESSION_INDEX')) : '0';

    const buildBody = (pageToken) => {
      const body = {
        context: {
          client: { clientName: 62, clientVersion },
          user: { serializedDelegationContext: delegation },
        },
        // Minimal filter, constructed rather than copied from the page: just this channel.
        filter: { and: { operands: [{ channelIdIs: { value: channelId } }] } },
        order: 'VIDEO_ORDER_DISPLAY_TIME_DESC',
        pageSize: PAGE_SIZE,
        mask: {
          videoId: true, title: true, description: true, privacy: true, status: true,
          lengthSeconds: true, timePublishedSeconds: true, timeCreatedSeconds: true,
          draftStatus: true, origin: true, contentType: true,
          videoCreatorExperiment: { all: true },
        },
      };
      if (pageToken) body.pageToken = pageToken;
      return body;
    };

    const videos = [];
    let pageToken = null;
    let pages = 0;
    const cap = Number.isInteger(maxPages) && maxPages > 0 ? maxPages : 400;

    for (; pages < cap; pages++) {
      const ts = Math.floor(Date.now() / 1000);
      const authorization = `SAPISIDHASH ${ts}_${await sha1Hex(`${ts} ${sapisid} ${ORIGIN}`)}`;

      let resp;
      try {
        resp = await fetch(ENDPOINT, {
          method: 'POST', credentials: 'include',
          headers: {
            'Content-Type': 'application/json', Authorization: authorization, 'X-Origin': ORIGIN,
            'X-Goog-AuthUser': authUser, 'X-YouTube-Delegation-Context': delegation,
            'X-YouTube-Client-Name': '62', 'X-YouTube-Client-Version': clientVersion,
          },
          body: JSON.stringify(buildBody(pageToken)),
        });
      } catch (err) {
        return fail('NETWORK', `Network error: ${err?.message || String(err)}`);
      }
      if (resp.status === 401 || resp.status === 403) return fail('HTTP_AUTH', `Rejected (HTTP ${resp.status}).`);
      if (resp.status === 429) return fail('HTTP_RATELIMIT', 'Rate limited (HTTP 429).');
      if (!resp.ok) return fail('HTTP_ERROR', `HTTP ${resp.status}.`);

      let data;
      try { data = await resp.json(); } catch { return fail('BAD_JSON', 'Response was not JSON.'); }
      if (!Array.isArray(data?.videos)) return fail('BAD_SHAPE', 'Response had no videos array.');

      for (const v of data.videos) {
        if (!v?.videoId) continue;
        const exp = v.videoCreatorExperiment || null;
        const arms = (exp?.experimentArmData || [])
          .map((a) => a?.title?.textSegments?.[0]?.text ?? null)
          .filter((t) => typeof t === 'string');
        // selectedArm is 1-indexed (CREATOR_EXPERIMENT_ARM_1); UNSPECIFIED = no winner.
        const winnerIndex = Number(String(exp?.selectedArm || '').match(/ARM_(\d+)$/)?.[1] || 0);

        videos.push({
          videoId: v.videoId,
          title: typeof v.title === 'string' ? v.title : '',
          description: typeof v.description === 'string' ? v.description : '',
          privacy: v.privacy || '',
          durationSec: v.lengthSeconds ? Number(v.lengthSeconds) : null,
          // A 0 timestamp means "not published", not 1970 — leave it blank so date
          // filters downstream don't silently include 44 phantom 1970 videos.
          publishedAt:
            v.timePublishedSeconds && Number(v.timePublishedSeconds) > 0
              ? new Date(Number(v.timePublishedSeconds) * 1000).toISOString()
              : '',
          experiment: exp
            ? { state: exp.state || '', finishedReason: exp.finishedReason || '', arms, winnerIndex }
            : null,
        });
      }

      pageToken = data.nextPageToken || null;
      if (!pageToken) { pages++; break; }
    }

    return { ok: true, videos, pages, truncated: !!pageToken };
  } catch (err) {
    return fail('EXCEPTION', `Unexpected error: ${err?.message || String(err)}`);
  }
}


/**
 * A/B test RESULTS — watch-time share per variant, and the verdict — for many videos.
 *
 * The list endpoint carries variant titles and the winning arm but NOT the shares. Those
 * live on creator/get_creator_videos, which returns a `result` block per video:
 *
 *   result.resultState            WINNER | NO_WINNER
 *   result.armResults[]           { arm, watchtimeFraction }   0.4215 => 42.15%
 *   result.winnerArm              CREATOR_EXPERIMENT_ARM_n
 *
 * Verified against the figures Studio's own report dialog displays. This is what makes
 * the whole export possible without loading a single video page: batches of 50 ids
 * (100 returns HTTP 400), so a channel's worth of tests is a couple of requests.
 *
 * MUST run in the MAIN world: needs window.ytcfg and the SAPISID cookie.
 */
async function fetchExperimentResults(videoIds) {
  const ORIGIN = 'https://studio.youtube.com';
  const ENDPOINT = 'https://studio.youtube.com/youtubei/v1/creator/get_creator_videos?alt=json';
  const BATCH = 50; // server rejects larger batches outright

  try {
    const readCookie = (name) => {
      for (const pair of (document.cookie ? document.cookie.split('; ') : [])) {
        const eq = pair.indexOf('=');
        if ((eq === -1 ? pair : pair.slice(0, eq)) === name) {
          return eq === -1 ? '' : decodeURIComponent(pair.slice(eq + 1));
        }
      }
      return null;
    };
    const sapisid = readCookie('SAPISID') || readCookie('__Secure-3PAPISID');
    if (!sapisid) return { ok: false, code: 'NO_SAPISID', message: 'Not signed in.' };

    const sha1Hex = async (input) => {
      const bytes = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input)));
      let hex = ''; for (const b of bytes) hex += b.toString(16).padStart(2, '0');
      return hex;
    };

    const cfg = window.ytcfg;
    const innertube = cfg?.get('INNERTUBE_CONTEXT');
    const clientVersion = innertube?.client?.clientVersion;
    const delegation = cfg?.get('INNERTUBE_CONTEXT_SERIALIZED_DELEGATION_CONTEXT');
    if (!clientVersion || !delegation) return { ok: false, code: 'YTCFG_MISSING', message: 'Studio context incomplete.' };
    const authUser = cfg.get('SESSION_INDEX') != null ? String(cfg.get('SESSION_INDEX')) : '0';

    const armIndex = (arm) => Number(String(arm || '').match(/ARM_(\d+)$/)?.[1] || 0);
    const secondsOf = (t) => (t?.seconds ? new Date(Number(t.seconds) * 1000).toISOString() : '');

    const byVideo = {};
    for (let i = 0; i < videoIds.length; i += BATCH) {
      const chunk = videoIds.slice(i, i + BATCH);
      const ts = Math.floor(Date.now() / 1000);
      const authorization = `SAPISIDHASH ${ts}_${await sha1Hex(`${ts} ${sapisid} ${ORIGIN}`)}`;

      const resp = await fetch(ENDPOINT, {
        method: 'POST', credentials: 'include',
        headers: {
          'Content-Type': 'application/json', Authorization: authorization, 'X-Origin': ORIGIN,
          'X-Goog-AuthUser': authUser, 'X-YouTube-Delegation-Context': delegation,
          'X-YouTube-Client-Name': '62', 'X-YouTube-Client-Version': clientVersion,
        },
        body: JSON.stringify({
          context: { client: { clientName: 62, clientVersion }, user: { serializedDelegationContext: delegation } },
          videoIds: chunk,
          mask: { videoId: true, videoCreatorExperiment: { all: true } },
        }),
      });
      if (!resp.ok) return { ok: false, code: 'HTTP_ERROR', message: `Results returned HTTP ${resp.status}.` };

      const data = await resp.json();
      for (const v of data?.videos || []) {
        const exp = v?.videoCreatorExperiment;
        const res = exp?.result;
        if (!v?.videoId || !res) continue;

        const shares = {};
        for (const a of res.armResults || []) {
          const idx = armIndex(a.arm);
          // watchtimeFraction is 0..1; report as a percentage to match Studio's display.
          if (idx > 0 && typeof a.watchtimeFraction === 'number') {
            shares[idx] = Number((a.watchtimeFraction * 100).toFixed(2));
          }
        }
        byVideo[v.videoId] = {
          resultState: String(res.resultState || '').replace('CREATOR_EXPERIMENT_RESULT_STATE_', ''),
          winnerIndex: armIndex(res.winnerArm),
          shares,
          startedAt: secondsOf(exp.experimentStartTime),
          finishedAt: secondsOf(exp.experimentFinishTime),
        };
      }
    }
    return { ok: true, byVideo };
  } catch (err) {
    return { ok: false, code: 'EXCEPTION', message: err?.message || String(err) };
  }
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

    // CORE is verified working. EXTENDED adds the rest of the useful per-video metrics;
    // if Studio rejects any of them the whole request 400s, so we try extended first and
    // fall back rather than losing everything to one unsupported name.
    const CORE = [
      'VIDEO_THUMBNAIL_IMPRESSIONS',
      'VIDEO_THUMBNAIL_IMPRESSIONS_VTR',
      'EXTERNAL_VIEWS',
      'EXTERNAL_WATCH_TIME',
      'AVERAGE_WATCH_PERCENTAGE',
    ];
    const EXTENDED = CORE.concat([
      'AVERAGE_WATCH_TIME',        // average view duration (ms)
      'SUBSCRIBERS_NET_CHANGE',
      'SUBSCRIBERS_GAINED',
      'SUBSCRIBERS_LOST',
      'RATINGS_LIKES',
      'RATINGS_DISLIKES',
      'COMMENTS',
      'SHARINGS',                  // shares
      'NEW_VIEWERS',
      'RETURNING_VIEWERS',
    ]);

    // NO EARNINGS DATA — EVER.
    //
    // This tool is shared with other creators on the explicit promise that it does not
    // collect income. That promise is enforced here rather than left to reviewer
    // diligence: any metric whose name looks monetary is dropped before the request is
    // built, so adding one later cannot quietly break the commitment.
    // Precise on purpose: a loose pattern (e.g. a bare "ad_") would silently strip a
    // legitimate metric and quietly lose a column.
    const MONETARY = /revenue|earning|monetiz|\brpm\b|\bcpm\b|payment|income|estimated_partner|ad_impressions|playback_based_cpm/i;
    const stripMonetary = (list) => list.filter((m) => !MONETARY.test(m));

    const buildBody = (metricSet) => ({
      context: {
        client: { clientName: 62, clientVersion },
        user: { serializedDelegationContext: delegation },
      },
      nodes: [{
        key: 'TABLE_QUERY',
        value: {
          query: {
            dimensions: [{ type: 'VIDEO' }],
            metrics: stripMonetary(metricSet).map((type) => ({ type })),
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
    });

    let resp;
    let body = buildBody(EXTENDED);
    let usedExtended = true;
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

    // One unsupported metric name 400s the whole query — retry with the proven set.
    if (resp.status === 400 && usedExtended) {
      usedExtended = false;
      body = buildBody(CORE);
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

    const avgViewDurMs = seriesOf('AVERAGE_WATCH_TIME', ['milliseconds', 'doubles', 'counts']);
    const subsNet = seriesOf('SUBSCRIBERS_NET_CHANGE', ['counts', 'doubles']);
    const subsGained = seriesOf('SUBSCRIBERS_GAINED', ['counts']);
    const subsLost = seriesOf('SUBSCRIBERS_LOST', ['counts']);
    const newViewers = seriesOf('NEW_VIEWERS', ['counts']);
    const returningViewers = seriesOf('RETURNING_VIEWERS', ['counts']);
    const likes = seriesOf('RATINGS_LIKES', ['counts']);
    const dislikes = seriesOf('RATINGS_DISLIKES', ['counts']);
    const comments = seriesOf('COMMENTS', ['counts']);
    const shares = seriesOf('SHARINGS', ['counts']);
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
        avgViewDurationSec: avgViewDurMs && toNum(avgViewDurMs[i]) !== null ? toNum(avgViewDurMs[i]) / 1000 : null,
        subscribersNet: subsNet ? toNum(subsNet[i]) : null,
        subscribersGained: subsGained ? toNum(subsGained[i]) : null,
        subscribersLost: subsLost ? toNum(subsLost[i]) : null,
        newViewers: newViewers ? toNum(newViewers[i]) : null,
        returningViewers: returningViewers ? toNum(returningViewers[i]) : null,
        likes: likes ? toNum(likes[i]) : null,
        dislikes: dislikes ? toNum(dislikes[i]) : null,
        comments: comments ? toNum(comments[i]) : null,
        shares: shares ? toNum(shares[i]) : null,
      });
    }

    // Offset paging is unsupported, so a completely full page means the catalogue may
    // exceed one request. Say so rather than silently dropping the overflow.
    const truncated = rowCount >= PAGE;
    return { ok: true, rows, truncated, extended: usedExtended };
  } catch (err) {
    return fail('EXCEPTION', `Unexpected error: ${err?.message || String(err)}`);
  }
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
 * Release the accumulated renderer heap WITHOUT creating or closing any tabs.
 *
 * Chrome reuses one renderer process across successive same-origin navigations, so
 * driving hundreds of Studio pages through a tab grows that process the whole way.
 * Navigating to about:blank leaves the studio.youtube.com origin, which lets Chrome swap
 * process and reclaim the old one — the same benefit as closing the tab, without
 * disturbing the tab the operator chose.
 */
async function flushTabMemory(tabId) {
  try {
    await chrome.tabs.update(tabId, { url: 'about:blank' });
    await waitForTabLoad(tabId, 10000).catch(() => {});
    await sleep(400);
  } catch (err) {
    console.warn('[exporter] memory flush skipped', err);
  }
}

async function inject(tabId, func, args = [], world = 'ISOLATED') {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func, args, world });
  return result?.result;
}

async function run(sourceTabId) {

  setState({ phase: 'listing', message: 'Preparing…', scanned: 0, total: 0, found: 0 });

  // Drive the tab the operator pointed us at — no extra tabs. Every navigation forces
  // focus, because chrome.tabs.update does not raise a tab and a background scan looks
  // broken while working perfectly.
  const startTab = await chrome.tabs.get(sourceTabId);
  const sourceUrl = startTab.url || '';
  const channelId = channelIdFromUrl(sourceUrl);
  if (!channelId) {
    throw new Error('That Studio tab is not on a channel page. Open Studio → Content, then try again.');
  }
  state.channelId = channelId;

  let tabId = sourceTabId;
  state.workingTabId = tabId;

  await chrome.tabs.update(tabId, { url: LIST_URL(channelId, sourceUrl), active: true });
  await chrome.windows.update(startTab.windowId, { focused: true }).catch(() => {});
  await waitForTabLoad(tabId);
  await sleep(2500);

  const denied = await inject(tabId, () =>
    /don't have permission|do not have permission/i.test(document.body?.innerText || ''),
  );
  if (denied) {
    throw new Error(
      "Studio says you don't have permission for this channel. Switch to the right " +
        'account in Studio, open Content, and run the scan from that tab.',
    );
  }

  // ---- 1. whole catalogue: id, title, DESCRIPTION, release date, duration, experiment ----
  setState({ message: 'Fetching your video catalogue (titles, descriptions, tests)…' });
  const catalogue = await inject(tabId, fetchCreatorVideos, [channelId, 400], 'MAIN');
  if (!catalogue?.ok) {
    throw new Error(
      `Could not read your video catalogue (${catalogue?.code || 'unknown'}): ${catalogue?.message || ''}`,
    );
  }
  const videos = catalogue.videos;
  if (videos.length === 0) throw new Error('No videos returned for this channel.');

  // ---- 2. lifetime analytics for every video, in one request ----
  const publicCount = videos.filter((v) => /PUBLIC/i.test(String(v.privacy || ''))).length;
  setState({
    message: `${publicCount} public videos (${videos.length - publicCount} private/unlisted skipped). Fetching analytics…`,
  });
  const analyticsById = new Map();
  const analytics = await inject(tabId, fetchLifetimeAnalytics, [channelId], 'MAIN');
  if (analytics?.ok) {
    for (const row of analytics.rows) analyticsById.set(row.videoId, row);
  } else {
    // Not fatal — catalogue and A/B results are still worth exporting without metrics.
    setState({
      message: `Analytics unavailable (${analytics?.code || 'unknown'}) — continuing without those columns.`,
    });
    await sleep(1500);
  }

  // ---- 3. build rows: one per A/B variant, else one per video ----
  const base = (v) => {
    const a = analyticsById.get(v.videoId);
    return {
      videoId: v.videoId,
      videoUrl: `https://youtu.be/${v.videoId}`,
      title: v.title,
      description: v.description,
      publishedAt: v.publishedAt,
      durationSec: v.durationSec ?? '',
      privacy: String(v.privacy || '').replace('VIDEO_PRIVACY_', '').toLowerCase(),
      impressions: a?.impressions ?? '',
      impressionsCtrPct: a?.impressionsCtrPct ?? '',
      views: a?.views ?? '',
      watchHours:
        a?.watchHours === null || a?.watchHours === undefined ? '' : a.watchHours.toFixed(2),
      avgPctViewed: a?.avgPctViewed ?? '',
      avgViewDurationSec:
        a?.avgViewDurationSec === null || a?.avgViewDurationSec === undefined
          ? ''
          : a.avgViewDurationSec.toFixed(1),
      subscribersNet: a?.subscribersNet ?? '',
      subscribersGained: a?.subscribersGained ?? '',
      subscribersLost: a?.subscribersLost ?? '',
      newViewers: a?.newViewers ?? '',
      returningViewers: a?.returningViewers ?? '',
      likes: a?.likes ?? '',
      dislikes: a?.dislikes ?? '',
      comments: a?.comments ?? '',
      shares: a?.shares ?? '',
    };
  };

  // Untested videos still carry an empty videoCreatorExperiment object, so presence of
  // the object means nothing — only arms and state do.
  const outcomeOf = (exp) => {
    if (!exp || !exp.arms.length || !exp.state) return 'no-test';
    if (/FINISHED/.test(exp.state)) return exp.winnerIndex > 0 ? 'winner' : 'no-clear-winner';
    if (/INITIALIZED/.test(exp.state)) return 'running';
    // Genuinely unrecognised: keep YouTube's own value so a new state is diagnosable.
    return `state: ${exp.state}`;
  };

  // ---- 3. A/B results (watch-time share per variant) for tested videos ----
  // Two API calls for a channel's worth of tests — no video pages are opened at all.
  const testedIds = videos
    .filter((v) => /PUBLIC/i.test(String(v.privacy || '')))
    .filter((v) => v.experiment && v.experiment.arms.length && v.experiment.state)
    .map((v) => v.videoId);

  let resultsByVideo = {};
  if (testedIds.length) {
    setState({ message: `Fetching A/B results for ${testedIds.length} tests…` });
    const results = await inject(tabId, fetchExperimentResults, [testedIds], 'MAIN');
    if (results?.ok) {
      resultsByVideo = results.byVideo;
    } else {
      // Non-fatal: variants and winner still come from the catalogue, only the shares are lost.
      setState({ message: `A/B result shares unavailable (${results?.code || 'unknown'}) — continuing.` });
      await sleep(1200);
    }
  }

  // Public videos only. Private and unlisted are excluded: their metrics are not
  // comparable (no organic impressions), and they are usually drafts or archives rather
  // than published work, so they would only add noise to training data.
  const publicVideos = videos.filter((v) => /PUBLIC/i.test(String(v.privacy || '')));

  const tested = [];
  for (const v of publicVideos) {
    const b = base(v);
    const exp = v.experiment;

    if (!exp || exp.arms.length === 0 || !exp.state) {
      state.rows.push({
        ...b,
        testState: '',
        testOutcome: outcomeOf(exp),
        testFinishedReason: '',
        testStartedAt: '',
        testFinishedAt: '',
        variantIndex: '',
        variantTitle: '',
        watchTimeSharePct: '',
        isWinner: '',
        isCurrentlyLive: '',
      });
      continue;
    }

    tested.push(v);
    const res = resultsByVideo[v.videoId];
    // WINNER vs LIVE are different things and must not be conflated. `winnerArm` is which
    // variant actually won; `selectedArm` is which is now shown to everyone — and for an
    // inconclusive test that is just YouTube falling back to variant 1. Treating
    // selectedArm as a winner invented winners for tests YouTube declared undecided.
    const winnerIndex = res ? res.winnerIndex : 0;
    const liveIndex = exp.winnerIndex; // selectedArm from the catalogue

    exp.arms.forEach((armTitle, i) => {
      state.rows.push({
        ...b,
        testState: exp.state.replace('CREATOR_EXPERIMENT_STATE_', ''),
        testOutcome: res?.resultState
          ? (res.resultState === 'WINNER' ? 'winner' : 'no-clear-winner')
          : outcomeOf(exp),
        testFinishedReason: exp.finishedReason.replace('CREATOR_EXPERIMENT_FINISHED_REASON_', ''),
        testStartedAt: res?.startedAt || '',
        testFinishedAt: res?.finishedAt || '',
        variantIndex: i + 1,
        variantTitle: armTitle,
        watchTimeSharePct: res?.shares?.[i + 1] ?? '',
        isWinner: winnerIndex === i + 1 ? 'yes' : 'no',
        isCurrentlyLive: liveIndex === i + 1 ? 'yes' : 'no',
      });
    });
  }

  setState({
    found: tested.length,
    message:
      `${publicVideos.length} public videos, ${tested.length} with A/B tests.` +
      (catalogue.truncated ? ' NOTE: hit the page cap — some videos may be missing.' : ''),
  });
  await persist();

  await chrome.tabs.update(tabId, { url: LIST_URL(channelId, sourceUrl) }).catch(() => {});
  setState({
    phase: 'done',
    message: `Done. ${publicVideos.length} public videos, ${tested.length} with A/B tests.`,
  });
  await finishRun('Scan complete');
}

/**
 * Terminal housekeeping: persist, save the CSV automatically, and make the result visible
 * even if every window is closed.
 *
 * The CSV is written WITHOUT a save dialog on purpose — the point is to start a scan and
 * walk away, and a modal waiting for a click would defeat that.
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
        (savedAs
          ? ` saved to your Downloads folder as ${savedAs}`
          : ' ready — open the extension to download'),
      priority: 2,
    });
  } catch (err) {
    console.error('[exporter] notification failed', err);
  }
}

// ---------------------------------------------------------------- CSV

const CSV_COLUMNS = [
  // --- video ---
  'videoId',
  'videoUrl',
  'title',
  'description',        // the model's INPUT: description in, titles out
  'publishedAt',
  'durationSec',
  'privacy',
  // --- lifetime analytics (whole channel, one request) ---
  'impressions',
  'impressionsCtrPct',
  'views',
  'watchHours',
  'avgPctViewed',
  'avgViewDurationSec',
  'subscribersNet',
  'subscribersGained',
  'subscribersLost',
  'newViewers',
  'returningViewers',
  'likes',
  'dislikes',
  'comments',
  'shares',
  // --- A/B title test; blank for untested videos ---
  'testState',
  'testOutcome',
  'testFinishedReason',
  'testStartedAt',
  'testFinishedAt',
  'variantIndex',
  'variantTitle',
  'watchTimeSharePct',
  'isWinner',          // won the test outright (YouTube's winnerArm)
  'isCurrentlyLive',   // now shown to everyone — variant 1 by default if undecided
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

            await run(jobs[i].tabId);

            // finishRun() has already saved this channel's CSV and notified.
            if (i < jobs.length - 1) await sleep(3000);
          }
        } catch (error) {
          setState({ phase: 'error', error: error?.message || String(error) });
          await finishRun('Scan failed');
        } finally {
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
