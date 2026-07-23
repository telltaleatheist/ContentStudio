// Popup status view: ContentStudio connection, collector status, per-channel
// lastAttempt/lastError, outbox depth, and a manual "Sync now" trigger.

import { COLLECTOR_IMPLEMENTED } from './collector';
import { checkHealth, fetchChannels, IngestError, type HealthResult } from './ingest-client';
import { outboxDepth } from './outbox';
import { getSettings } from './settings';
import { getChannelStatuses, getLastCycle } from './status';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`popup.html is missing #${id}`);
  }
  return node as T;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return 'never';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function renderHealth(result: HealthResult, port: number): void {
  const dot = el<HTMLSpanElement>('connection-dot');
  const text = el<HTMLSpanElement>('connection-text');
  const detail = el<HTMLDivElement>('connection-detail');
  dot.className = 'dot';
  detail.textContent = '';
  switch (result.state) {
    case 'connected':
      dot.classList.add('dot-ok');
      text.textContent = `Connected to ContentStudio (127.0.0.1:${port})`;
      break;
    case 'unreachable':
      dot.classList.add('dot-err');
      text.textContent = 'ContentStudio not running';
      detail.textContent = result.detail;
      break;
    case 'unexpected-response':
      dot.classList.add('dot-warn');
      text.textContent = 'Unexpected response';
      detail.textContent = result.detail;
      break;
  }
}

function renderCollectorStatus(): void {
  const badge = el<HTMLSpanElement>('collector-status');
  if (COLLECTOR_IMPLEMENTED) {
    badge.textContent = 'Active';
    badge.className = 'badge badge-ok';
  } else {
    badge.textContent = 'Pending Studio recon';
    badge.className = 'badge badge-pending';
  }
}

async function renderChannels(): Promise<void> {
  const list = el<HTMLDivElement>('channel-list');
  list.textContent = '';

  // Channels come LIVE from ContentStudio — the single source of truth. Each
  // failure kind gets a distinct message; an empty list ("none registered") is
  // rendered distinctly from "ContentStudio unreachable".
  let channels;
  try {
    channels = await fetchChannels();
  } catch (err) {
    const div = document.createElement('div');
    div.className = 'muted channel-error';
    if (err instanceof IngestError && err.kind === 'unreachable') {
      div.textContent = 'Cannot list channels — ContentStudio is not running.';
    } else {
      div.textContent = `Cannot list channels — ${err instanceof Error ? err.message : String(err)}`;
    }
    list.appendChild(div);
    return;
  }

  if (channels.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = 'No channels registered in ContentStudio yet.';
    list.appendChild(empty);
    return;
  }

  const statuses = await getChannelStatuses();
  for (const channel of channels) {
    const status = statuses[channel.channelId];
    const row = document.createElement('div');
    row.className = 'channel-row';

    const name = document.createElement('div');
    name.className = 'channel-name';
    name.textContent = channel.name || channel.channelId;
    name.title = channel.channelId;
    row.appendChild(name);

    const attempt = document.createElement('div');
    attempt.className = 'channel-meta';
    attempt.textContent = `Last attempt: ${formatTimestamp(status?.lastAttempt ?? null)}`;
    row.appendChild(attempt);

    if (status?.lastError) {
      const error = document.createElement('div');
      const pending = status.lastErrorName === 'CollectorNotImplementedError';
      error.className = pending ? 'channel-meta channel-pending' : 'channel-meta channel-error';
      error.textContent = pending
        ? 'Collector pending Studio recon'
        : `Error (${status.lastErrorName ?? 'Error'}): ${status.lastError}`;
      row.appendChild(error);
    } else if (status?.lastSuccess) {
      const ok = document.createElement('div');
      ok.className = 'channel-meta channel-ok';
      const count = status.lastSnapshotCount;
      const snaps = count === null || count === undefined
        ? ''
        : ` · ${count} snapshot${count === 1 ? '' : 's'}`;
      ok.textContent = `Last success: ${formatTimestamp(status.lastSuccess)}${snaps}`;
      row.appendChild(ok);
    }

    list.appendChild(row);
  }
}

async function renderOutboxAndCycle(): Promise<void> {
  const depth = await outboxDepth();
  el<HTMLSpanElement>('outbox-depth').textContent = String(depth);

  const cycle = await getLastCycle();
  const line = el<HTMLDivElement>('last-cycle');
  if (!cycle) {
    line.textContent = 'No collection cycle has run yet.';
    return;
  }
  const parts = [
    `Last cycle (${cycle.trigger}) ${formatTimestamp(cycle.finishedAt)}:`,
    `${cycle.channelsAttempted} channel(s),`,
    `${cycle.flush.delivered}/${cycle.flush.attempted} outbox entries delivered.`,
  ];
  line.textContent = parts.join(' ');
  const err = el<HTMLDivElement>('last-cycle-error');
  if (cycle.channelSourceError) {
    err.textContent = `Could not fetch channels from ContentStudio (${cycle.channelSourceError.name}): ${cycle.channelSourceError.message} — nothing was collected.`;
  } else if (cycle.flush.stopped) {
    err.textContent = `Flush stopped (${cycle.flush.stopped.kind}): ${cycle.flush.stopped.message}`;
  } else if (cycle.flush.entryErrors.length > 0) {
    err.textContent = `${cycle.flush.entryErrors.length} entr${cycle.flush.entryErrors.length === 1 ? 'y' : 'ies'} rejected as invalid (HTTP 400) — see service worker console.`;
  } else {
    err.textContent = '';
  }
}

async function refresh(): Promise<void> {
  const settings = await getSettings();
  renderCollectorStatus();
  await Promise.all([renderChannels(), renderOutboxAndCycle()]);
  // Health check last — it is the slowest (network) call.
  renderHealth(await checkHealth(), settings.port);
}

async function syncNow(): Promise<void> {
  const button = el<HTMLButtonElement>('sync-now');
  const feedback = el<HTMLDivElement>('sync-feedback');
  button.disabled = true;
  feedback.textContent = 'Syncing…';
  try {
    const response = (await chrome.runtime.sendMessage({ type: 'sync-now' })) as
      | { ok: true; summary: unknown }
      | { ok: false; errorName: string; error: string }
      | undefined;
    if (!response) {
      feedback.textContent = 'No response from the background worker.';
    } else if (response.ok) {
      feedback.textContent = 'Cycle finished.';
    } else {
      feedback.textContent = `Cycle failed (${response.errorName}): ${response.error}`;
    }
  } catch (err) {
    feedback.textContent = `Could not reach the background worker: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    button.disabled = false;
    await refresh();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  el<HTMLButtonElement>('sync-now').addEventListener('click', () => void syncNow());
  el<HTMLAnchorElement>('open-options').addEventListener('click', (event) => {
    event.preventDefault();
    void chrome.runtime.openOptionsPage();
  });
  void refresh();
});
