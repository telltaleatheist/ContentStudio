import { Component, Inject, signal } from '@angular/core';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatChipsModule } from '@angular/material/chips';
import { MatListModule } from '@angular/material/list';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import {
  ElectronService,
  TranscriptChapter,
  TranscriptSplitCut,
} from '../../services/electron';

export interface SplitReviewDialogData {
  filePath: string;
  title: string; // item display name (shown immediately)
}

export interface SplitReviewDialogResult {
  cuts: TranscriptSplitCut[];
}

type Phase = 'idle' | 'analyzing' | 'loaded' | 'error';

/** A story = a contiguous run of chapters [start..end] (0-based, inclusive).
 *  start < 0 means the story is empty (no chapters chosen yet). The name
 *  defaults to the first chapter's label unless the user renames it. */
interface Story {
  start: number;
  end: number;
  name: string;
  renamed: boolean;
}

@Component({
  selector: 'app-split-review-dialog',
  standalone: true,
  imports: [
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatProgressBarModule,
    MatTooltipModule,
    MatChipsModule,
    MatListModule,
    MatFormFieldModule,
    MatInputModule,
    FormsModule,
    CommonModule,
  ],
  template: `
    <h2 mat-dialog-title>Split "{{ displayTitle() }}"</h2>
    <mat-dialog-content>

      @if (phase() === 'idle') {
        <div class="run-panel">
          <p class="dialog-hint">
            Analyze this transcript to find its chapters (subject changes). Then group
            consecutive chapters into stories — each story becomes its own queue item.
          </p>
          <button mat-flat-button color="primary" (click)="runAnalysis()">
            <mat-icon>auto_awesome</mat-icon>
            Analyze transcript
          </button>
        </div>
      }

      @if (phase() === 'analyzing') {
        <div class="analyzing">
          <mat-progress-bar mode="indeterminate"></mat-progress-bar>
          <span>Scanning the transcript for chapters… this can take a minute.</span>
        </div>
      }

      @if (phase() === 'error') {
        <p class="detect-error">{{ error() }}</p>
        <button mat-stroked-button (click)="runAnalysis()">
          <mat-icon>refresh</mat-icon> Try again
        </button>
      }

      @if (phase() === 'loaded') {
        <p class="dialog-hint">
          Add a story, click it, then click chapters to add them to it. A story's chapters
          must be <b>consecutive</b>, but you can leave off-subject chapters out entirely.
          Start another story after any gap.
        </p>

        <!-- Stories -->
        <div class="stories-bar">
          <mat-chip-set>
            @for (s of stories(); track $index) {
              <mat-chip
                [highlighted]="$index === activeIndex()"
                (click)="selectStory($index)"
                [matTooltip]="storyChapterCount($index) + ' chapters'">
                <span class="chip-badge" matChipAvatar [style.background]="storyColor($index + 1)">{{ $index + 1 }}</span>
                {{ storyName($index) }} · {{ storyChapterCount($index) }} ch
                <button matChipRemove (click)="removeStory($index)" aria-label="Remove story">
                  <mat-icon>cancel</mat-icon>
                </button>
              </mat-chip>
            }
          </mat-chip-set>
          <button mat-stroked-button class="add-story"
                  [disabled]="!canAddStory()"
                  (click)="addStory()">
            <mat-icon>add</mat-icon> New story
          </button>
        </div>

        @if (activeStory(); as active) {
          <mat-form-field appearance="outline" class="name-field" subscriptSizing="dynamic">
            <mat-label>Story {{ activeIndex() + 1 }} name</mat-label>
            <input matInput [ngModel]="storyName(activeIndex())" (ngModelChange)="renameActive($event)"
                   placeholder="Named after the first chapter" />
          </mat-form-field>
        }

        <div class="status-line">
          <span>{{ chapters().length }} chapters · {{ formatDuration(duration()) }}</span>
          <span class="sep">·</span>
          @if (excludedCount() > 0) {
            <span class="excluded">{{ excludedCount() }} excluded</span>
          } @else {
            <span>none excluded</span>
          }
        </div>

        <!-- Chapter list -->
        <mat-list class="chapter-list">
          @for (c of chapters(); track c.index; let i = $index) {
            <mat-list-item
              class="chapter-item"
              [class.assigned]="storyOf(i) >= 0"
              [class.clickable]="canClick(i)"
              (click)="clickChapter(i)"
              [matTooltip]="storyOf(i) >= 0 ? 'In story ' + (storyOf(i) + 1) + ' — click to remove' : (canClick(i) ? 'Click to add to the active story' : 'Not selectable for the active story')">
              <span matListItemAvatar class="ch-badge"
                    [style.background]="storyOf(i) >= 0 ? storyColor(storyOf(i) + 1) : 'transparent'"
                    [style.borderColor]="storyOf(i) >= 0 ? storyColor(storyOf(i) + 1) : 'rgba(255,255,255,0.25)'">
                {{ storyOf(i) >= 0 ? storyOf(i) + 1 : '' }}
              </span>
              <span matListItemTitle>{{ c.label }}</span>
              <span matListItemLine class="ch-meta">
                Ch {{ c.index }} · {{ c.timestamp }} · {{ formatDuration(c.endSeconds - c.startSeconds) }}
                @if (c.verbalCue) { · <span class="cue">cue</span> }
              </span>
            </mat-list-item>
          }
        </mat-list>
      }
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      @if (phase() === 'loaded') {
        <button mat-button (click)="startOver()">Start over</button>
      }
      <button mat-button (click)="onCancel()">Cancel</button>
      <button mat-flat-button color="accent"
              [disabled]="!canConfirm()"
              (click)="onConfirm()">
        <mat-icon>done_all</mat-icon>
        Create {{ validStoryCount() }} storie{{ validStoryCount() === 1 ? '' : 's' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    mat-dialog-content { min-width: 640px; max-width: 840px; }
    .dialog-hint { color: rgba(255,255,255,0.65); font-size: 14px; margin-bottom: 16px; }
    .run-panel { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; padding: 12px 0; }
    .analyzing { display: flex; flex-direction: column; gap: 8px; margin: 24px 0; }
    .analyzing span { color: rgba(255,255,255,0.7); font-size: 13px; }
    .detect-error { color: #ff6b6b; font-size: 14px; margin: 8px 0 12px; }

    .stories-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 8px; }
    .chip-badge { display: inline-flex; align-items: center; justify-content: center;
      color: #fff; font-weight: 700; font-size: 12px; }
    .name-field { width: 260px; margin: 4px 0 8px; }

    .status-line { display: flex; align-items: center; gap: 8px; font-size: 12px;
      color: rgba(255,255,255,0.6); margin: 4px 0 8px; }
    .status-line .excluded { color: #ffca28; }
    .status-line .sep { opacity: 0.4; }

    .chapter-list { max-height: 360px; overflow-y: auto; padding: 0; }
    .chapter-item { border-radius: 6px; margin: 2px 0; cursor: default; }
    .chapter-item.clickable { cursor: pointer; }
    .chapter-item.clickable:hover { background: rgba(255,255,255,0.06); }
    .chapter-item.assigned { background: rgba(255,255,255,0.05); }
    .ch-badge { display: inline-flex !important; align-items: center; justify-content: center;
      width: 28px; height: 28px; border-radius: 50%; border: 1px solid; color: #fff;
      font-size: 12px; font-weight: 700; }
    .ch-meta { color: rgba(255,255,255,0.55); }
    .ch-meta .cue { color: #ffca28; text-transform: uppercase; font-size: 11px; }
  `]
})
export class SplitReviewDialog {
  phase = signal<Phase>('idle');
  error = signal<string>('');
  displayTitle = signal<string>('');
  duration = signal<number>(0);
  chapters = signal<TranscriptChapter[]>([]);

  stories = signal<Story[]>([]);
  activeIndex = signal<number>(-1);

  private readonly PALETTE = ['#ff6b35', '#43a047', '#6783f4', '#e5679a', '#26a69a', '#ab47bc', '#f9a825', '#8d6e63'];

  constructor(
    public dialogRef: MatDialogRef<SplitReviewDialog, SplitReviewDialogResult>,
    @Inject(MAT_DIALOG_DATA) public data: SplitReviewDialogData,
    private electron: ElectronService,
  ) {
    this.displayTitle.set(data.title || 'transcript');
  }

  // ---- detection ----
  async runAnalysis() {
    this.phase.set('analyzing');
    this.error.set('');
    try {
      const result = await this.electron.analyzeTranscriptSplit(this.data.filePath);
      if (result.success && result.chapters && result.chapters.length > 0) {
        if (result.title) this.displayTitle.set(result.title);
        if (result.durationSeconds) this.duration.set(result.durationSeconds);
        this.chapters.set(result.chapters);
        this.resetStories();
        this.phase.set('loaded');
      } else {
        this.error.set(result.error || 'No chapters were detected in this transcript.');
        this.phase.set('error');
      }
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
      this.phase.set('error');
    }
  }

  // ---- story building ----
  private resetStories() {
    this.stories.set([{ start: -1, end: -1, name: '', renamed: false }]);
    this.activeIndex.set(0);
  }

  startOver() { this.resetStories(); }

  activeStory(): Story | undefined {
    const k = this.activeIndex();
    return k >= 0 ? this.stories()[k] : undefined;
  }

  selectStory(k: number) { this.activeIndex.set(k); }

  // Effective display name: the user's rename if set, else the first chapter's
  // label (so stories are named by their content, avoiding "Part N" collisions).
  storyName(k: number): string {
    const s = this.stories()[k];
    if (!s) return '';
    if (s.renamed && s.name.trim()) return s.name;
    if (s.start >= 0) return this.chapters()[s.start]?.label || `Story ${k + 1}`;
    return `Story ${k + 1}`;
  }

  storyChapterCount(k: number): number {
    const s = this.stories()[k];
    return s && s.start >= 0 ? s.end - s.start + 1 : 0;
  }

  validStoryCount(): number { return this.stories().filter(s => s.start >= 0).length; }

  excludedCount(): number {
    const assigned = this.stories().reduce((sum, s) => sum + (s.start >= 0 ? s.end - s.start + 1 : 0), 0);
    return this.chapters().length - assigned;
  }

  // 0-based story index owning chapter i, or -1 if excluded.
  storyOf(i: number): number {
    const arr = this.stories();
    for (let k = 0; k < arr.length; k++) {
      const s = arr[k];
      if (s.start >= 0 && i >= s.start && i <= s.end) return k;
    }
    return -1;
  }

  // Nearest assigned neighbour bounds for the active story (skipping empties).
  private lowerBound(k: number): number {
    const arr = this.stories();
    for (let j = k - 1; j >= 0; j--) if (arr[j].start >= 0) return arr[j].end;
    return -1;
  }
  private upperBound(k: number): number {
    const arr = this.stories();
    for (let j = k + 1; j < arr.length; j++) if (arr[j].start >= 0) return arr[j].start;
    return this.chapters().length;
  }

  // Can chapter i be clicked into the active story without breaking order/contiguity?
  canClick(i: number): boolean {
    const k = this.activeIndex();
    if (k < 0) return false;
    return i > this.lowerBound(k) && i < this.upperBound(k);
  }

  clickChapter(i: number) {
    const k = this.activeIndex();
    if (k < 0 || !this.canClick(i)) return;
    this.stories.update(arr => {
      const next = arr.map(s => ({ ...s }));
      const s = next[k];
      if (s.start < 0) {
        s.start = i; s.end = i;              // first pick (check)
      } else if (i > s.end) {
        s.end = i;                           // click beyond → extend/fill up (check)
      } else if (i < s.start) {
        s.start = i;                         // click before → extend/fill down (check)
      } else if (i === s.end) {
        // click the last chapter → uncheck it
        if (s.start === s.end) { s.start = -1; s.end = -1; } // was the only one → clear
        else { s.end = i - 1; }
      } else if (i === s.start) {
        s.start = i + 1;                     // click the first chapter → uncheck it
      } else {
        s.end = i - 1;                       // click a middle chapter → uncheck it + the tail after it
      }
      return next;
    });
  }

  canAddStory(): boolean {
    const arr = this.stories();
    if (arr.length === 0) return true;
    const last = arr[arr.length - 1];
    // Need the current last story filled, and at least one chapter left after it.
    return last.start >= 0 && last.end < this.chapters().length - 1;
  }

  addStory() {
    if (!this.canAddStory()) return;
    this.stories.update(arr => [...arr, { start: -1, end: -1, name: '', renamed: false }]);
    this.activeIndex.set(this.stories().length - 1);
  }

  removeStory(k: number) {
    this.stories.update(arr => arr.filter((_, i) => i !== k));
    if (this.stories().length === 0) {
      this.resetStories();
    } else {
      this.activeIndex.set(Math.min(this.activeIndex(), this.stories().length - 1));
    }
  }

  renameActive(name: string) {
    const k = this.activeIndex();
    if (k < 0) return;
    // Empty input reverts to the first-chapter default (renamed = false).
    const renamed = name.trim().length > 0;
    this.stories.update(arr => arr.map((s, i) => i === k ? { ...s, name, renamed } : s));
  }

  storyColor(storyNum: number): string {
    return this.PALETTE[(storyNum - 1) % this.PALETTE.length];
  }

  canConfirm(): boolean {
    return this.phase() === 'loaded' && this.validStoryCount() >= 1;
  }

  formatDuration(seconds: number): string {
    const s = Math.max(0, Math.round(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  onConfirm() {
    if (!this.canConfirm()) return;
    const ch = this.chapters();
    const cuts: TranscriptSplitCut[] = this.stories()
      .map((s, idx) => ({ s, idx }))
      .filter(x => x.s.start >= 0)
      .sort((a, b) => a.s.start - b.s.start)
      .map(x => ({
        startSeconds: ch[x.s.start].startSeconds,
        endSeconds: ch[x.s.end].endSeconds,
        title: this.storyName(x.idx),   // first-chapter label (or user rename)
      }));
    this.dialogRef.close({ cuts });
  }

  onCancel() { this.dialogRef.close(); }
}
