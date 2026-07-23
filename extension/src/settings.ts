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
