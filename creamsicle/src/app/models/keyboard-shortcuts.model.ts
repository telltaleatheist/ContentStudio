// Keyboard Shortcuts Models

export interface KeyboardShortcut {
  id: string;
  keys: ShortcutKeys;
  action: string;
  description?: string;
  category: ShortcutCategory;
  icon?: string;
  enabled?: boolean;
}

export interface ShortcutKeys {
  mac: string[];
  windows: string[];
  display: string; // What to show in UI
}

export type ShortcutCategory =
  | 'playback'
  | 'tools'
  | 'editing'
  | 'navigation'
  | 'selection'
  | 'view'
  | 'file'
  | 'markers'
  | 'timeline';

export interface ShortcutCategoryInfo {
  id: ShortcutCategory;
  name: string;
  icon: string;
  color: string;
  order: number;
}

export interface KeyboardShortcutsConfig {
  enabled: boolean;
  showOnStartup: boolean;
  theme: 'light' | 'dark' | 'auto';
  position: 'center' | 'right' | 'left';
  size: 'compact' | 'normal' | 'large';
}

// Platform detection
export type Platform = 'mac' | 'windows' | 'linux';

export interface ShortcutGroup {
  category: ShortcutCategoryInfo;
  shortcuts: KeyboardShortcut[];
}

// Common modifier keys
export const ModifierKeys = {
  mac: {
    cmd: '⌘',
    alt: '⌥',
    ctrl: '⌃',
    shift: '⇧',
    enter: '↵',
    delete: '⌫',
    escape: '⎋',
    tab: '⇥',
    space: '␣',
    up: '↑',
    down: '↓',
    left: '←',
    right: '→'
  },
  windows: {
    cmd: 'Ctrl',
    alt: 'Alt',
    ctrl: 'Ctrl',
    shift: 'Shift',
    enter: 'Enter',
    delete: 'Delete',
    escape: 'Esc',
    tab: 'Tab',
    space: 'Space',
    up: '↑',
    down: '↓',
    left: '←',
    right: '→'
  }
};

// Search functionality
export interface ShortcutSearchResult {
  shortcut: KeyboardShortcut;
  matchedField: 'action' | 'description' | 'keys';
  matchScore: number;
}