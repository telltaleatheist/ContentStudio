import { Component, OnInit, computed, signal } from '@angular/core';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import {
  ElectronService,
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
        @if (applyAllOptions().length > 0) {
          <div class="apply-all-row">
            <span class="apply-all-label">Set every field to:</span>
            @for (option of applyAllOptions(); track option.id) {
              <button mat-stroked-button class="apply-all-button" (click)="applyToAll(option.id)">
                {{ option.label }}
              </button>
            }
          </div>
          <p class="apply-all-note">
            Fields that don't offer that model (Chapters runs locally) keep their selection. Review below, then Save.
          </p>
        }
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

    .apply-all-row {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 4px;
    }

    .apply-all-label {
      color: var(--text-primary);
      font-size: 14px;
      font-weight: 500;
    }

    .apply-all-note {
      color: var(--text-secondary);
      font-size: 12px;
      margin: 0 0 12px;
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
  readonly selections = signal<Record<string, string>>({});
  /**
   * The Ollama host the payload was judged against. The placeholder is never rendered —
   * load() sets the real one before phase becomes 'ready', and nothing here draws before
   * that — but it starts unreachable so nothing could be read as installed if it were.
   */
  readonly localModels = signal<MetadataRoutingHost>({ host: '', reachable: false, installedCount: 0 });

  /** Selections as they were when the payload loaded — Save stays off until this differs. */
  private initialSelections: Record<string, string> = {};

  /**
   * The "set every field to X" shortcuts: options offered by every field task.
   * Chapters is excluded from the requirement — its pipeline is local-only by
   * design (hundreds of one-question calls per video), so demanding an option be
   * offered there would leave this list permanently empty. Computed from the
   * loaded payload, so a new universally-offered model shows up here on its own.
   */
  readonly applyAllOptions = computed(() => {
    const fieldTasks = this.tasks().filter(task => task.id !== 'chapters');
    if (fieldTasks.length === 0) return [];
    const [first, ...rest] = fieldTasks;
    return first.options.filter(option =>
      rest.every(task => task.options.some(o => o.id === option.id))
    );
  });

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
      this.tasks.set(tasks);
      this.selections.set(selections);
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

  /** Point every task that offers `optionId` at it; tasks that don't offer it keep theirs. */
  applyToAll(optionId: string): void {
    this.selections.update(current => {
      const next = { ...current };
      for (const task of this.tasks()) {
        if (task.options.some(o => o.id === optionId)) {
          next[task.id] = optionId;
        }
      }
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
