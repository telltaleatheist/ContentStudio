import { Component, Inject } from '@angular/core';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { NotificationService } from '../../services/notification';

export interface PromptViewDialogData {
  prompt: string;
  jobName: string;
}

@Component({
  selector: 'app-prompt-view-dialog',
  standalone: true,
  imports: [
    MatDialogModule,
    MatButtonModule
  ],
  template: `
    <h2 mat-dialog-title>Prompt — {{ data.jobName }}</h2>
    <mat-dialog-content>
      <p class="dialog-hint">
        This is the exact prompt that will be sent to the AI when you start the queue.
        Nothing has been sent yet.
      </p>
      <pre class="prompt-text">{{ data.prompt }}</pre>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button (click)="onClose()">Close</button>
      <button mat-raised-button color="primary" (click)="onCopy()">Copy</button>
    </mat-dialog-actions>
  `,
  styles: [`
    mat-dialog-content {
      width: 100%;
    }

    .dialog-hint {
      color: rgba(255, 255, 255, 0.6);
      font-size: 14px;
      margin-bottom: 12px;
    }

    .prompt-text {
      margin: 0;
      padding: 12px 14px;
      background: rgba(0, 0, 0, 0.28);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 6px;
      font-family: 'Roboto Mono', 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
      font-size: 12.5px;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
      overflow: auto;
      max-height: 60vh;
    }
  `]
})
export class PromptViewDialog {
  constructor(
    public dialogRef: MatDialogRef<PromptViewDialog>,
    @Inject(MAT_DIALOG_DATA) public data: PromptViewDialogData,
    private notificationService: NotificationService
  ) {}

  onCopy(): void {
    navigator.clipboard.writeText(this.data.prompt).then(() => {
      this.notificationService.success('Copied', 'Prompt copied to clipboard', false);
    }).catch(err => {
      this.notificationService.error('Copy Failed', 'Failed to copy to clipboard: ' + err.message);
    });
  }

  onClose(): void {
    this.dialogRef.close();
  }
}
