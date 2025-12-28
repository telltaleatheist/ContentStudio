import { Component, EventEmitter, Input, Output, HostListener, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ContextMenuAction, ContextMenuPosition } from '../../models/file.model';

@Component({
  selector: 'app-context-menu',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (visible) {
      <div
        class="context-menu"
        [style.left.px]="position.x"
        [style.top.px]="position.y"
      >
        @for (action of actions; track action.action) {
          @if (action.divider) {
            <div class="context-menu-divider"></div>
          } @else if (action.children && action.children.length > 0) {
            <div
              class="context-menu-item has-submenu"
              [class.disabled]="action.disabled"
              (mouseenter)="openSubmenu(action)"
              (mouseleave)="scheduleCloseSubmenu()"
            >
              <span class="menu-icon">{{ action.icon }}</span>
              <span class="menu-label">{{ action.label }}</span>
              <span class="submenu-arrow">▶</span>

              @if (activeSubmenu() === action) {
                <div
                  class="context-submenu"
                  (mouseenter)="cancelCloseSubmenu()"
                  (mouseleave)="scheduleCloseSubmenu()"
                >
                  @for (child of action.children; track child.action) {
                    @if (child.divider) {
                      <div class="context-menu-divider"></div>
                    } @else {
                      <button
                        class="context-menu-item"
                        [class.disabled]="child.disabled"
                        [disabled]="child.disabled"
                        (click)="onActionClick(child)"
                      >
                        <span class="menu-icon">{{ child.icon }}</span>
                        <span class="menu-label">{{ child.label }}</span>
                      </button>
                    }
                  }
                </div>
              }
            </div>
          } @else {
            <button
              class="context-menu-item"
              [class.disabled]="action.disabled"
              [disabled]="action.disabled"
              (click)="onActionClick(action)"
            >
              <span class="menu-icon">{{ action.icon }}</span>
              <span class="menu-label">{{ action.label }}</span>
            </button>
          }
        }
      </div>
    }
  `,
  styles: [`
    @use '../../../styles/variables' as *;
    @use '../../../styles/mixins' as *;

    .context-menu {
      position: fixed;
      z-index: 9999;
      background: #ffffff;
      border: 1px solid var(--border-color);
      border-radius: $radius-md;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
      min-width: 200px;
      padding: $spacing-xs;
      animation: contextMenuAppear 0.15s ease-out;
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }

    :host-context(.dark-theme) .context-menu,
    :host-context([data-theme="dark"]) .context-menu {
      background: #1a1a1a;
    }

    @keyframes contextMenuAppear {
      from {
        opacity: 0;
        transform: scale(0.95);
      }
      to {
        opacity: 1;
        transform: scale(1);
      }
    }

    .context-menu-item {
      @include flex-center;
      justify-content: flex-start;
      gap: $spacing-sm;
      width: 100%;
      padding: $spacing-sm $spacing-md;
      background: transparent;
      border: none;
      border-radius: $radius-sm;
      color: var(--text-primary);
      font-size: $font-size-sm;
      cursor: pointer;
      transition: all $transition-fast;
      text-align: left;

      &:hover:not(.disabled) {
        background: var(--bg-secondary);
        color: var(--primary-orange);

        .menu-icon {
          transform: scale(1.1);
        }
      }

      &.disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }

    .menu-icon {
      font-size: $font-size-base;
      transition: transform $transition-fast;
    }

    .menu-label {
      flex: 1;
    }

    .context-menu-divider {
      height: 1px;
      background: var(--border-color);
      margin: $spacing-xs 0;
    }

    .has-submenu {
      position: relative;
      display: flex;
      align-items: center;
      gap: $spacing-sm;
      width: 100%;
      padding: $spacing-sm $spacing-md;
      background: transparent;
      border: none;
      border-radius: $radius-sm;
      color: var(--text-primary);
      font-size: $font-size-sm;
      cursor: pointer;
      transition: all $transition-fast;
      text-align: left;

      &:hover:not(.disabled) {
        background: var(--bg-secondary);
        color: var(--primary-orange);
      }
    }

    .submenu-arrow {
      font-size: 8px;
      opacity: 0.5;
      margin-left: auto;
    }

    .context-submenu {
      position: absolute;
      left: 100%;
      top: 0;
      background: #ffffff;
      border: 1px solid var(--border-color);
      border-radius: $radius-md;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
      min-width: 180px;
      max-height: 300px;
      overflow-y: auto;
      padding: $spacing-xs;
      animation: contextMenuAppear 0.15s ease-out;
      margin-left: 4px;
    }

    :host-context(.dark-theme) .context-submenu,
    :host-context([data-theme="dark"]) .context-submenu {
      background: #1a1a1a;
    }
  `]
})
export class ContextMenuComponent {
  @Input() visible = false;
  @Input() position: ContextMenuPosition = { x: 0, y: 0 };
  @Input() actions: ContextMenuAction[] = [];
  @Output() actionSelected = new EventEmitter<string>();
  @Output() closed = new EventEmitter<void>();

  activeSubmenu = signal<ContextMenuAction | null>(null);
  private submenuCloseTimeout: any = null;

  @HostListener('document:click')
  onDocumentClick() {
    if (this.visible) {
      this.close();
    }
  }

  @HostListener('document:contextmenu')
  onDocumentContextMenu() {
    if (this.visible) {
      this.close();
    }
  }

  openSubmenu(action: ContextMenuAction) {
    this.cancelCloseSubmenu();
    this.activeSubmenu.set(action);
  }

  scheduleCloseSubmenu() {
    this.submenuCloseTimeout = setTimeout(() => {
      this.activeSubmenu.set(null);
    }, 150);
  }

  cancelCloseSubmenu() {
    if (this.submenuCloseTimeout) {
      clearTimeout(this.submenuCloseTimeout);
      this.submenuCloseTimeout = null;
    }
  }

  onActionClick(action: ContextMenuAction) {
    if (!action.disabled) {
      this.actionSelected.emit(action.action);
      this.close();
    }
  }

  close() {
    this.visible = false;
    this.activeSubmenu.set(null);
    this.cancelCloseSubmenu();
    this.closed.emit();
  }
}
