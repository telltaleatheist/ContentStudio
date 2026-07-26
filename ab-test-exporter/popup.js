/**
 * Popup: consent gate, then start / progress / download.
 *
 * The consent gate is shown until the user accepts it once; the acceptance is stored so
 * it isn't nagged on every open. Deliberately a real gate — nothing can be started from
 * this UI before it's been read and accepted.
 */

const $ = (id) => document.getElementById(id);

const CONSENT_KEY = 'consentAcceptedV1';
const CHANNEL_KEY = 'lastChannelId';

async function init() {
  const stored = await chrome.storage.local.get([CONSENT_KEY, CHANNEL_KEY]);

  if (stored[CONSENT_KEY]) showMain();
  if (stored[CHANNEL_KEY]) $('channelId').value = stored[CHANNEL_KEY];

  $('agree').addEventListener('click', async () => {
    await chrome.storage.local.set({ [CONSENT_KEY]: true });
    showMain();
  });

  $('start').addEventListener('click', onStart);
  $('cancel').addEventListener('click', () => send({ type: 'cancel' }));
  $('download').addEventListener('click', async () => {
    const res = await send({ type: 'download' });
    if (res?.error) $('error').textContent = res.error;
  });

  // Pre-fill the channel id from an open Studio tab when we can.
  if (!$('channelId').value) {
    const tabs = await chrome.tabs.query({ url: 'https://studio.youtube.com/*' });
    for (const tab of tabs) {
      const id = (tab.url || '').match(/\/channel\/(UC[\w-]+)/)?.[1];
      if (id) {
        $('channelId').value = id;
        break;
      }
    }
  }

  render(await send({ type: 'get-state' }));
}

function showMain() {
  $('consent').classList.add('hidden');
  $('main').classList.remove('hidden');
}

function send(message) {
  return chrome.runtime.sendMessage(message).catch((e) => ({ error: String(e) }));
}

async function onStart() {
  const channelId = $('channelId').value.trim();
  $('error').textContent = '';

  if (!/^UC[\w-]{20,}$/.test(channelId)) {
    $('error').textContent = 'That does not look like a channel ID. It starts with "UC".';
    return;
  }

  await chrome.storage.local.set({ [CHANNEL_KEY]: channelId });
  render(await send({ type: 'start', channelId }));
}

function render(state) {
  if (!state || state.error === undefined && state.phase === undefined) return;

  const running = state.running;
  $('start').classList.toggle('hidden', running);
  $('cancel').classList.toggle('hidden', !running);
  $('start').disabled = running;

  $('message').textContent = state.message || 'Ready.';
  $('error').textContent = state.error || '';

  const pct = state.total ? Math.round((state.scanned / state.total) * 100) : 0;
  $('bar').style.width = `${pct}%`;

  $('counts').textContent = state.total
    ? `${state.scanned} / ${state.total} videos · ${state.rowCount} CSV row(s)`
    : '';

  const finished = ['done', 'cancelled', 'error'].includes(state.phase);
  $('download').classList.toggle('hidden', !(finished && state.rowCount > 0));

  if (state.phase === 'done') $('message').className = 'ok';
  else $('message').className = 'muted';
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'progress') render(message.state);
});

init();
