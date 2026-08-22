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
        Applies to every item when the queue starts. Hashtags follow the Description model.
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
        @if (tasks().length === 0) {
          <p class="empty">No routable tasks were returned.</p>
        }
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
        <!-- The two-slot roster: the decision the operator actually makes. Picking here
             writes the same per-task entries the override rows write; a store whose slot
             fields disagree (an override in play) renders as Custom, never reconciled. -->
        @for (slot of slots(); track slot.id) {
          <div class="routing-row">
            <div class="slot-label">
              <span class="task-label">{{ slot.label }}</span>
              <span class="slot-fields">{{ slotFieldsLabel(slot) }}</span>
            </div>
            <mat-form-field appearance="outline" subscriptSizing="dynamic" class="task-select">
              <mat-select
                [value]="slotValue(slot)"
                placeholder="Custom — see per-field overrides"
                (selectionChange)="selectSlot(slot, $event.value)"
                [attr.aria-label]="slot.label">
                @for (option of slot.options; track option.id) {
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
          @if (slotOption(slot); as chosen) {
            @if (chosen.availability === 'not-installed') {
              <p class="row-note missing">
                {{ chosen.model }} is not installed on {{ localModels().host }}. Every
                {{ slot.label.toLowerCase() }} field will fail when it runs — pull it, or pick a
                model that is installed.
              </p>
            }
            @if (chosen.availability === 'unknown' && chosen.availabilityNote) {
              <p class="row-note unknown">{{ chosen.model }}: {{ chosen.availabilityNote }}.</p>
            }
          }
        }

        <!-- Everything the slots deliberately don't offer — the 32B titles adapter, cloud on
             the mechanical fields, the odd one-field experiment — stays reachable here. -->
        <button mat-button class="overrides-toggle" (click)="showOverrides.set(!showOverrides())">
          <mat-icon>{{ showOverrides() ? 'expand_less' : 'expand_more' }}</mat-icon>
          Per-field overrides
        </button>
        @if (showOverrides()) {
        @for (task of tasks(); track task.id) {
          <div class="routing-row">
            <span class="task-label">{{ task.label }}</span>
            <mat-form-field appearance="outline" subscriptSizing="dynamic" class="task-select">
              <mat-select
                [value]="selections()[task.id]"
                (selectionChange)="select(task.id, $event.value)"
                [attr.aria-label]="task.label + ' model'">
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
          <!-- The saved-but-missing case: the closed select shows only a label, so a
               routing pointing at a model this machine does not have would look normal
               right up until the run failed. -->
          @if (selectedOption(task); as chosen) {
            @if (chosen.availability === 'not-installed') {
              <!-- A multi-model option carries its own note naming WHICH model is missing;
                   the generic sentence names the option's primary model, which on such an
                   option may be installed perfectly well. -->
              @if (chosen.availabilityNote) {
                <p class="row-note missing">
                  {{ chosen.availabilityNote }} — on {{ localModels().host }}.
                </p>
              } @else {
                <p class="row-note missing">
                  {{ chosen.model }} is not installed on {{ localModels().host }}. This will fail when
                  {{ task.label }} runs — pull it, or pick a model that is installed.
                </p>
              }
            }
            @if (chosen.availability === 'unknown' && chosen.availabilityNote) {
              <p class="row-note unknown">{{ chosen.model }}: {{ chosen.availabilityNote }}.</p>
            }
          }
        }
        }

        <!-- Chapters are not on this list because they are not a choice: one pipeline
             runs on every item with a timestamped transcript. What IS still worth saying
             is whether its two models are on the machine, because finding out mid-run
             costs the run. -->
        @if (chapters(); as chapter) {
          <div class="chapters-note">
            <mat-icon>auto_stories</mat-icon>
            <div>
              <p>
                <strong>Chapters</strong> are not routed. Every item with a timestamped transcript is
                chaptered by the embedding pipeline on {{ chapter.generationModel }} +
                {{ chapter.embeddingModel }}.
              </p>
              @if (chapter.generationAvailability === 'not-installed') {
                <p class="row-note missing">
                  {{ chapter.generationModel }} is not installed on {{ localModels().host }} — no item will
                  get chapters until it is pulled.
                </p>
              }
              @if (chapter.embeddingAvailability === 'not-installed') {
                <p class="row-note missing">
                  {{ chapter.embeddingModel }} is not installed on {{ localModels().host }} — runs will fall
                  to the weaker word-matching scorer and say so in their warnings.
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

    .empty { color: var(--text-secondary); font-size: 14px; }

    .slot-label {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }

    .slot-fields {
      color: var(--text-secondary);
      font-size: 12px;
    }

    .overrides-toggle {
      margin: 12px 0 4px;
      color: var(--text-secondary);
      font-size: 13px;
    }

    .routing-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 6px 0;
      border-bottom: 1px solid var(--border-color);

      &:last-of-type { border-bottom: none; }
    }

    .task-label {
      color: var(--text-primary);
      font-size: 14px;
      font-weight: 500;
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

    .chapters-note {
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
  readonly tasks = signal<MetadataRoutingTask[]>([]);
  readonly slots = signal<MetadataRoutingSlot[]>([]);
  readonly selections = signal<Record<string, string>>({});
  /** Opens itself when a slot loads as Custom — a hidden override is not explorable. */
  readonly showOverrides = signal(false);
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
      const tasks = routing.tasks;
      const selections: Record<string, string> = {};
      for (const task of tasks) {
        selections[task.id] = task.selectedOptionId;
      }

      // Baseline first: hasChanges() must never see new selections against a stale baseline.
      this.initialSelections = { ...selections };
      this.localModels.set(routing.localModels);
      this.chapters.set(routing.chapters);
      this.tasks.set(tasks);
      this.slots.set(routing.slots);
      this.selections.set(selections);
      // A slot the store has overridden per-field loads as Custom; open the rows that
      // explain it rather than leaving a placeholder pointing at a collapsed section.
      if (routing.slots.some(slot => this.slotValue(slot) === null)) {
        this.showOverrides.set(true);
      }
      this.phase.set('ready');
    } catch (err) {
      this.error.set(this.describe(err));
      this.phase.set('error');
    }
  }

  /** The option a task currently points at, so the row can report ITS availability. */
  selectedOption(task: MetadataRoutingTask): MetadataRoutingOption | undefined {
    return task.options.find(option => option.id === this.selections()[task.id]);
  }

  select(taskId: string, optionId: string): void {
    this.selections.update(current => ({ ...current, [taskId]: optionId }));
  }

  /**
   * The option a slot currently amounts to: the one every one of its tasks points at,
   * PROVIDED the slot offers it. Anything else — disagreeing tasks, or agreement on a
   * model only the per-field rows offer — is null, rendered as Custom and never rewritten.
   */
  slotValue(slot: MetadataRoutingSlot): string | null {
    const current = this.selections();
    const picks = slot.taskIds.map(taskId => current[taskId]);
    const first = picks[0];
    if (!first || picks.some(pick => pick !== first)) return null;
    return slot.options.some(option => option.id === first) ? first : null;
  }

  /** The chosen option's view, so the slot row can report ITS availability. */
  slotOption(slot: MetadataRoutingSlot): MetadataRoutingOption | undefined {
    const value = this.slotValue(slot);
    return value ? slot.options.find(option => option.id === value) : undefined;
  }

  /** "titles, thumbnail text, pinned comment, clip suggestions" under the slot name. */
  slotFieldsLabel(slot: MetadataRoutingSlot): string {
    const byId = new Map(this.tasks().map(task => [task.id, task.label]));
    return slot.taskIds.map(taskId => (byId.get(taskId) || taskId).toLowerCase()).join(', ');
  }

  /** One pick on the slot writes every one of its tasks. */
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
