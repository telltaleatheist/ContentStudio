// Persisted state for the video nav strip.
//
// Its own key, separate from `publishShelf`: the two overlays are collapsed for different
// reasons (the shelf hides a 320px panel the operator is done with, the strip hides a rail
// that sits over Studio's right-hand column), so one preference cannot stand for both.
//
// chrome.storage.local rather than session for the same reason as the shelf's — a
// placement choice that resets on every browser restart is not a preference.

const KEY = 'videoNavStrip';

export interface NavStripPrefs {
  collapsed: boolean;
}

export const DEFAULT_NAV_STRIP_PREFS: NavStripPrefs = {
  collapsed: false,
};

/**
 * Read the stored prefs.
 *
 * An absent value is an INITIAL value, not missing data: nobody has collapsed the strip
 * before it has ever been shown, so expanded is the answer rather than a stand-in for one.
 */
export async function loadNavStripPrefs(): Promise<NavStripPrefs> {
  const stored = await chrome.storage.local.get(KEY);
  const raw = stored[KEY];
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_NAV_STRIP_PREFS };

  const collapsed = (raw as { collapsed?: unknown }).collapsed;
  return {
    collapsed: typeof collapsed === 'boolean' ? collapsed : DEFAULT_NAV_STRIP_PREFS.collapsed,
  };
}

export async function saveNavStripPrefs(prefs: NavStripPrefs): Promise<void> {
  await chrome.storage.local.set({ [KEY]: prefs });
}
