// Options page: edit the ContentStudio port + bearer token. The channel list is
// NOT edited here — it is pulled live from ContentStudio (GET /analytics/channels)
// and shown read-only, with a Refresh button.

import { getSettings, saveSettings, type Settings } from './settings';
import { fetchChannels, IngestError } from './ingest-client';

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
    } else if (err instanceof IngestError && err.kind === 'unauthorized') {
      container.textContent = 'ContentStudio rejected the token (401) — paste a fresh token from its Analytics page, Save, then Refresh.';
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
  el<HTMLInputElement>('token').value = settings.token;
  await renderChannels();
}

async function save(): Promise<void> {
  const portRaw = el<HTMLInputElement>('port').value.trim();
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    showFeedback(`Port must be an integer between 1 and 65535 (got "${portRaw}").`, true);
    return;
  }

  const token = el<HTMLInputElement>('token').value.trim();

  const settings: Settings = { port, token };
  await saveSettings(settings);
  showFeedback('Saved.', false);
  // Re-fetch with the just-saved connection so the list reflects the new port/token.
  await renderChannels();
}

document.addEventListener('DOMContentLoaded', () => {
  el<HTMLButtonElement>('save').addEventListener('click', () => void save());
  el<HTMLButtonElement>('refresh-channels').addEventListener('click', () => void renderChannels());
  void load();
});
