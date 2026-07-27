// Persisted shelf placement.
//
// The shelf overlays YouTube Studio, so where it sits is a real preference: on some
// pages the right edge covers the sidebar the operator needs. Side and collapsed state
// therefore survive navigation, tab closes and browser restarts.
//
// Stored in chrome.storage.local (not session) for exactly that reason.

const KEY = 'publishShelf';

export type ShelfSide = 'left' | 'right';

export interface ShelfPrefs {
  side: ShelfSide;
  collapsed: boolean;
}

export const DEFAULT_SHELF_PREFS: ShelfPrefs = {
  side: 'right',
  collapsed: false,
};

/**
 * Read the stored prefs.
 *
 * Unknown/absent values fall back to the defaults because there is no correct answer to
 * "which side did the operator want" before they have ever chosen — this is an initial
 * value, not a substitute for data that should exist.
 */
export async function loadShelfPrefs(): Promise<ShelfPrefs> {
  const stored = await chrome.storage.local.get(KEY);
  const raw = stored[KEY];
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SHELF_PREFS };

  const side = (raw as { side?: unknown }).side;
  const collapsed = (raw as { collapsed?: unknown }).collapsed;
  return {
    side: side === 'left' || side === 'right' ? side : DEFAULT_SHELF_PREFS.side,
    collapsed: typeof collapsed === 'boolean' ? collapsed : DEFAULT_SHELF_PREFS.collapsed,
  };
}

export async function saveShelfPrefs(prefs: ShelfPrefs): Promise<void> {
  await chrome.storage.local.set({ [KEY]: prefs });
}
