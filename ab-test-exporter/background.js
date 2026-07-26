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

/** Pause between video page loads. Deliberately unhurried. */
const PER_VIDEO_DELAY_MS = 1200;

const state = {
  running: false,
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
  // Popup may be closed; ignore the "no receiver" rejection.
  chrome.runtime.sendMessage({ type: 'progress', state: publicState() }).catch(() => {});
}

function publicState() {
  const { rows, ...rest } = state;
  return { ...rest, rowCount: rows.length };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- injected scrapers
// These run in the page. They must be self-contained — no closures over anything here.

/**
 * Enumerate every video row in the Studio content list.
 *
 * The list lazy-loads, so this scrolls until the row count stops growing. Returns the
 * A/B label when present ("A/B Test running" / "A/B Test completed"), which is how we
 * decide which videos are worth opening.
 */
async function scrapeVideoList() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Scroll the list until it stops growing (lazy loading), with a hard cap so a
  // pathological page can't spin forever.
  let previous = -1;
  for (let pass = 0; pass < 400; pass++) {
    const rows = document.querySelectorAll('ytcp-video-row');
    if (rows.length === previous) break;
    previous = rows.length;
    const last = rows[rows.length - 1];
    if (last) last.scrollIntoView({ block: 'end' });
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(700);
  }

  const out = [];
  for (const row of document.querySelectorAll('ytcp-video-row')) {
    const href = row.querySelector('a[href*="/video/"]')?.getAttribute('href') || '';
    const videoId = href.match(/\/video\/([^/]+)/)?.[1] || null;
    if (!videoId) continue;

    const lines = (row.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const abLine = lines.find((l) => /a\/b test/i.test(l)) || null;

    // The visible title is the first line that isn't a duration, a date, a number, or
    // the A/B label. Duration badges sort first in this component.
    const title =
      lines.find(
        (l) =>
          !/^\d+:\d+/.test(l) &&
          !/a\/b test/i.test(l) &&
          !/^[\d,.]+$/.test(l) &&
          l.length > 3,
      ) || null;

    out.push({ videoId, title, abLabel: abLine });
  }
  return out;
}

/**
 * Open the A/B test report on a video details page and parse it.
 *
 * Returns { status, variants[], ranFrom, ranTo } or { status: 'none' } when the video
 * has no test. Never throws for "no test" — that's an expected outcome, not an error.
 */
async function scrapeReport() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  const headline = /we have a winner/i.test(dialogText)
    ? 'winner'
    : /performed the same|performed same/i.test(dialogText)
      ? 'performed-same'
      : /inconclusive/i.test(dialogText)
        ? 'inconclusive'
        : 'unknown';

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

async function inject(tabId, func) {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func });
  return result?.result;
}

async function run(tabId) {
  setState({ phase: 'listing', message: 'Loading your video list…', scanned: 0, total: 0, found: 0 });

  // Anchor everything to the tab's CURRENT url so the account context is preserved.
  const startTab = await chrome.tabs.get(tabId);
  const sourceUrl = startTab.url || '';
  const channelId = channelIdFromUrl(sourceUrl);
  if (!channelId) {
    throw new Error(
      'That Studio tab is not on a channel page. Open Studio → Content, then try again.',
    );
  }

  await chrome.tabs.update(tabId, { url: LIST_URL(channelId, sourceUrl) });
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

  const videos = await inject(tabId, scrapeVideoList);
  if (!Array.isArray(videos) || videos.length === 0) {
    throw new Error('Could not read the video list. Make sure you are signed in to YouTube Studio.');
  }

  // Only videos the list marks as tested are worth opening.
  const tested = videos.filter((v) => v.abLabel);
  setState({
    phase: 'scraping',
    total: tested.length,
    message: `${videos.length} videos found, ${tested.length} with A/B tests.`,
  });

  if (tested.length === 0) {
    setState({ phase: 'done', message: 'No A/B tests found on this channel.' });
    return;
  }

  for (const video of tested) {
    if (state.cancelled) {
      setState({ phase: 'cancelled', message: 'Stopped. Partial results kept.' });
      return;
    }

    setState({ message: `Reading “${video.title || video.videoId}”…` });

    try {
      await chrome.tabs.update(tabId, { url: EDIT_URL(video.videoId, sourceUrl) });
      await waitForTabLoad(tabId);
      const report = await inject(tabId, scrapeReport);

      if (report?.status === 'ok') {
        for (const variant of report.variants) {
          state.rows.push({
            videoId: video.videoId,
            videoUrl: `https://youtu.be/${video.videoId}`,
            currentTitle: video.title ?? '',
            testStatus: video.abLabel ?? '',
            testOutcome: report.outcome ?? '',
            variantIndex: variant.index,
            variantTitle: variant.title ?? '',
            watchTimeSharePct: variant.watchTimeSharePct ?? '',
            isWinner: variant.isWinner ? 'yes' : 'no',
            isCurrentlyLive: variant.isLive ? 'yes' : 'no',
            ranFrom: report.ranFrom ?? '',
            ranTo: report.ranTo ?? '',
          });
        }
        setState({ found: state.found + 1 });
      } else {
        // Running tests have no report yet — expected, not an error.
        state.rows.push({
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
        });
      }
    } catch (error) {
      // Record and continue — one bad video must not lose the whole run.
      state.rows.push({
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
      });
    }

    setState({ scanned: state.scanned + 1 });
    await sleep(PER_VIDEO_DELAY_MS);
  }

  setState({ phase: 'done', message: `Done. ${state.found} test report(s) read.` });
}

// ---------------------------------------------------------------- CSV

const CSV_COLUMNS = [
  'videoId',
  'videoUrl',
  'currentTitle',
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

async function downloadCsv() {
  if (state.rows.length === 0) throw new Error('Nothing to export yet.');
  const csv = toCsv(state.rows);
  // MV3 service workers have no URL.createObjectURL, so use a data: URL.
  const url = `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
  const stamp = new Date().toISOString().slice(0, 10);
  await chrome.downloads.download({ url, filename: `ab-title-tests-${stamp}.csv`, saveAs: true });
}

// ---------------------------------------------------------------- messaging

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'get-state':
        return publicState();

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
        if (state.running) return publicState();
        if (!message.tabId) {
          setState({ phase: 'error', error: 'No Studio tab selected.' });
          return publicState();
        }
        Object.assign(state, {
          running: true,
          cancelled: false,
          rows: [],
          scanned: 0,
          total: 0,
          found: 0,
          error: null,
        });
        try {
          // Reuse the user's own Studio tab — see accountParams() for why.
          await run(message.tabId);
        } catch (error) {
          setState({ phase: 'error', error: error?.message || String(error) });
        } finally {
          state.running = false;
          setState({});
        }
        return publicState();
      }

      case 'cancel':
        state.cancelled = true;
        return publicState();

      case 'download':
        await downloadCsv();
        return { ok: true };

      default:
        return null;
    }
  })().then(sendResponse, (error) => sendResponse({ error: error?.message || String(error) }));
  return true;
});
