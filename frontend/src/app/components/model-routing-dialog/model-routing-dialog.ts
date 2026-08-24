import { Component, OnInit, computed, signal } from '@angular/core';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import {
  ElectronService,
  MetadataRoutingChapters,
  MetadataRoutingHost,
  MetadataRoutingOption,
  MetadataRoutingTask,
} from '../../services/electron';

type Phase = 'loading' | 'ready' | 'error';

/** Closes with `true` when the selections were persisted; `undefined` on cancel/Esc. */
export type ModelRoutingDialogResult = boolean | undefined;

@Component({
  selector: 'app-model-routing-dialog',
  standalone: true,
  imports: [
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatProgressBarModule,
    MatFormFieldModule,
    MatSelectModule,
  ],
  template: `
    <h2 mat-dialog-title>Model routing</h2>
    <mat-dialog-content>
      <p class="dialog-hint">
        Applies to every item when the queue starts.
      </p>

      @if (phase() === 'loading') {
        <div class="loading">
          <mat-progress-bar mode="indeterminate"></mat-progress-bar>
          <span>Loading model routing…</span>
        </div>
      }

      @if (phase() === 'error') {
        <div class="routing-error">
          <mat-icon>error_outline</mat-icon>
          <span>{{ error() }}</span>
        </div>
        <button mat-stroked-button (click)="load()">
          <mat-icon>refresh</mat-icon> Try again
        </button>
      }

      @if (phase() === 'ready') {
        @if (localModels(); as host) {
          @if (!host.reachable) {
            <div class="host-banner">
              <mat-icon>help_outline</mat-icon>
              <span>
                {{ host.error || 'Ollama at ' + host.host + ' could not be reached.' }}
                Which local models are installed is unknown, so none are marked below.
              </span>
            </div>
          }
        }

        <!-- One pick, every row: only options offered by EVERY field below are listed,
             so "all" always means all. Shows the shared choice when the rows agree and
             goes blank when they diverge. Save still commits, same as the rows. -->
        <div class="routing-row change-all-row">
          <div class="field-label">
            <span class="task-label">All fields</span>
            <span class="task-sub">Sets every row below at once.</span>
          </div>
          <mat-form-field appearance="outline" subscriptSizing="dynamic" class="task-select">
            <mat-select
              placeholder="Change all to…"
              [value]="uniformSelection()"
              (selectionChange)="selectAll($event.value)"
              aria-label="Change all fields">
              @for (option of universalOptions(); track option.id) {
                <mat-option [value]="option.id">
                  {{ option.label }}
                  @if (option.availability === 'not-installed') {
                    <span class="option-flag missing">— not installed</span>
                  }
                  @if (option.availability === 'unknown') {
                    <span class="option-flag unknown">— unknown</span>
                  }
                </mat-option>
              }
            </mat-select>
          </mat-form-field>
        </div>

        <!-- One row per big field, each set to whatever the operator wants (per-field
             routing, 2026-08-24). Fields the small models own (tags) are not rows: their
             stored entries pass through Save untouched. -->
        @for (task of modalTasks(); track task.id) {
          <div class="routing-row">
            <div class="field-label">
              <span class="task-label">{{ task.label }}</span>
            </div>
            <mat-form-field appearance="outline" subscriptSizing="dynamic" class="task-select">
              <mat-select
                [value]="selections()[task.id]"
                (selectionChange)="selectTask(task.id, $event.value)"
                [attr.aria-label]="task.label">
                @for (option of task.options; track option.id) {
                  <mat-option [value]="option.id">
                    {{ option.label }}
                    @if (option.availability === 'not-installed') {
                      <span class="option-flag missing">— not installed</span>
                    }
                    @if (option.availability === 'unknown') {
                      <span class="option-flag unknown">— unknown</span>
                    }
                  </mat-option>
                }
              </mat-select>
            </mat-form-field>
          </div>
          @if (chosenOption(task); as chosen) {
            @if (chosen.availability === 'not-installed') {
              <p class="row-note missing">
                {{ chosen.model }} is not installed on {{ localModels().host }}. {{ task.label }} will
                fail when it runs — pull it, or pick a model that is installed.
              </p>
            }
          }
        }

        <!-- Not choices, but worth stating: what the rest of the run does regardless. -->
        <div class="pipeline-note">
          <mat-icon>info_outline</mat-icon>
          <div>
            <p>
              <strong>Tags</strong> on a chaptered item are assembled in code from the video's own
              words and use no model at all; a chapterless item's tags run on the small local model
              ({{ smallModelLabel() }}). Hashtags follow the tags.
            </p>
          </div>
        </div>

        @if (chapters(); as chapter) {
          @if (chapter.keyPhraseAvailability === 'not-installed') {
            <div class="pipeline-note">
              <mat-icon>auto_stories</mat-icon>
              <div>
                <p class="row-note missing">
                  {{ chapter.keyPhraseModel }} is not installed on {{ localModels().host }} — key phrases for
                  tags and hashtags will be ranked by frequency instead, and runs will say so in their
                  warnings.
                </p>
              </div>
            </div>
          }
        }

        @if (saveError(); as message) {
          <div class="routing-error save-error">
            <mat-icon>error_outline</mat-icon>
            <span>{{ message }}</span>
          </div>
        }
      }
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button (click)="onCancel()" [disabled]="saving()">Cancel</button>
      <button mat-flat-button color="primary"
              [disabled]="!hasChanges() || saving()"
              (click)="onSave()">
        Save
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    mat-dialog-content { min-width: 520px; max-width: 640px; }

    .dialog-hint {
      color: var(--text-secondary);
      font-size: 13px;
      margin: 0 0 16px;
    }

    .loading { display: flex; flex-direction: column; gap: 8px; margin: 24px 0; }
    .loading span { color: var(--text-secondary); font-size: 13px; }

    .routing-error {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      color: var(--danger-text);
      font-size: 14px;
      margin: 8px 0 12px;

      .mat-icon { flex: 0 0 auto; }
    }
    .save-error { margin-top: 16px; }

    // --danger-text is tuned for the light theme; lift it on dark so it stays legible.
    :host-context([data-theme="dark"]) .routing-error { color: #ff6b6b; }

    .routing-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 6px 0;
    }

    .field-label {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }

    .task-label {
      color: var(--text-primary);
      font-size: 14px;
      font-weight: 500;
    }

    .task-sub {
      color: var(--text-secondary);
      font-size: 12px;
    }

    .change-all-row {
      border-bottom: 1px solid var(--border-color, rgba(128, 128, 128, 0.3));
      padding-bottom: 12px;
      margin-bottom: 8px;
    }

    .task-select { width: 300px; flex: 0 0 auto; }

    .host-banner {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      color: var(--text-secondary);
      font-size: 13px;
      margin: 0 0 12px;

      .mat-icon { flex: 0 0 auto; }
    }

    .option-flag {
      font-size: 12px;
      margin-left: 6px;

      &.missing { color: var(--danger-text); }
      &.unknown { color: var(--text-secondary); }
    }

    .row-note {
      font-size: 12px;
      margin: 0 0 8px;

      &.missing { color: var(--danger-text); }
      &.unknown { color: var(--text-secondary); }
    }

    .pipeline-note {
      display: flex;
      gap: 8px;
      align-items: flex-start;
      margin-top: 16px;
      padding-top: 12px;
      border-top: 1px solid var(--border-color, rgba(128, 128, 128, 0.3));
      color: var(--text-secondary);
      font-size: 12px;

      mat-icon { font-size: 18px; width: 18px; height: 18px; }
      p { margin: 0 0 4px; }
    }

    :host-context([data-theme="dark"]) .option-flag.missing,
    :host-context([data-theme="dark"]) .row-note.missing { color: #ff6b6b; }
  `]
})
export class ModelRoutingDialog implements OnInit {
  readonly phase = signal<Phase>('loading');
  readonly error = signal<string>('');
  readonly saveError = signal<string>('');
  readonly saving = signal(false);
  /**
   * Every routed task with its stored selection, loaded whole and saved whole: the modal
   * renders only the `modal: true` tasks as rows, and the rest — tags, including a
   * hand-set 9b/4b A/B entry — pass through Save untouched rather than being reset.
   */
  readonly tasks = signal<MetadataRoutingTask[]>([]);

  /** The rows: the big determinative fields, in the registry's order. */
  readonly modalTasks = computed(() => this.tasks().filter(task => task.modal));
  readonly selections = signal<Record<string, string>>({});
  /**
   * The Ollama host the payload was judged against. The placeholder is never rendered —
   * load() sets the real one before phase becomes 'ready', and nothing here draws before
   * that — but it starts unreachable so nothing could be read as installed if it were.
   */
  readonly localModels = signal<MetadataRoutingHost>({ host: '', reachable: false, installedCount: 0 });

  /**
   * The always-on chapter pipeline's models. Null until the payload loads — never rendered
   * as a guess, for the same reason `localModels` starts unreachable.
   */
  readonly chapters = signal<MetadataRoutingChapters | null>(null);

  /** Selections as they were when the payload loaded — Save stays off until this differs. */
  private initialSelections: Record<string, string> = {};

  readonly hasChanges = computed(() => {
    const current = this.selections();
    const initial = this.initialSelections;
    const keys = Object.keys(initial);
    if (keys.length !== Object.keys(current).length) return true;
    return keys.some(key => current[key] !== initial[key]);
  });

  /** What a chapterless item's tags actually run on, named from the payload. */
  readonly smallModelLabel = computed(() => {
    const tags = this.tasks().find(task => task.id === 'tags');
    const chosen = tags?.options.find(option => option.id === this.selections()['tags']);
    return chosen?.label ?? 'the registry default';
  });

  constructor(
    private dialogRef: MatDialogRef<ModelRoutingDialog, ModelRoutingDialogResult>,
    private electron: ElectronService
  ) {}

  ngOnInit(): void {
    this.load();
  }

  /** Always fetches fresh — the dialog is created per open, so this runs on every open. */
  async load(): Promise<void> {
    this.phase.set('loading');
    this.error.set('');
    this.saveError.set('');

    try {
      const routing = await this.electron.getMetadataRouting();
      const selections: Record<string, string> = {};
      for (const task of routing.tasks) {
        selections[task.id] = task.selectedOptionId;
      }

      // Baseline first: hasChanges() must never see new selections against a stale baseline.
      this.initialSelections = { ...selections };
      this.localModels.set(routing.localModels);
      this.chapters.set(routing.chapters);
      this.tasks.set(routing.tasks);
      this.selections.set(selections);
      this.phase.set('ready');
    } catch (err) {
      this.error.set(this.describe(err));
      this.phase.set('error');
    }
  }

  /**
   * The change-all menu: only options every modal row offers. Fields keep deliberately
   * different menus (chapters is capable-rungs-only), so an option missing anywhere is
   * not offered here at all — a change-all that skipped fields would be a quiet lie.
   */
  readonly universalOptions = computed(() => {
    const rows = this.modalTasks();
    if (!rows.length) return [];
    return rows[0].options.filter(option =>
      rows.every(task => task.options.some(candidate => candidate.id === option.id))
    );
  });

  /** The one option every row currently shares, or null so the change-all select goes blank. */
  readonly uniformSelection = computed(() => {
    const rows = this.modalTasks();
    if (!rows.length) return null;
    const selections = this.selections();
    const first = selections[rows[0].id];
    return first && rows.every(task => selections[task.id] === first) ? first : null;
  });

  /** One pick writes every visible row. Save still commits, same as the single rows. */
  selectAll(optionId: string): void {
    if (!optionId) return;
    this.selections.update(current => {
      const next = { ...current };
      for (const task of this.modalTasks()) next[task.id] = optionId;
      return next;
    });
  }

  /** The chosen option's view, so the row can report ITS availability. */
  chosenOption(task: MetadataRoutingTask): MetadataRoutingOption | undefined {
    const value = this.selections()[task.id];
    return value ? task.options.find(option => option.id === value) : undefined;
  }

  /** One pick writes one field. */
  selectTask(taskId: string, optionId: string): void {
    this.selections.update(current => ({ ...current, [taskId]: optionId }));
  }

  async onSave(): Promise<void> {
    if (!this.hasChanges() || this.saving()) return;

    this.saving.set(true);
    this.saveError.set('');

    try {
      await this.electron.setMetadataRouting(this.selections());
      this.dialogRef.close(true);
    } catch (err) {
      this.saveError.set(this.describe(err));
      this.saving.set(false);
    }
  }

  onCancel(): void {
    this.dialogRef.close();
  }

  /** Unwraps Electron's "Error invoking remote method 'x': Error: …" wrapper so the
   *  descriptive message thrown by the main process is what the user actually reads. */
  private describe(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    const unwrapped = raw.match(/Error invoking remote method '[^']*':\s*([\s\S]*)$/);
    const message = (unwrapped ? unwrapped[1] : raw).replace(/^Error:\s*/, '').trim();
    return message || 'Model routing failed with an empty error.';
  }
}
