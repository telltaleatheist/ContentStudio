import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { KeyboardShortcutsService } from '../../services/keyboard-shortcuts.service';

@Component({
  selector: 'app-keyboard-shortcuts',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './keyboard-shortcuts.component.html',
  styleUrls: ['./keyboard-shortcuts.component.scss']
})
export class KeyboardShortcutsComponent {
  private shortcutsService = inject(KeyboardShortcutsService);

  // Service data
  isVisible = this.shortcutsService.isVisible;
  platform = this.shortcutsService.getPlatform();

  show(): void {
    this.shortcutsService.show();
  }

  hide(): void {
    this.shortcutsService.hide();
  }

  // Handle keyboard navigation within the panel
  handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      this.hide();
    }
  }
}
