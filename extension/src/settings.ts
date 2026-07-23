// Typed wrapper over chrome.storage.local for the extension's settings.
//
// The settings shape is intentionally small — ONLY the connection to
// ContentStudio is user-editable:
//   port  — the localhost port ContentStudio's ingest server listens on
//   token — bearer token pasted from ContentStudio's Analytics page
//
// The channel list is NO LONGER stored here: it is pulled live from
// ContentStudio (GET /analytics/channels, see ingest-client.fetchChannels) which
// is the single source of truth. ChannelConfig is retained as the shared shape
// of one fetched channel.

export interface ChannelConfig {
  channelId: string;
  name: string;
}

export interface Settings {
  port: number;
  token: string;
}

export const DEFAULT_SETTINGS: Settings = {
  port: 43117,
  token: '',
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
    token: typeof raw.token === 'string' ? raw.token : DEFAULT_SETTINGS.token,
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}
