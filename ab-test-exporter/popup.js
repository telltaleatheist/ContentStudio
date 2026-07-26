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

/** The Studio tab we'll drive, resolved on open. */
let studioTab = null;

async function init() {
  const stored = await chrome.storage.local.get([CONSENT_KEY]);
  if (stored[CONSENT_KEY]) showMain();

  $('agree').addEventListener('click', async () => {
    await chrome.storage.local.set({ [CONSENT_KEY]: true });
    showMain();
    await detectTab();
  });

  $('start').addEventListener('click', onStart);
  $('cancel').addEventListener('click', () => send({ type: 'cancel' }));
  $('download').addEventListener('click', async () => {
    const res = await send({ type: 'download' });
    if (res?.error) $('error').textContent = res.error;
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
  studioTab = await send({ type: 'find-studio-tab' });

  if (studioTab?.channelId) {
    $('detected').textContent = `Found Studio tab for channel ${studioTab.channelId}`;
    $('detected').className = 'ok';
    $('start').disabled = false;
  } else {
    $('detected').textContent =
      'No YouTube Studio channel tab open. Open Studio → Content, then reopen this popup.';
    $('detected').className = 'err';
    $('start').disabled = true;
  }
}

async function onStart() {
  $('error').textContent = '';
  if (!studioTab?.tabId) {
    $('error').textContent = 'Open YouTube Studio → Content first.';
    return;
  }
  render(await send({ type: 'start', tabId: studioTab.tabId }));
}

function render(state) {
  if (!state || (state.error === undefined && state.phase === undefined)) return;

  const running = !!state.running;
  $('start').classList.toggle('hidden', running);
  $('cancel').classList.toggle('hidden', !running);
  if (!running && studioTab?.channelId) $('start').disabled = false;

  $('message').textContent = state.message || 'Ready.';
  $('message').className = state.phase === 'done' ? 'ok' : 'muted';
  $('error').textContent = state.error || '';

  const pct = state.total ? Math.round((state.scanned / state.total) * 100) : 0;
  $('bar').style.width = `${pct}%`;

  $('counts').textContent = state.total
    ? `${state.scanned} / ${state.total} videos · ${state.rowCount} CSV row(s)`
    : '';

  const finished = ['done', 'cancelled', 'error'].includes(state.phase);
  $('download').classList.toggle('hidden', !(finished && state.rowCount > 0));
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'progress') render(message.state);
});

init();
