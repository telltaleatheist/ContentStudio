// Options page: edit the ContentStudio port. There is no token — the ingest
// server requires no auth. The channel list is NOT edited here — it is pulled
// live from ContentStudio (GET /analytics/channels) and shown read-only, with a
// Refresh button.

//
// Also the visibility scheduler's device key. Its Test button calls the scheduler directly
// (this is an extension page, so Studio's CORS does not apply) with the key in the field,
// saved or not, and shows the connected channels or the server's own error.

import { getSchedulerKey, getSettings, saveSchedulerKey, saveSettings, type Settings } from './settings';
import { fetchChannels, IngestError } from './ingest-client';
import {
  SCHEDULER_KEY_PREFIX,
  SCHEDULER_SETUP_URL,
  fetchSchedulerChannels,
  fetchSchedulerHealth,
} from './scheduler/scheduler-client';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`options.html is missing #${id}`);
  }
  return node as T;
}

function showFeedback(message: string, isError: boolean): void {
  const feedback = el<HTMLDivElement>('save-feedback');
  feedback.textContent = message;
  feedback.className = isError ? 'feedback feedback-error' : 'feedback feedback-ok';
}

/**
 * Fetch and render the read-only channel list from ContentStudio. Each failure
 * kind gets a DISTINCT message; an empty list ("no channels registered") is a
 * success, rendered distinctly from "ContentStudio unreachable".
 */
async function renderChannels(): Promise<void> {
  const container = el<HTMLDivElement>('channels-readonly');
  container.textContent = 'Loading…';
  container.className = 'muted';

  let channels;
  try {
    channels = await fetchChannels();
  } catch (err) {
    container.className = 'channel-error';
    if (err instanceof IngestError && err.kind === 'unreachable') {
      container.textContent = 'ContentStudio is not reachable — start the app, then check the port above and Refresh.';
    } else {
      container.textContent = `Could not load channels — ${err instanceof Error ? err.message : String(err)}`;
    }
    return;
  }

  container.textContent = '';
  container.className = '';
  if (channels.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = 'ContentStudio is connected but has no channels registered yet.';
    container.appendChild(empty);
    return;
  }

  for (const channel of channels) {
    const row = document.createElement('div');
    row.className = 'channel-row';

    const name = document.createElement('div');
    name.className = 'channel-name';
    name.textContent = channel.name || channel.channelId;
    row.appendChild(name);

    const id = document.createElement('div');
    id.className = 'channel-meta';
    id.textContent = channel.channelId;
    row.appendChild(id);

    container.appendChild(row);
  }
}

async function load(): Promise<void> {
  const settings = await getSettings();
  el<HTMLInputElement>('port').value = String(settings.port);
  el<HTMLInputElement>('scheduler-key').value = (await getSchedulerKey()) ?? '';
  const link = el<HTMLAnchorElement>('scheduler-setup-link');
  link.href = SCHEDULER_SETUP_URL;
  link.textContent = SCHEDULER_SETUP_URL.replace(/^https:\/\//, '').replace(/\/$/, '');
  await renderChannels();
}

// ---- visibility scheduler key -------------------------------------------------------------

function schedulerFeedback(message: string, tone: 'ok' | 'error' | 'warn' | 'muted'): void {
  const feedback = el<HTMLDivElement>('scheduler-feedback');
  feedback.textContent = message;
  feedback.className = tone === 'muted' ? 'feedback muted' : `feedback feedback-${tone}`;
}

/** The field's key, or the reason it is not one. An empty field is "no key". */
function readKeyField(): { key: string | null } | { error: string } {
  const key = el<HTMLInputElement>('scheduler-key').value.trim();
  if (!key) return { key: null };
  if (!key.startsWith(SCHEDULER_KEY_PREFIX) || /\s/.test(key)) {
    return { error: `That is not a scheduler key: keys start with "${SCHEDULER_KEY_PREFIX}" and have no spaces. Copy it again from the setup page.` };
  }
  return { key };
}

async function saveKey(): Promise<void> {
  el<HTMLDivElement>('scheduler-result').textContent = '';
  const field = readKeyField();
  if ('error' in field) return schedulerFeedback(field.error, 'error');
  await saveSchedulerKey(field.key);
  schedulerFeedback(field.key ? 'Key saved.' : 'Key removed. The shelf will say there is no key.', 'ok');
}

async function testKey(): Promise<void> {
  const result = el<HTMLDivElement>('scheduler-result');
  result.textContent = '';
  const field = readKeyField();
  if ('error' in field) return schedulerFeedback(field.error, 'error');
  if (!field.key) return schedulerFeedback('Paste a key first.', 'error');
  const unsaved = field.key !== (await getSchedulerKey());

  schedulerFeedback('Testing…', 'muted');
  let health;
  let channels;
  try {
    // Health first: it is what tells a refused key (401) from a scheduler that is down.
    health = await fetchSchedulerHealth(field.key);
    channels = await fetchSchedulerChannels(field.key);
  } catch (err) {
    return schedulerFeedback(err instanceof Error ? err.message : String(err), 'error');
  }

  const who = `The scheduler accepts this key (it knows it as "${health.caller}")${unsaved ? ' — not saved yet' : ''}.`;
  if (health.ok) {
    schedulerFeedback(who, 'ok');
  } else {
    schedulerFeedback(
      `${who} But its loop is not running: last tick ${health.lastTick ?? 'never'}. Changes will not run until it does.`,
      'warn',
    );
  }

  if (channels.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'channel-error';
    empty.textContent = `No channels are connected to the scheduler. Connect them on ${SCHEDULER_SETUP_URL}.`;
    result.appendChild(empty);
    return;
  }
  for (const channel of channels) {
    const row = document.createElement('div');
    row.className = channel.state === 'ok' ? 'channel-row' : 'channel-row channel-reconnect';
    const name = document.createElement('div');
    name.className = 'channel-name';
    name.textContent = channel.title;
    const meta = document.createElement('div');
    meta.className = channel.state === 'ok' ? 'channel-meta' : 'channel-meta channel-error';
    meta.textContent =
      channel.state === 'ok'
        ? `${channel.channelId} · connected`
        : `${channel.channelId} · ${channel.state}${channel.lastError ? `: ${channel.lastError}` : ''}`;
    row.append(name, meta);
    result.appendChild(row);
  }
}

async function save(): Promise<void> {
  const portRaw = el<HTMLInputElement>('port').value.trim();
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    showFeedback(`Port must be an integer between 1 and 65535 (got "${portRaw}").`, true);
    return;
  }

  const settings: Settings = { port };
  await saveSettings(settings);
  showFeedback('Saved.', false);
  // Re-fetch with the just-saved connection so the list reflects the new port.
  await renderChannels();
}

document.addEventListener('DOMContentLoaded', () => {
  el<HTMLButtonElement>('save').addEventListener('click', () => void save());
  el<HTMLButtonElement>('refresh-channels').addEventListener('click', () => void renderChannels());
  el<HTMLButtonElement>('scheduler-save').addEventListener('click', () => void saveKey());
  el<HTMLButtonElement>('scheduler-test').addEventListener('click', () => void testKey());
  void load();
});
