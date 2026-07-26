/**
 * Popup: consent gate, then start / progress / download.
 *
 * There is deliberately NO channel-id field. The scan reuses whichever YouTube Studio
 * tab the user already has open, because Studio resolves /channel/<id>/ URLs against the
 * currently active Google account — so a pasted id belonging to a brand account under a
 * different signed-in profile produces "you don't have permission to view this page".
 * Working from the open tab makes that impossible, and removes a confusing step.
 */

const $ = (id) => document.getElementById(id);

const CONSENT_KEY = 'consentAcceptedV1';

/** Rows parsed from a resume CSV, or null. */
let resumeRows = null;

/**
 * Minimal RFC4180 CSV parser.
 *
 * Hand-rolled because the fields we write routinely contain commas, double quotes and —
 * in descriptions — newlines, so a naive split(',') would silently corrupt a resume and
 * cause videos to be re-scanned or dropped.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  // Normalise line endings so CRLF and LF files behave identically.
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }   // escaped quote
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = '';
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v !== '')) rows.push(row);

  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((cells) =>
    Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])),
  );
}

/** Distinct channels found across open Studio tabs. */
let channels = [];

async function init() {
  const stored = await chrome.storage.local.get([CONSENT_KEY]);
  if (stored[CONSENT_KEY]) showMain();

  $('agree').addEventListener('click', async () => {
    await chrome.storage.local.set({ [CONSENT_KEY]: true });
    showMain();
    await detectTab();
  });

  $('resumeFile').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const parsed = parseCsv(await file.text());
      if (!parsed.length || !('videoId' in parsed[0])) {
        throw new Error('That file does not look like an export from this extension.');
      }
      resumeRows = parsed;
      const done = new Set(
        parsed.filter((r) => r.testOutcome && !r.testOutcome.startsWith('error')).map((r) => r.videoId),
      );
      $('resumeInfo').textContent =
        `Resuming: ${parsed.length} rows loaded, ${done.size} videos already done.`;
      $('resumeInfo').className = 'ok';
    } catch (err) {
      resumeRows = null;
      $('resumeInfo').textContent = err?.message || String(err);
      $('resumeInfo').className = 'err';
    }
  });

  $('start').addEventListener('click', onStart);
  $('cancel').addEventListener('click', () => send({ type: 'cancel' }));
  $('download').addEventListener('click', async () => {
    const res = await send({ type: 'download' });
    if (res?.error) $('error').textContent = res.error;
  });

  // Surface a missing permission plainly — otherwise persistence or the auto-save would
  // fail silently and a long unattended run would be lost.
  const caps = await send({ type: 'capability-check' });
  const missing = caps && Object.entries(caps).filter(([, ok]) => !ok).map(([k]) => k);
  if (missing && missing.length) {
    $('caps').textContent =
      `Missing permission(s): ${missing.join(', ')}. Remove and re-add the extension at chrome://extensions.`;
    $('caps').className = 'err';
  }

  $('clear').addEventListener('click', async () => {
    if (!confirm('Discard the saved results from the last scan?')) return;
    resumeRows = null;
    $('resumeInfo').textContent = '';
    render(await send({ type: 'clear' }));
  });

  if (stored[CONSENT_KEY]) await detectTab();
  render(await send({ type: 'get-state' }));
}

function showMain() {
  $('consent').classList.add('hidden');
  $('main').classList.remove('hidden');
}

function send(message) {
  return chrome.runtime.sendMessage(message).catch((e) => ({ error: String(e) }));
}

async function detectTab() {
  channels = (await send({ type: 'find-studio-tabs' })) || [];

  const box = $('channels');
  box.innerHTML = '';

  if (!Array.isArray(channels) || channels.length === 0) {
    $('detected').textContent =
      'No YouTube Studio channel tab open. Open Studio → Content, then reopen this popup.';
    $('detected').className = 'err';
    $('start').disabled = true;
    return;
  }

  // One tab per channel: open each channel's Content page in its own tab and they all
  // appear here. Scanning uses each channel's own tab, so the account context is right
  // for every one of them without any extra input.
  $('detected').textContent =
    channels.length === 1
      ? '1 channel detected.'
      : `${channels.length} channels detected — they will be scanned one after another.`;
  $('detected').className = 'ok';

  for (const ch of channels) {
    const label = document.createElement('label');
    label.className = 'check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.dataset.channelId = ch.channelId;
    const name = (ch.title || '').replace(/\s*-\s*YouTube Studio\s*$/i, '').trim();
    label.append(cb, document.createTextNode(` ${name || ch.channelId}`));
    box.appendChild(label);
  }

  $('start').disabled = false;
}

function selectedJobs() {
  const checked = [...$('channels').querySelectorAll('input[type=checkbox]')]
    .filter((cb) => cb.checked)
    .map((cb) => cb.dataset.channelId);
  return channels.filter((c) => checked.includes(c.channelId)).map((c) => ({
    tabId: c.tabId,
    channelId: c.channelId,
  }));
}

async function onStart() {
  $('error').textContent = '';
  const jobs = selectedJobs();
  if (!jobs.length) {
    $('error').textContent = 'Tick at least one channel.';
    return;
  }
  if (jobs.length > 1 && resumeRows) {
    $('error').textContent = 'Resuming works on one channel at a time. Untick the others.';
    return;
  }

  // 0 disables the early exit entirely and walks every page.
  const limit = $('stopEarly').checked ? 3 : 0;
  const res = await send({
    type: 'start',
    jobs,
    tabId: jobs[0].tabId,
    emptyPageStreakLimit: limit,
    resumeRows,
  });
  if (res?.rejected) $('error').textContent = res.rejected;
  render(res);
}

function render(state) {
  if (!state || (state.error === undefined && state.phase === undefined)) return;

  const running = !!state.running;
  $('start').classList.toggle('hidden', running);
  $('cancel').classList.toggle('hidden', !running);
  if (!running && channels.length) $('start').disabled = false;

  $('message').textContent =
    (state.queueLabel ? `${state.queueLabel} — ` : '') + (state.message || 'Ready.');
  $('message').className = state.phase === 'done' ? 'ok' : 'muted';
  $('error').textContent = state.error || '';

  const pct = state.total ? Math.round((state.scanned / state.total) * 100) : 0;
  $('bar').style.width = `${pct}%`;

  $('counts').textContent = state.total
    ? `${state.scanned} / ${state.total} videos · ${state.rowCount} CSV row(s)`
    : '';

  // Results persist across worker restarts, so the download is offered whenever rows
  // exist and nothing is running — not only immediately after a run finishes.
  $('download').classList.toggle('hidden', running || !state.rowCount);
  $('clear').classList.toggle('hidden', running || !state.rowCount);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'progress') render(message.state);
});

init();
