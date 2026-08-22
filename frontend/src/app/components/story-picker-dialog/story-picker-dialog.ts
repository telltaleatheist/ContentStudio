import { Component, Inject, computed, signal } from '@angular/core';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatListModule } from '@angular/material/list';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';

import { ElectronService } from '../../services/electron';
import type { TranscriptRef } from '../../features/publish/publish.types';
import type {
  StoryScope,
  TranscriptCandidate,
} from '../../features/transcript-link/transcript-link.types';

export interface StoryPickerDialogData {
  /** The final export being linked, for the title bar. */
  videoName: string;
  /**
   * The week the export lives in, or null when it is not in the week layout — in which
   * case the dialog opens straight at the registered-projects scope, because there is no
   * week to look in.
   */
  week: string | null;
}

export interface StoryPickerDialogResult {
  /** Always recorded as 'manual': the operator chose this one himself. */
  ref: TranscriptRef;
  candidate: TranscriptCandidate;
}

type Phase = 'loading' | 'loaded' | 'error';

/**
 * "Pick a different story…" — ONE dialog with a progressive scope (spec §3.2).
 *
 * Scope widens on request only: the week the export sits in, then every editor project in
 * the registry, then a folder the operator browses to. It widens rather than starting wide
 * because the right answer is in the week ~75% of the time, and a list of every story ever
 * edited is not a list anyone reads.
 *
 * A story whose transcript was never exported is shown, greyed, with "Export it now" —
 * because "it isn't there" and "it doesn't exist" are different problems and only one of
 * them is the operator's to fix by hand.
 */
@Component({
  selector: 'app-story-picker-dialog',
  standalone: true,
  imports: [
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatProgressBarModule,
    MatTooltipModule,
    MatListModule,
    MatFormFieldModule,
    MatInputModule,
    FormsModule,
    CommonModule,
  ],
  template: `
    <h2 mat-dialog-title>Link "{{ data.videoName }}" to an editor story</h2>

    <mat-dialog-content>
      <div class="scope-bar">
        <span class="scope-label">Looking in:</span>
        <button mat-stroked-button
                class="scope-btn"
                [class.active]="scopeKind() === 'week'"
                [disabled]="!data.week"
                [matTooltip]="data.week || 'this video is not inside a week folder'"
                (click)="useWeekScope()">
          This week
        </button>
        <button mat-stroked-button
                class="scope-btn"
                [class.active]="scopeKind() === 'registered-projects'"
                matTooltip="Every project in the editor's registry"
                (click)="useRegisteredScope()">
          All projects
        </button>
        <button mat-stroked-button
                class="scope-btn"
                [class.active]="scopeKind() === 'project'"
                matTooltip="Browse to an editor project folder"
                (click)="browseForProject()">
          Browse…
        </button>
      </div>

      <div class="scope-detail">{{ scopeDetail() }}</div>

      @if (phase() === 'loading') {
        <mat-progress-bar mode="indeterminate"></mat-progress-bar>
        <p class="hint">Reading stories…</p>
      }

      @if (phase() === 'error') {
        <div class="problem-box">
          <mat-icon>error_outline</mat-icon>
          <span>{{ errorText() }}</span>
        </div>
      }

      @if (phase() === 'loaded') {
        <mat-form-field appearance="outline" class="filter-field">
          <mat-label>Filter</mat-label>
          <input matInput [ngModel]="filter()" (ngModelChange)="filter.set($event)"
                 placeholder="story title or session">
        </mat-form-field>

        @if (visible().length === 0) {
          <p class="hint">No stories here match. Widen the scope above, or clear the filter.</p>
        }

        <mat-list class="story-list">
          @for (c of visible(); track c.transcriptPath) {
            <div class="story-row"
                 [class.unavailable]="!c.ref"
                 [class.chosen]="chosenPath() === c.transcriptPath">
              <div class="story-main" (click)="choose(c)">
                <div class="story-title">{{ c.storyTitle }}</div>
                <div class="story-meta">
                  session {{ c.sourceSession }} &middot; story {{ c.storyNumber }}
                  @if (c.ref) {
                    &middot; {{ c.wordCount }} words &middot; {{ minutes(c.durationSeconds) }}
                  } @else {
                    &middot; <span class="missing-note">{{ c.refUnavailableReason }}</span>
                  }
                </div>
              </div>

              @if (canExport(c)) {
                <button mat-stroked-button
                        class="export-btn"
                        [disabled]="exportingFolder() !== null"
                        [matTooltip]="c.compoundsZipPath
                          ? 'Run the editor\\'s story-transcript export for this project now'
                          : 'This project has no compounds zip — open it in the editor instead'"
                        (click)="exportNow(c)">
                  @if (exportingFolder() === c.projectFolder) {
                    Exporting…
                  } @else {
                    Export it now
                  }
                </button>
              }
            </div>
          }
        </mat-list>

        @if (problems().length > 0) {
          <div class="problem-box">
            <mat-icon>info_outline</mat-icon>
            <span>
              @for (p of problems(); track p) {
                <div>{{ p }}</div>
              }
            </span>
          </div>
        }
      }
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button (click)="dialogRef.close()">Cancel</button>
      <button mat-raised-button color="primary"
              [disabled]="!chosen()?.ref"
              (click)="confirm()">
        Link this story
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    mat-dialog-content { min-width: 720px; max-width: 860px; }

    .scope-bar { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem; }
    .scope-label { color: rgba(255,255,255,0.6); font-size: 0.85rem; }
    .scope-btn {
      color: #fff;
      background: rgba(255,255,255,0.10);
      border-color: rgba(255,255,255,0.20);
      --mdc-outlined-button-label-text-color: #fff;
      --mdc-outlined-button-outline-color: rgba(255,255,255,0.20);
    }
    .scope-btn.active {
      background: var(--primary-orange);
      border-color: var(--primary-orange);
      --mdc-outlined-button-outline-color: var(--primary-orange);
    }

    .scope-detail {
      color: rgba(255,255,255,0.55);
      font-size: 0.78rem;
      margin-bottom: 0.75rem;
      word-break: break-all;
    }

    .hint { color: rgba(255,255,255,0.6); font-size: 0.85rem; }
    .filter-field { width: 100%; }

    .story-list { max-height: 46vh; overflow-y: auto; }

    .story-row {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.5rem 0.6rem;
      border-radius: 6px;
      border: 1px solid transparent;
    }
    .story-row:hover { background: rgba(255,255,255,0.06); }
    .story-row.chosen {
      background: rgba(255,107,53,0.12);
      border-color: var(--primary-orange);
    }
    .story-row.unavailable .story-main { opacity: 0.55; cursor: not-allowed; }

    .story-main { flex: 1 1 auto; cursor: pointer; min-width: 0; }
    .story-title { color: #fff; font-size: 0.92rem; }
    .story-meta { color: rgba(255,255,255,0.55); font-size: 0.78rem; }
    .missing-note { color: #ffca28; }

    .export-btn { flex-shrink: 0; }

    .problem-box {
      display: flex;
      align-items: flex-start;
      gap: 0.5rem;
      margin-top: 0.75rem;
      padding: 0.6rem;
      border-radius: 6px;
      background: rgba(255, 202, 40, 0.10);
      border: 1px solid rgba(255, 202, 40, 0.35);
      color: #eee;
      font-size: 0.8rem;
      line-height: 1.4;
      word-break: break-word;
    }
    .problem-box mat-icon { color: #ffca28; flex-shrink: 0; font-size: 20px; width: 20px; height: 20px; }
  `],
})
export class StoryPickerDialog {
  phase = signal<Phase>('loading');
  errorText = signal('');
  candidates = signal<TranscriptCandidate[]>([]);
  problems = signal<string[]>([]);
  filter = signal('');
  scope = signal<StoryScope>({ kind: 'registered-projects' });
  chosenPath = signal<string | null>(null);
  exportingFolder = signal<string | null>(null);

  scopeKind = computed(() => this.scope().kind);

  scopeDetail = computed(() => {
    const s = this.scope();
    if (s.kind === 'week') return s.week;
    if (s.kind === 'project') return s.projectFolder;
    return 'every project registered in the editor';
  });

  visible = computed(() => {
    const needle = this.filter().trim().toLowerCase();
    const all = this.candidates();
    if (!needle) return all;
    return all.filter(c =>
      c.storyTitle.toLowerCase().includes(needle) ||
      c.sourceSession.toLowerCase().includes(needle));
  });

  chosen = computed(() =>
    this.candidates().find(c => c.transcriptPath === this.chosenPath()) || null);

  constructor(
    public dialogRef: MatDialogRef<StoryPickerDialog, StoryPickerDialogResult>,
    private electron: ElectronService,
    @Inject(MAT_DIALOG_DATA) public data: StoryPickerDialogData,
  ) {
    // Start at the narrowest scope that can hold the answer. Only a video outside the week
    // layout starts wide, because for it there is no week to start in.
    if (this.data.week) {
      this.scope.set({ kind: 'week', week: this.data.week });
    }
    this.load();
  }

  useWeekScope(): void {
    if (!this.data.week) return;
    this.scope.set({ kind: 'week', week: this.data.week });
    this.load();
  }

  useRegisteredScope(): void {
    this.scope.set({ kind: 'registered-projects' });
    this.load();
  }

  async browseForProject(): Promise<void> {
    const picked = await this.electron.selectDirectory();
    if (!picked.success) {
      // The picker could not be shown at all. Distinct from the operator cancelling, and
      // it must not look like nothing happened.
      this.problems.set([...this.problems(), 'The folder picker could not be opened.']);
      return;
    }
    // Cancelled: the scope stays exactly where it was. Not an error, not a reason to widen.
    if (!picked.directory) return;
    this.scope.set({ kind: 'project', projectFolder: picked.directory });
    this.load();
  }

  private async load(): Promise<void> {
    this.phase.set('loading');
    this.candidates.set([]);
    this.problems.set([]);
    this.chosenPath.set(null);

    const res = await this.electron.transcriptListStories(this.scope());
    if (!res.success) {
      this.errorText.set(res.error || 'the story list could not be read');
      this.phase.set('error');
      return;
    }
    // Newest session first, then story order — the way the operator thinks about them.
    const list = [...res.data.candidates].sort((a, b) =>
      b.sourceSession.localeCompare(a.sourceSession) || a.storyNumber - b.storyNumber);
    this.candidates.set(list);
    this.problems.set(res.data.problems || []);
    this.phase.set('loaded');
  }

  choose(c: TranscriptCandidate): void {
    // Gate on `ref`, not on `transcriptExists`: a transcript that is present but malformed
    // exists and still cannot be linked. Nothing is substituted for it — the row states
    // why, and offers the export only when re-exporting is actually the remedy.
    if (!c.ref) return;
    this.chosenPath.set(c.transcriptPath);
  }

  /** Would re-running the export fix this candidate? Only if it was never written. */
  canExport(c: TranscriptCandidate): boolean {
    return !c.transcriptExists;
  }

  async exportNow(c: TranscriptCandidate): Promise<void> {
    if (this.exportingFolder()) return;
    if (!c.compoundsZipPath) {
      this.problems.set([
        ...this.problems(),
        `${c.projectFolder} has no <session>_compounds.zip, so its story transcripts cannot ` +
        `be exported from here — open the project in the editor.`,
      ]);
      return;
    }

    this.exportingFolder.set(c.projectFolder);
    const res = await this.electron.transcriptExportStories(c.projectFolder);
    this.exportingFolder.set(null);

    if (!res.success) {
      this.problems.set([...this.problems(), `Export failed: ${res.error}`]);
      return;
    }
    // Re-read the scope rather than patching the row: the export wrote every story in that
    // session, so several rows just changed.
    await this.load();
    this.chosenPath.set(c.transcriptPath);
  }

  minutes(seconds: number | null): string {
    if (seconds === null || seconds === undefined) return '—';
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}m ${String(s).padStart(2, '0')}s`;
  }

  confirm(): void {
    const c = this.chosen();
    if (!c || !c.ref) return;
    // 'manual' on purpose: the operator navigated to this story himself, so how the FINDER
    // would have described it is not how this link was made.
    this.dialogRef.close({ ref: { ...c.ref, via: 'manual', linkedAt: new Date().toISOString() }, candidate: c });
  }
}
