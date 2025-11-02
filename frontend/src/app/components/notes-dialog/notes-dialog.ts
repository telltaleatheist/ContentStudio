import { Component, Inject } from '@angular/core';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { FormsModule } from '@angular/forms';

export interface NotesDialogData {
  itemName: string;
  notes: string;
}

@Component({
  selector: 'app-notes-dialog',
  standalone: true,
  imports: [
    MatDialogModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    FormsModule
  ],
  template: `
    <h2 mat-dialog-title>Notes for {{ data.itemName }}</h2>
    <mat-dialog-content>
      <p class="dialog-hint">
        Add custom instructions or notes for the AI to consider when generating metadata for this item.
        For example: "focus on tax fraud" or "mention controversial statements"
      </p>
      <mat-form-field appearance="outline" class="notes-field">
        <mat-label>Notes / Instructions</mat-label>
        <textarea
          matInput
          [(ngModel)]="data.notes"
          placeholder="e.g., Focus on the tax fraud case, include references to specific court dates..."
          rows="6"
          cdkTextareaAutosize
          #autosize="cdkTextareaAutosize"></textarea>
        <mat-hint>These notes will be sent to the AI along with the content</mat-hint>
      </mat-form-field>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button (click)="onCancel()">Cancel</button>
      <button mat-button (click)="onClear()" color="warn" [disabled]="!data.notes">Clear Notes</button>
      <button mat-raised-button color="primary" (click)="onSave()">Save</button>
    </mat-dialog-actions>
  `,
  styles: [`
    mat-dialog-content {
      min-width: 500px;
      max-width: 600px;
    }

    .dialog-hint {
      color: rgba(255, 255, 255, 0.6);
      font-size: 14px;
      margin-bottom: 16px;
    }

    .notes-field {
      width: 100%;
    }

    textarea {
      font-family: 'Roboto', sans-serif;
      line-height: 1.5;
    }
  `]
})
export class NotesDialog {
  constructor(
    public dialogRef: MatDialogRef<NotesDialog>,
    @Inject(MAT_DIALOG_DATA) public data: NotesDialogData
  ) {}

  onSave(): void {
    this.dialogRef.close(this.data.notes);
  }

  onCancel(): void {
    this.dialogRef.close();
  }

  onClear(): void {
    this.data.notes = '';
    this.dialogRef.close('');
  }
}
