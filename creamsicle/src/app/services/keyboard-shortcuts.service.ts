import { Injectable, signal } from '@angular/core';
import {
  KeyboardShortcut,
  ShortcutCategory,
  ShortcutCategoryInfo,
  Platform,
  ShortcutGroup,
  KeyboardShortcutsConfig,
  ShortcutSearchResult
} from '../models/keyboard-shortcuts.model';

@Injectable({
  providedIn: 'root'
})
export class KeyboardShortcutsService {
  private platform = signal<Platform>(this.detectPlatform());
  private config = signal<KeyboardShortcutsConfig>({
    enabled: true,
    showOnStartup: false,
    theme: 'auto',
    position: 'center',
    size: 'normal'
  });

  // Observable for showing/hiding the shortcuts panel
  isVisible = signal(false);

  // Categories configuration
  private categories: ShortcutCategoryInfo[] = [
    { id: 'playback', name: 'Playback Controls', icon: '▶️', color: '#ff6b35', order: 1 },
    { id: 'tools', name: 'Tools', icon: '🛠️', color: '#ffa366', order: 2 },
    { id: 'editing', name: 'Editing', icon: '✂️', color: '#3b82f6', order: 3 },
    { id: 'timeline', name: 'Timeline', icon: '📊', color: '#22c55e', order: 4 },
    { id: 'selection', name: 'Selection', icon: '📍', color: '#f59e0b', order: 5 },
    { id: 'markers', name: 'Markers', icon: '🚩', color: '#ef4444', order: 6 },
    { id: 'navigation', name: 'Navigation', icon: '🧭', color: '#8b5cf6', order: 7 },
    { id: 'view', name: 'View', icon: '👁️', color: '#06b6d4', order: 8 },
    { id: 'file', name: 'File Operations', icon: '📁', color: '#64748b', order: 9 }
  ];

  // All shortcuts
  private shortcuts: KeyboardShortcut[] = [
    // Playback Controls
    {
      id: 'play-pause',
      keys: { mac: ['Space'], windows: ['Space'], display: 'Space' },
      action: 'Play/Pause',
      description: 'Toggle playback',
      category: 'playback',
      icon: '⏯️'
    },
    {
      id: 'play-reverse',
      keys: { mac: ['J'], windows: ['J'], display: 'J' },
      action: 'Play Reverse',
      description: 'Play in reverse (hold to continue)',
      category: 'playback',
      icon: '⏪'
    },
    {
      id: 'play-forward',
      keys: { mac: ['L'], windows: ['L'], display: 'L' },
      action: 'Play Forward',
      description: 'Play forward (hold for 2x speed)',
      category: 'playback',
      icon: '⏩'
    },
    {
      id: 'pause',
      keys: { mac: ['K'], windows: ['K'], display: 'K' },
      action: 'Pause',
      description: 'Pause playback',
      category: 'playback',
      icon: '⏸️'
    },
    {
      id: 'frame-backward',
      keys: { mac: ['←'], windows: ['←'], display: '←' },
      action: 'Previous Frame',
      description: 'Move one frame backward',
      category: 'playback',
      icon: '⏮️'
    },
    {
      id: 'frame-forward',
      keys: { mac: ['→'], windows: ['→'], display: '→' },
      action: 'Next Frame',
      description: 'Move one frame forward',
      category: 'playback',
      icon: '⏭️'
    },
    {
      id: 'jump-start',
      keys: { mac: ['Home'], windows: ['Home'], display: 'Home' },
      action: 'Jump to Start',
      description: 'Go to beginning of timeline',
      category: 'playback',
      icon: '⏮️'
    },
    {
      id: 'jump-end',
      keys: { mac: ['End'], windows: ['End'], display: 'End' },
      action: 'Jump to End',
      description: 'Go to end of timeline',
      category: 'playback',
      icon: '⏭️'
    },

    // Tools
    {
      id: 'select-tool',
      keys: { mac: ['V'], windows: ['V'], display: 'V' },
      action: 'Selection Tool',
      description: 'Switch to selection/move tool',
      category: 'tools',
      icon: '↖️'
    },
    {
      id: 'cursor-tool',
      keys: { mac: ['A'], windows: ['A'], display: 'A' },
      action: 'Cursor Tool',
      description: 'Switch to cursor/pointer tool',
      category: 'tools',
      icon: '👆'
    },
    {
      id: 'razor-tool',
      keys: { mac: ['C'], windows: ['C'], display: 'C' },
      action: 'Razor Tool',
      description: 'Cut/split clips',
      category: 'tools',
      icon: '✂️'
    },
    {
      id: 'highlight-tool',
      keys: { mac: ['R'], windows: ['R'], display: 'R' },
      action: 'Highlight Tool',
      description: 'Highlight sections for emphasis',
      category: 'tools',
      icon: '🖍️'
    },
    {
      id: 'text-tool',
      keys: { mac: ['T'], windows: ['T'], display: 'T' },
      action: 'Text Tool',
      description: 'Add text annotations',
      category: 'tools',
      icon: '📝'
    },
    {
      id: 'zoom-tool',
      keys: { mac: ['Z'], windows: ['Z'], display: 'Z' },
      action: 'Zoom Tool',
      description: 'Zoom in/out of timeline',
      category: 'tools',
      icon: '🔍'
    },

    // Editing
    {
      id: 'cut',
      keys: { mac: ['⌘', 'X'], windows: ['Ctrl', 'X'], display: 'Cmd/Ctrl + X' },
      action: 'Cut',
      description: 'Cut selected clips',
      category: 'editing',
      icon: '✂️'
    },
    {
      id: 'copy',
      keys: { mac: ['⌘', 'C'], windows: ['Ctrl', 'C'], display: 'Cmd/Ctrl + C' },
      action: 'Copy',
      description: 'Copy selected clips',
      category: 'editing',
      icon: '📋'
    },
    {
      id: 'paste',
      keys: { mac: ['⌘', 'V'], windows: ['Ctrl', 'V'], display: 'Cmd/Ctrl + V' },
      action: 'Paste',
      description: 'Paste clips at playhead',
      category: 'editing',
      icon: '📌'
    },
    {
      id: 'undo',
      keys: { mac: ['⌘', 'Z'], windows: ['Ctrl', 'Z'], display: 'Cmd/Ctrl + Z' },
      action: 'Undo',
      description: 'Undo last action',
      category: 'editing',
      icon: '↩️'
    },
    {
      id: 'redo',
      keys: { mac: ['⌘', '⇧', 'Z'], windows: ['Ctrl', 'Y'], display: 'Cmd+Shift+Z / Ctrl+Y' },
      action: 'Redo',
      description: 'Redo last undone action',
      category: 'editing',
      icon: '↪️'
    },
    {
      id: 'delete',
      keys: { mac: ['Delete'], windows: ['Delete'], display: 'Delete' },
      action: 'Delete',
      description: 'Delete selected clips',
      category: 'editing',
      icon: '🗑️'
    },
    {
      id: 'split',
      keys: { mac: ['⌘', 'B'], windows: ['Ctrl', 'B'], display: 'Cmd/Ctrl + B' },
      action: 'Split Clip',
      description: 'Split clip at playhead',
      category: 'editing',
      icon: '✂️'
    },
    {
      id: 'ripple-delete',
      keys: { mac: ['⇧', 'Delete'], windows: ['Shift', 'Delete'], display: 'Shift + Delete' },
      action: 'Ripple Delete',
      description: 'Delete and close gap',
      category: 'editing',
      icon: '💨'
    },

    // Timeline
    {
      id: 'zoom-in',
      keys: { mac: ['⌘', '+'], windows: ['Ctrl', '+'], display: 'Cmd/Ctrl + Plus' },
      action: 'Zoom In',
      description: 'Zoom in timeline',
      category: 'timeline',
      icon: '🔍'
    },
    {
      id: 'zoom-out',
      keys: { mac: ['⌘', '-'], windows: ['Ctrl', '-'], display: 'Cmd/Ctrl + Minus' },
      action: 'Zoom Out',
      description: 'Zoom out timeline',
      category: 'timeline',
      icon: '🔍'
    },
    {
      id: 'fit-timeline',
      keys: { mac: ['⌘', '0'], windows: ['Ctrl', '0'], display: 'Cmd/Ctrl + 0' },
      action: 'Fit Timeline',
      description: 'Fit entire timeline in view',
      category: 'timeline',
      icon: '📐'
    },
    {
      id: 'toggle-snapping',
      keys: { mac: ['S'], windows: ['S'], display: 'S' },
      action: 'Toggle Snapping',
      description: 'Enable/disable snap to edges',
      category: 'timeline',
      icon: '🧲'
    },

    // Selection
    {
      id: 'select-all',
      keys: { mac: ['⌘', 'A'], windows: ['Ctrl', 'A'], display: 'Cmd/Ctrl + A' },
      action: 'Select All',
      description: 'Select all clips',
      category: 'selection',
      icon: '✅'
    },
    {
      id: 'deselect-all',
      keys: { mac: ['⌘', 'D'], windows: ['Ctrl', 'D'], display: 'Cmd/Ctrl + D' },
      action: 'Deselect All',
      description: 'Clear selection',
      category: 'selection',
      icon: '❌'
    },
    {
      id: 'select-next',
      keys: { mac: ['Tab'], windows: ['Tab'], display: 'Tab' },
      action: 'Select Next',
      description: 'Select next clip',
      category: 'selection',
      icon: '➡️'
    },
    {
      id: 'select-previous',
      keys: { mac: ['⇧', 'Tab'], windows: ['Shift', 'Tab'], display: 'Shift + Tab' },
      action: 'Select Previous',
      description: 'Select previous clip',
      category: 'selection',
      icon: '⬅️'
    },

    // Markers
    {
      id: 'add-marker',
      keys: { mac: ['M'], windows: ['M'], display: 'M' },
      action: 'Add Marker',
      description: 'Add marker at playhead',
      category: 'markers',
      icon: '🚩'
    },
    {
      id: 'next-marker',
      keys: { mac: ['⇧', '→'], windows: ['Shift', '→'], display: 'Shift + →' },
      action: 'Next Marker',
      description: 'Jump to next marker',
      category: 'markers',
      icon: '➡️'
    },
    {
      id: 'prev-marker',
      keys: { mac: ['⇧', '←'], windows: ['Shift', '←'], display: 'Shift + ←' },
      action: 'Previous Marker',
      description: 'Jump to previous marker',
      category: 'markers',
      icon: '⬅️'
    },
    {
      id: 'set-in-point',
      keys: { mac: ['I'], windows: ['I'], display: 'I' },
      action: 'Set In Point',
      description: 'Mark selection start',
      category: 'markers',
      icon: '⏰'
    },
    {
      id: 'set-out-point',
      keys: { mac: ['O'], windows: ['O'], display: 'O' },
      action: 'Set Out Point',
      description: 'Mark selection end',
      category: 'markers',
      icon: '⏱️'
    },

    // View
    {
      id: 'fullscreen',
      keys: { mac: ['F'], windows: ['F'], display: 'F' },
      action: 'Fullscreen',
      description: 'Toggle fullscreen preview',
      category: 'view',
      icon: '🖥️'
    },
    {
      id: 'toggle-sidebar',
      keys: { mac: ['⌘', '\\'], windows: ['Ctrl', '\\'], display: 'Cmd/Ctrl + \\' },
      action: 'Toggle Sidebar',
      description: 'Show/hide sidebar panels',
      category: 'view',
      icon: '📱'
    },
    {
      id: 'toggle-effects',
      keys: { mac: ['E'], windows: ['E'], display: 'E' },
      action: 'Effects Panel',
      description: 'Show/hide effects panel',
      category: 'view',
      icon: '✨'
    },
    {
      id: 'toggle-audio',
      keys: { mac: ['⌘', 'U'], windows: ['Ctrl', 'U'], display: 'Cmd/Ctrl + U' },
      action: 'Audio Waveforms',
      description: 'Toggle audio waveforms',
      category: 'view',
      icon: '🎵'
    },

    // File Operations
    {
      id: 'export',
      keys: { mac: ['⌘', 'E'], windows: ['Ctrl', 'E'], display: 'Cmd/Ctrl + E' },
      action: 'Export Video',
      description: 'Export current project',
      category: 'file',
      icon: '📤'
    },
    {
      id: 'save',
      keys: { mac: ['⌘', 'S'], windows: ['Ctrl', 'S'], display: 'Cmd/Ctrl + S' },
      action: 'Save Project',
      description: 'Save current project',
      category: 'file',
      icon: '💾'
    },
    {
      id: 'save-as',
      keys: { mac: ['⌘', '⇧', 'S'], windows: ['Ctrl', 'Shift', 'S'], display: 'Cmd/Ctrl + Shift + S' },
      action: 'Save As',
      description: 'Save project with new name',
      category: 'file',
      icon: '💾'
    },
    {
      id: 'import',
      keys: { mac: ['⌘', 'I'], windows: ['Ctrl', 'I'], display: 'Cmd/Ctrl + I' },
      action: 'Import Media',
      description: 'Import video/audio files',
      category: 'file',
      icon: '📥'
    },
    {
      id: 'new-project',
      keys: { mac: ['⌘', 'N'], windows: ['Ctrl', 'N'], display: 'Cmd/Ctrl + N' },
      action: 'New Project',
      description: 'Create new project',
      category: 'file',
      icon: '📄'
    },
    {
      id: 'open-project',
      keys: { mac: ['⌘', 'O'], windows: ['Ctrl', 'O'], display: 'Cmd/Ctrl + O' },
      action: 'Open Project',
      description: 'Open existing project',
      category: 'file',
      icon: '📂'
    }
  ];

  constructor() {
    // Listen for keyboard shortcut to show help
    this.setupGlobalListener();
  }

  private detectPlatform(): Platform {
    const userAgent = window.navigator.userAgent.toLowerCase();
    if (userAgent.includes('mac')) return 'mac';
    if (userAgent.includes('win')) return 'windows';
    return 'linux';
  }

  getPlatform(): Platform {
    return this.platform();
  }

  getShortcuts(): KeyboardShortcut[] {
    return this.shortcuts;
  }

  getShortcutsByCategory(): ShortcutGroup[] {
    const groups: ShortcutGroup[] = [];

    this.categories.forEach(category => {
      const categoryShortcuts = this.shortcuts.filter(s => s.category === category.id);
      if (categoryShortcuts.length > 0) {
        groups.push({
          category,
          shortcuts: categoryShortcuts
        });
      }
    });

    return groups.sort((a, b) => a.category.order - b.category.order);
  }

  searchShortcuts(query: string): ShortcutSearchResult[] {
    const normalizedQuery = query.toLowerCase();
    const results: ShortcutSearchResult[] = [];

    this.shortcuts.forEach(shortcut => {
      let matchScore = 0;
      let matchedField: 'action' | 'description' | 'keys' | null = null;

      // Check action
      if (shortcut.action.toLowerCase().includes(normalizedQuery)) {
        matchScore = 100;
        matchedField = 'action';
      }
      // Check description
      else if (shortcut.description?.toLowerCase().includes(normalizedQuery)) {
        matchScore = 70;
        matchedField = 'description';
      }
      // Check keys
      else if (shortcut.keys.display.toLowerCase().includes(normalizedQuery)) {
        matchScore = 50;
        matchedField = 'keys';
      }

      if (matchedField) {
        results.push({
          shortcut,
          matchedField,
          matchScore
        });
      }
    });

    return results.sort((a, b) => b.matchScore - a.matchScore);
  }

  getShortcutById(id: string): KeyboardShortcut | undefined {
    return this.shortcuts.find(s => s.id === id);
  }

  getConfig(): KeyboardShortcutsConfig {
    return this.config();
  }

  updateConfig(config: Partial<KeyboardShortcutsConfig>): void {
    this.config.update(current => ({ ...current, ...config }));
  }

  show(): void {
    this.isVisible.set(true);
  }

  hide(): void {
    this.isVisible.set(false);
  }

  toggle(): void {
    this.isVisible.update(v => !v);
  }

  private setupGlobalListener(): void {
    document.addEventListener('keydown', (event) => {
      // Show shortcuts with ? or Cmd/Ctrl + /
      if (
        event.key === '?' ||
        (event.key === '/' && (event.metaKey || event.ctrlKey))
      ) {
        // Don't trigger if user is typing in an input
        const target = event.target as HTMLElement;
        if (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA') {
          event.preventDefault();
          this.toggle();
        }
      }

      // Hide with Escape
      if (event.key === 'Escape' && this.isVisible()) {
        this.hide();
      }
    });
  }

  formatKeysForPlatform(shortcut: KeyboardShortcut): string {
    const platform = this.platform();
    const keys = platform === 'mac' ? shortcut.keys.mac : shortcut.keys.windows;

    if (platform === 'mac') {
      return keys.map(key => {
        switch(key) {
          case '⌘': return '⌘';
          case '⌥': return '⌥';
          case '⌃': return '⌃';
          case '⇧': return '⇧';
          default: return key;
        }
      }).join('');
    } else {
      return keys.join('+');
    }
  }
}