import { Component, Inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

export interface MasterSection {
  startTimestamp: string;
  endTimestamp: string;
  startSeconds: number;
  endSeconds: number;
  title: string;
  description: string;
  startPhrase: string;
}

export interface MasterReport {
  masterVideoPath: string;
  masterVideoName: string;
  totalDuration: string;
  totalDurationSeconds: number;
  analyzedAt: string;
  sectionCount: number;
  sections: MasterSection[];
}

export interface MasterReportDialogData {
  report: MasterReport;
  reportPath: string;
}

export interface MasterReportDialogResult {
  selectedSections: MasterSection[];
}

@Component({
  selector: 'app-master-report-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatCheckboxModule,
    MatIconModule,
    MatTooltipModule
  ],
  template: `
    <h2 mat-dialog-title>
      <mat-icon>analytics</mat-icon>
      Master Analysis Results
    </h2>
    <mat-dialog-content>
      <div class="report-header">
        <div class="video-info">
          <strong>{{ data.report.masterVideoName }}</strong>
          <span class="duration">{{ data.report.totalDuration }}</span>
        </div>
        <div class="section-count">
          {{ data.report.sectionCount }} sections detected
        </div>
      </div>

      <div class="sections-list">
        @for (section of data.report.sections; track section.startTimestamp; let i = $index) {
          <div class="section-item" [class.selected]="selectedIndexes().has(i)">
            <mat-checkbox
              [checked]="selectedIndexes().has(i)"
              (change)="toggleSection(i)"
              color="primary">
            </mat-checkbox>
            <div class="section-content" (click)="toggleSection(i)">
              <div class="section-header">
                <span class="timestamp">{{ section.startTimestamp }} - {{ section.endTimestamp }}</span>
                <span class="title">{{ section.title }}</span>
              </div>
              <div class="section-description">
                {{ section.description }}
              </div>
            </div>
          </div>
        }
      </div>

      <div class="selection-summary">
        {{ selectedIndexes().size }} of {{ data.report.sectionCount }} sections selected
      </div>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button (click)="selectAll()">Select All</button>
      <button mat-button (click)="selectNone()">Select None</button>
      <button mat-button (click)="onCancel()">Cancel</button>
      <button mat-raised-button color="primary" (click)="onSubmit()" [disabled]="selectedIndexes().size === 0">
        Add {{ selectedIndexes().size }} as Subjects
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    h2[mat-dialog-title] {
      display: flex;
      align-items: center;
      gap: 8px;

      mat-icon {
        color: var(--primary-color);
      }
    }

    mat-dialog-content {
      min-width: 600px;
      max-width: 800px;
      max-height: 70vh;
      padding: 16px 24px;
    }

    .report-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border-color);
    }

    .video-info {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .duration {
      font-size: 0.9em;
      opacity: 0.7;
    }

    .section-count {
      font-size: 0.9em;
      opacity: 0.7;
    }

    .sections-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-height: 400px;
      overflow-y: auto;
    }

    .section-item {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 12px;
      border: 1px solid var(--border-color);
      border-radius: 8px;
      cursor: pointer;
      transition: background-color 0.2s, border-color 0.2s;

      &:hover {
        background-color: var(--hover-bg);
      }

      &.selected {
        border-color: var(--primary-color);
        background-color: rgba(255, 107, 53, 0.05);
      }
    }

    .section-content {
      flex: 1;
      min-width: 0;
    }

    .section-header {
      display: flex;
      gap: 12px;
      align-items: baseline;
      margin-bottom: 8px;
    }

    .timestamp {
      font-family: monospace;
      font-size: 0.85em;
      color: var(--primary-color);
      white-space: nowrap;
    }

    .title {
      font-weight: 500;
      flex: 1;
    }

    .section-description {
      font-size: 0.9em;
      opacity: 0.8;
      line-height: 1.4;
    }

    .selection-summary {
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--border-color);
      text-align: right;
      font-size: 0.9em;
      opacity: 0.7;
    }

    mat-dialog-actions {
      padding: 16px 24px;
      gap: 8px;
    }
  `]
})
export class MasterReportDialog {
  selectedIndexes = signal<Set<number>>(new Set());

  constructor(
    private dialogRef: MatDialogRef<MasterReportDialog>,
    @Inject(MAT_DIALOG_DATA) public data: MasterReportDialogData
  ) {
    // Select all sections by default
    const allIndexes = new Set<number>();
    for (let i = 0; i < data.report.sections.length; i++) {
      allIndexes.add(i);
    }
    this.selectedIndexes.set(allIndexes);
  }

  toggleSection(index: number): void {
    this.selectedIndexes.update(set => {
      const newSet = new Set(set);
      if (newSet.has(index)) {
        newSet.delete(index);
      } else {
        newSet.add(index);
      }
      return newSet;
    });
  }

  selectAll(): void {
    const allIndexes = new Set<number>();
    for (let i = 0; i < this.data.report.sections.length; i++) {
      allIndexes.add(i);
    }
    this.selectedIndexes.set(allIndexes);
  }

  selectNone(): void {
    this.selectedIndexes.set(new Set());
  }

  onCancel(): void {
    this.dialogRef.close();
  }

  onSubmit(): void {
    const selectedSections = this.data.report.sections.filter((_, i) =>
      this.selectedIndexes().has(i)
    );
    this.dialogRef.close({ selectedSections } as MasterReportDialogResult);
  }
}
