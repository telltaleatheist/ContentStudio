import { Component, EventEmitter, Input, Output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonComponent } from '../button/button.component';

@Component({
  selector: 'app-text-subject-modal',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonComponent],
  template: `
    @if (isOpen()) {
      <div class="modal-backdrop" (click)="close()">
        <div class="modal-content" (click)="$event.stopPropagation()">
          <div class="modal-header">
            <h2>Add Text Subjects</h2>
            <button class="close-btn" (click)="close()">✕</button>
          </div>

          <div class="modal-body">
            <p class="hint">Enter one subject per line. Each line will be added as a separate input item.</p>
            <textarea
              [(ngModel)]="textContent"
              placeholder="Enter subjects here...&#10;&#10;Example:&#10;How to bake a cake&#10;Best travel destinations 2024&#10;Beginner guitar lessons"
              rows="10"
            ></textarea>
          </div>

          <div class="modal-footer">
            <app-button variant="secondary" (click)="close()">Cancel</app-button>
            <app-button variant="primary" (click)="submit()" [disabled]="!textContent.trim()">
              Add Subjects
            </app-button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    @use '../../../styles/variables' as *;

    .modal-backdrop {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      backdrop-filter: blur(4px);
      animation: fadeIn 0.2s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .modal-content {
      background: var(--bg-card);
      border-radius: $radius-lg;
      border: 1px solid var(--border-color);
      box-shadow: $shadow-xl;
      width: 90%;
      max-width: 500px;
      max-height: 80vh;
      display: flex;
      flex-direction: column;
      animation: slideUp 0.2s ease;
    }

    @keyframes slideUp {
      from {
        opacity: 0;
        transform: translateY(20px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: $spacing-lg;
      border-bottom: 1px solid var(--border-color);

      h2 {
        margin: 0;
        font-size: $font-size-xl;
        color: var(--text-primary);
      }

      .close-btn {
        width: 32px;
        height: 32px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        border: none;
        border-radius: $radius-md;
        color: var(--text-tertiary);
        cursor: pointer;
        font-size: $font-size-lg;
        transition: all $transition-base;

        &:hover {
          background: var(--bg-secondary);
          color: var(--text-primary);
        }
      }
    }

    .modal-body {
      padding: $spacing-lg;
      flex: 1;
      overflow-y: auto;

      .hint {
        margin: 0 0 $spacing-md 0;
        font-size: $font-size-sm;
        color: var(--text-secondary);
      }

      textarea {
        width: 100%;
        padding: $spacing-md;
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: $radius-md;
        color: var(--text-primary);
        font-family: inherit;
        font-size: $font-size-base;
        resize: vertical;
        transition: all $transition-base;

        &::placeholder {
          color: var(--text-tertiary);
        }

        &:focus {
          outline: none;
          border-color: var(--primary-orange);
          box-shadow: 0 0 0 2px rgba(255, 107, 53, 0.2);
        }
      }
    }

    .modal-footer {
      display: flex;
      justify-content: flex-end;
      gap: $spacing-md;
      padding: $spacing-lg;
      border-top: 1px solid var(--border-color);
    }
  `]
})
export class TextSubjectModalComponent {
  isOpen = signal(false);
  textContent = '';

  @Output() submitted = new EventEmitter<string>();

  open() {
    this.isOpen.set(true);
    this.textContent = '';
  }

  close() {
    this.isOpen.set(false);
    this.textContent = '';
  }

  submit() {
    if (this.textContent.trim()) {
      this.submitted.emit(this.textContent);
      this.close();
    }
  }
}
