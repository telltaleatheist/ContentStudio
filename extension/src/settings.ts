// Typed wrapper over chrome.storage.local for the extension's settings.
//
// The settings shape is intentionally small — ONLY the connection to
// ContentStudio is user-editable:
//   port  — the localhost port ContentStudio's ingest server listens on
//
// There is NO token: the ingest server requires no auth. It is localhost-bound
// and blocks CSRF by rejecting cross-origin web Origins, so the extension talks
// to it directly. The channel list is NOT stored here either: it is pulled live
// from ContentStudio (GET /analytics/channels, see ingest-client.fetchChannels)
// which is the single source of truth. ChannelConfig is retained as the shared
// shape of one fetched channel.

export interface ChannelConfig {
  channelId: string;
  name: string;
}

export interface Settings {
  port: number;
}

export const DEFAULT_SETTINGS: Settings = {
  port: 43117,
};

const SETTINGS_KEY = 'settings';

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const raw = stored[SETTINGS_KEY] as Partial<Settings> | undefined;
  if (!raw) {
    return { ...DEFAULT_SETTINGS };
  }
  return {
    port: typeof raw.port === 'number' && Number.isInteger(raw.port) ? raw.port : DEFAULT_SETTINGS.port,
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

// ---- visibility scheduler device key ------------------------------------------------------
//
// Kept under its own storage key rather than inside `settings`: the options page saves the
// port by writing the whole Settings object, and a key folded into it would be one missed
// field away from being wiped by a port change. Made on the scheduler's setup page
// (contentstudio.owenmorgan.com/scheduler/), pasted into Options, sent only to the
// scheduler (scheduler/scheduler-client.ts) and never logged.

const SCHEDULER_KEY = 'schedulerKey';

/** The scheduler device key, or null when none is set. */
export async function getSchedulerKey(): Promise<string | null> {
  const stored = await chrome.storage.local.get(SCHEDULER_KEY);
  const raw = stored[SCHEDULER_KEY];
  return typeof raw === 'string' && raw !== '' ? raw : null;
}

/** Store the key; null removes it. */
export async function saveSchedulerKey(key: string | null): Promise<void> {
  if (key === null) await chrome.storage.local.remove(SCHEDULER_KEY);
  else await chrome.storage.local.set({ [SCHEDULER_KEY]: key });
}
