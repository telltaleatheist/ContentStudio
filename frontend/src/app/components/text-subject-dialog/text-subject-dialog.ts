import { Component, signal } from '@angular/core';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-text-subject-dialog',
  standalone: true,
  imports: [
    MatDialogModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    FormsModule
  ],
  template: `
    <h2 mat-dialog-title>Add Text Subjects</h2>
    <mat-dialog-content>
      <mat-form-field appearance="outline" class="full-width">
        <mat-label>Text Subjects (one per line)</mat-label>
        <textarea
          matInput
          [(ngModel)]="textContent"
          rows="10"
          placeholder=""></textarea>
        <mat-hint>Enter each subject on a separate line</mat-hint>
      </mat-form-field>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button (click)="onCancel()">Cancel</button>
      <button mat-raised-button color="primary" (click)="onSubmit()" [disabled]="!textContent.trim()">
        Add Subjects
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    mat-dialog-content {
      min-width: 500px;
      padding: 20px 24px;
    }

    .full-width {
      width: 100%;
      margin-top: 8px;
    }

    textarea {
      font-family: monospace;
      min-height: 200px;
    }

    mat-dialog-actions {
      padding: 16px 24px;
      gap: 12px;
    }

    mat-form-field {
      margin-bottom: 8px;
    }
  `]
})
export class TextSubjectDialog {
  textContent = '';

  constructor(private dialogRef: MatDialogRef<TextSubjectDialog>) {}

  onCancel(): void {
    this.dialogRef.close();
  }

  onSubmit(): void {
    if (this.textContent.trim()) {
      this.dialogRef.close(this.textContent);
    }
  }
}
