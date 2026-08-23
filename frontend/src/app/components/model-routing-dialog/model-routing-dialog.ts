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
  MetadataRoutingSlot,
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

        <!-- THE choice: which model writes the four packaging fields. One pick writes the
             same per-task entries the store has always held; a store hand-set per field
             (e.g. titles on the 32B adapter) shows as Custom and is never rewritten. -->
        @if (slot(); as bigSlot) {
          <div class="routing-row">
            <div class="slot-label">
              <span class="task-label">{{ bigSlot.label }}</span>
              <span class="slot-fields">{{ slotFieldsLabel(bigSlot) }}</span>
            </div>
            <mat-form-field appearance="outline" subscriptSizing="dynamic" class="task-select">
              <mat-select
                [value]="slotValue(bigSlot)"
                placeholder="Custom (per-field entries in the store)"
                (selectionChange)="selectSlot(bigSlot, $event.value)"
                [attr.aria-label]="bigSlot.label">
                @for (option of bigSlot.options; track option.id) {
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
          @if (slotOption(bigSlot); as chosen) {
            @if (chosen.availability === 'not-installed') {
              <p class="row-note missing">
                {{ chosen.model }} is not installed on {{ localModels().host }}. These fields will
                fail when they run — pull it, or pick a model that is installed.
              </p>
            }
          }
        }

        <!-- Not choices, but worth stating: what the rest of the run does regardless. -->
        <div class="pipeline-note">
          <mat-icon>info_outline</mat-icon>
          <div>
            <p>
              <strong>Description and tags</strong> always run on the small local model
              ({{ smallModelLabel() }}); hashtags follow the description. Tags on a chaptered
              item are assembled in code and use no model at all.
            </p>
          </div>
        </div>

        @if (chapters(); as chapter) {
          <div class="pipeline-note">
            <mat-icon>auto_stories</mat-icon>
            <div>
              <p>
                <strong>Chapters</strong> are not routed. Every item with a timestamped transcript is
                chaptered by {{ chapter.generationModel }}, which reads the whole transcript in one
                call and then writes each chapter's detail.
              </p>
              @if (chapter.generationAvailability === 'not-installed') {
                <p class="row-note missing">
                  {{ chapter.generationModel }} is not installed on {{ localModels().host }} — no item will
                  get chapters until it is pulled.
                </p>
              }
              @if (chapter.keyPhraseAvailability === 'not-installed') {
                <p class="row-note missing">
                  {{ chapter.keyPhraseModel }} is not installed on {{ localModels().host }} — key phrases for
                  tags and hashtags will be ranked by frequency instead, and runs will say so in their
                  warnings.
                </p>
              }
            </div>
          </div>
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

    .slot-label {
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

    .slot-fields {
      color: var(--text-secondary);
      font-size: 12px;
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
   * Every routed task with its stored selection — not rendered as rows any more, but still
   * loaded whole and saved whole: the modal edits only the slot's four entries, and the
   * others (description, tags — including a hand-set 9b/4b A/B entry) pass through Save
   * untouched rather than being reset to defaults.
   */
  readonly tasks = signal<MetadataRoutingTask[]>([]);
  readonly slot = signal<MetadataRoutingSlot | null>(null);
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

  /** What the description (and so tags/hashtags) actually runs on, named from the payload. */
  readonly smallModelLabel = computed(() => {
    const description = this.tasks().find(task => task.id === 'description');
    const chosen = description?.options.find(option => option.id === this.selections()['description']);
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
      this.slot.set(routing.slots[0] ?? null);
      this.selections.set(selections);
      this.phase.set('ready');
    } catch (err) {
      this.error.set(this.describe(err));
      this.phase.set('error');
    }
  }

  /**
   * The option the slot currently amounts to: the one every one of its tasks points at,
   * PROVIDED the slot offers it. Anything else — a hand-set per-field entry like titles on
   * the 32B adapter — is null, rendered as Custom and never rewritten.
   */
  slotValue(slot: MetadataRoutingSlot): string | null {
    const current = this.selections();
    const picks = slot.taskIds.map(taskId => current[taskId]);
    const first = picks[0];
    if (!first || picks.some(pick => pick !== first)) return null;
    return slot.options.some(option => option.id === first) ? first : null;
  }

  /** The chosen option's view, so the row can report ITS availability. */
  slotOption(slot: MetadataRoutingSlot): MetadataRoutingOption | undefined {
    const value = this.slotValue(slot);
    return value ? slot.options.find(option => option.id === value) : undefined;
  }

  /** "titles, thumbnail text, pinned comment, clip suggestions" under the slot name. */
  slotFieldsLabel(slot: MetadataRoutingSlot): string {
    const byId = new Map(this.tasks().map(task => [task.id, task.label]));
    return slot.taskIds.map(taskId => (byId.get(taskId) || taskId).toLowerCase()).join(', ');
  }

  /** One pick writes every one of the slot's tasks. */
  selectSlot(slot: MetadataRoutingSlot, optionId: string): void {
    this.selections.update(current => {
      const next = { ...current };
      for (const taskId of slot.taskIds) next[taskId] = optionId;
      return next;
    });
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
