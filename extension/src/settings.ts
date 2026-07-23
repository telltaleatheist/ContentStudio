// Typed wrapper over chrome.storage.local for the extension's settings.
//
// The settings shape is intentionally small:
//   port     — the localhost port ContentStudio's ingest server listens on
//   token    — bearer token pasted from ContentStudio's Analytics page
//   channels — the YouTube channels the collector should cover

export interface ChannelConfig {
  channelId: string;
  name: string;
}

export interface Settings {
  port: number;
  token: string;
  channels: ChannelConfig[];
}

export const DEFAULT_SETTINGS: Settings = {
  port: 43117,
  token: '',
  channels: [],
};

const SETTINGS_KEY = 'settings';

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const raw = stored[SETTINGS_KEY] as Partial<Settings> | undefined;
  if (!raw) {
    return { ...DEFAULT_SETTINGS, channels: [] };
  }
  return {
    port: typeof raw.port === 'number' && Number.isInteger(raw.port) ? raw.port : DEFAULT_SETTINGS.port,
    token: typeof raw.token === 'string' ? raw.token : DEFAULT_SETTINGS.token,
    channels: Array.isArray(raw.channels)
      ? raw.channels.filter(
          (c): c is ChannelConfig =>
            typeof c === 'object' && c !== null &&
            typeof (c as ChannelConfig).channelId === 'string' &&
            typeof (c as ChannelConfig).name === 'string',
        )
      : [],
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

/**
 * YouTube channel ids are "UC" followed by 22 base64url characters
 * (24 characters total), e.g. UC_x5XG1OV2P6uZZ5FSM9Ttw.
 */
export const CHANNEL_ID_PATTERN = /^UC[0-9A-Za-z_-]{22}$/;

export function isValidChannelId(id: string): boolean {
  return CHANNEL_ID_PATTERN.test(id);
}
