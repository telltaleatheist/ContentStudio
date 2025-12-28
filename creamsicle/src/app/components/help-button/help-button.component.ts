import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { KeyboardShortcutsService } from '../../services/keyboard-shortcuts.service';

@Component({
  selector: 'app-help-button',
  standalone: true,
  imports: [CommonModule],
  template: `
    <button
      class="help-button"
      [class.pulse]="showPulse"
      (click)="toggleShortcuts()"
      title="Keyboard Shortcuts (?)">
      <span class="button-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="5" y="11" width="14" height="10" rx="2" ry="2"></rect>
          <line x1="9" y1="9" x2="9" y2="11"></line>
          <line x1="15" y1="9" x2="15" y2="11"></line>
          <rect x="2" y="9" width="20" height="5" rx="1"></rect>
        </svg>
      </span>
      <span class="button-text">Shortcuts</span>
      <kbd class="shortcut-hint">?</kbd>
    </button>
  `,
  styles: [`
    @use '../../../styles/variables' as *;
    @use '../../../styles/mixins' as *;

    .help-button {
      position: fixed;
      bottom: $spacing-xl;
      right: $spacing-xl;
      display: flex;
      align-items: center;
      gap: $spacing-sm;
      padding: $spacing-md $spacing-lg;
      background: $gradient-sunset;
      color: white;
      border: none;
      border-radius: $radius-full;
      box-shadow: $shadow-lg;
      font-size: $font-size-base;
      font-weight: $font-weight-semibold;
      cursor: pointer;
      transition: all $transition-fast;
      z-index: 1000;

      &:hover {
        transform: translateY(-4px);
        box-shadow: 0 20px 40px -10px rgba(255, 107, 53, 0.5);

        .button-icon {
          animation: wiggle 0.5s ease;
        }
      }

      &.pulse {
        animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
      }

      .button-icon {
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .button-text {
        @media (max-width: $breakpoint-md) {
          display: none;
        }
      }

      .shortcut-hint {
        padding: 2px 6px;
        background: rgba(255, 255, 255, 0.2);
        border: 1px solid rgba(255, 255, 255, 0.3);
        border-radius: $radius-sm;
        font-family: 'SF Mono', 'Monaco', 'Inconsolata', monospace;
        font-size: $font-size-xs;
        font-weight: $font-weight-bold;
      }
    }

    // Alternative styles for embedding in toolbar
    :host-context(.toolbar) .help-button {
      position: static;
      padding: $spacing-sm $spacing-md;
      background: var(--bg-secondary);
      color: var(--text-primary);
      border: 2px solid var(--border-color);
      box-shadow: none;

      &:hover {
        background: var(--bg-input);
        border-color: $primary-orange;
        transform: none;
        box-shadow: none;
      }

      .shortcut-hint {
        background: var(--bg-tertiary);
        border-color: var(--border-color);
        color: $primary-orange;
      }
    }

    @keyframes wiggle {
      0%, 100% { transform: rotate(0deg); }
      25% { transform: rotate(-10deg); }
      75% { transform: rotate(10deg); }
    }

    @keyframes pulse {
      0%, 100% {
        opacity: 1;
      }
      50% {
        opacity: 0.8;
        transform: scale(1.05);
      }
    }

    @media (max-width: $breakpoint-md) {
      .help-button {
        bottom: $spacing-md;
        right: $spacing-md;
        width: 56px;
        height: 56px;
        padding: 0;
        justify-content: center;

        .shortcut-hint {
          display: none;
        }
      }
    }
  `]
})
export class HelpButtonComponent {
  private shortcutsService = inject(KeyboardShortcutsService);
  showPulse = true;

  toggleShortcuts(): void {
    this.shortcutsService.toggle();
    this.showPulse = false; // Stop pulsing after first click

    // Save that user has seen the button
    localStorage.setItem('shortcuts-help-seen', 'true');
  }

  ngOnInit(): void {
    // Don't pulse if user has already seen it
    if (localStorage.getItem('shortcuts-help-seen')) {
      this.showPulse = false;
    }
  }
}