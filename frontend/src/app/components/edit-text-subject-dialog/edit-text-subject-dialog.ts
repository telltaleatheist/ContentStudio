import { Component, Inject } from '@angular/core';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { FormsModule } from '@angular/forms';

export interface EditTextSubjectData {
  title: string;
  description: string;
}

@Component({
  selector: 'app-edit-text-subject-dialog',
  standalone: true,
  imports: [
    MatDialogModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    FormsModule
  ],
  template: `
    <h2 mat-dialog-title>Edit Text Subject</h2>
    <mat-dialog-content>
      <mat-form-field appearance="outline" class="full-width">
        <mat-label>Title</mat-label>
        <input matInput [(ngModel)]="data.title" placeholder="Subject title">
      </mat-form-field>

      <mat-form-field appearance="outline" class="full-width">
        <mat-label>Description / Content</mat-label>
        <textarea
          matInput
          [(ngModel)]="data.description"
          rows="12"
          placeholder="The text content that will be used for metadata generation"></textarea>
        <mat-hint>This text will be analyzed by the AI to generate metadata</mat-hint>
      </mat-form-field>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button (click)="onCancel()">Cancel</button>
      <button mat-raised-button color="primary" (click)="onSave()" [disabled]="!data.title.trim()">
        Save
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    mat-dialog-content {
      min-width: 550px;
      padding: 20px 24px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .full-width {
      width: 100%;
    }

    textarea {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-height: 200px;
      line-height: 1.5;
    }

    mat-dialog-actions {
      padding: 16px 24px;
      gap: 12px;
    }

    h2[mat-dialog-title] {
      margin-bottom: 0;
    }
  `]
})
export class EditTextSubjectDialog {
  constructor(
    private dialogRef: MatDialogRef<EditTextSubjectDialog>,
    @Inject(MAT_DIALOG_DATA) public data: EditTextSubjectData
  ) {}

  onCancel(): void {
    this.dialogRef.close();
  }

  onSave(): void {
    if (this.data.title.trim()) {
      this.dialogRef.close(this.data);
    }
  }
}
