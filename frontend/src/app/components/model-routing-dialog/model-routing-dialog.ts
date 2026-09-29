import { Component, OnInit, computed, signal } from '@angular/core';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import {
  ElectronService,
  MetadataRoutingOption,
  MetadataRoutingServer,
  MetadataRoutingTask,
} from '../../services/electron';
import { CrucibleService } from '../../services/crucible';
import { reachIsProblem, reachWord } from '../../features/crucible/crucible-words';

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
        <!-- Runs on (LEDGER #222): the Crucible server this routing's jobs run on. The choices
             are the registered servers (Settings › Crucible Servers is the registry); the first
             one is "whatever Settings has selected", which is also what a routing saved before
             this row existed means. A Fast item still goes to the fast server. -->
        <div class="routing-row runs-on-row">
          <div class="field-label">
            <span class="task-label">Runs on</span>
            <span class="task-sub">The Crucible server these jobs run on. A Fast item still goes to the fast server.</span>
          </div>
          <mat-form-field appearance="outline" subscriptSizing="dynamic" class="task-select">
            <mat-select
              [value]="runsOn() ?? SELECTED"
              (selectionChange)="selectServer($event.value)"
              [disabled]="previewing()"
              aria-label="Runs on">
              <mat-option [value]="SELECTED">
                The selected server{{ selectedServer() ? ' (' + selectedServer() + ')' : '' }}
                @if (!selectedServer()) {
                  <span class="option-flag missing">— none selected</span>
                }
              </mat-option>
              @for (choice of serverChoices(); track choice.name) {
                <mat-option [value]="choice.name">
                  {{ choice.name }}
                  @if (choice.paused) {
                    <span class="option-flag unknown">— Paused</span>
                  } @else if (choice.reach) {
                    <span class="option-flag" [class.missing]="choice.problem" [class.unknown]="!choice.problem">— {{ choice.reach }}</span>
                  }
                </mat-option>
              }
            </mat-select>
          </mat-form-field>
        </div>

        <!-- The models listed are the ones the server above offers (P2): its catalog, plus
             Claude only when that server has an Anthropic key. A stored choice it cannot run
             is still shown on its row, with the server's own sentence. -->
        @if (server(); as host) {
          @if (!host.reachable) {
            <div class="host-banner">
              <mat-icon>help_outline</mat-icon>
              <span>
                {{ host.error || 'The Crucible server could not be read.' }}
                What it offers is unknown, so only claude -p and the current choices are listed.
              </span>
            </div>
          } @else {
            <p class="dialog-hint">Models {{ host.name }} offers{{ host.anthropicConfigured ? ', and Claude on its key' : '' }}.</p>
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
                  @if (option.availability === 'pullable') {
                    <span class="option-flag unknown">— not downloaded on {{ server().name }}</span>
                  }
                  @if (option.availability === 'not-here') {
                    <span class="option-flag missing">— not on {{ server().name }}</span>
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
        @for (task of rowTasks(); track task.id) {
          @if (task.id === thumbnailTasks()[0]?.id) {
            <div class="group-heading">Thumbnails. Used by metadata runs (the A/B thumbnails) and the reports page's Thumbnails window.</div>
          }
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
                    @if (option.availability === 'pullable') {
                      <span class="option-flag unknown">— not downloaded on {{ server().name }}</span>
                    }
                    @if (option.availability === 'not-here') {
                      <span class="option-flag missing">— not on {{ server().name }}</span>
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
            @if (chosen.availability === 'not-here' || chosen.availability === 'pullable') {
              <p class="row-note missing">
                {{ chosen.availabilityNote || (chosen.model + ' cannot run on ' + server().name + '.') }}
                {{ task.label }} is refused by name when it runs — nothing is substituted. Pick a
                model this server offers{{ chosen.availability === 'pullable' ? ', or pull it there' : '' }}.
              </p>
            }
          }
        }

        <!-- Not choices, but worth stating: what the rest of the run does regardless. -->
        <div class="pipeline-note">
          <mat-icon>info_outline</mat-icon>
          <div>
            <p>
              <strong>Tags</strong> on a chaptered item are assembled in code from the names and
              phrases its chapter list shares with the video's own words, and use no model at all; a
              chapterless item's tags are written by the Tags row ({{ tagsModelLabel() }}). Hashtags
              follow the tags.
            </p>
          </div>
        </div>

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
              [disabled]="!hasChanges() || saving() || previewing()"
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

    .runs-on-row {
      border-bottom: 1px solid var(--border-color, rgba(128, 128, 128, 0.3));
      padding-bottom: 12px;
      margin-bottom: 12px;
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

    .group-heading {
      margin-top: 0.75rem;
      padding-top: 0.6rem;
      border-top: 1px solid var(--border-color);
      color: var(--text-secondary);
      font-size: 0.75rem;
      font-weight: 600;
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
   * renders only the `modal: true` tasks as rows, and any other task passes through Save
   * untouched rather than being reset. Every task is a row today (tags became one
   * 2026-09-24), so nothing a run can call is hidden from this dialog.
   */
  readonly tasks = signal<MetadataRoutingTask[]>([]);

  /**
   * The metadata run's rows, in the registry's order. The change-all menu covers these only: the
   * thumbnail row (#236, #240; the words, the one left since the frame and judge rows were
   * retired 2026-09-29) is grouped apart, because it decides no field's words.
   */
  readonly modalTasks = computed(() => this.tasks().filter(task => task.modal && task.group !== 'thumbnails'));
  /** The thumbnail rows, shown under their own heading after the metadata rows. */
  readonly thumbnailTasks = computed(() => this.tasks().filter(task => task.modal && task.group === 'thumbnails'));
  /** Every row the dialog shows, metadata first. */
  readonly rowTasks = computed(() => [...this.modalTasks(), ...this.thumbnailTasks()]);
  readonly selections = signal<Record<string, string>>({});
  /**
   * The Crucible server the payload was judged against. The placeholder is never rendered —
   * load() sets the real one before phase becomes 'ready' — but it starts unreachable so
   * nothing could be read as offered if it were.
   */
  readonly server = signal<MetadataRoutingServer>({ name: null, reachable: false, anthropicConfigured: null });

  /** Selections as they were when the payload loaded — Save stays off until this differs. */
  private initialSelections: Record<string, string> = {};

  /** The "Runs on" select's value for "no routing server": a server name is never empty. */
  readonly SELECTED = '';
  /** The routing's server on screen (LEDGER #222); null means the server Settings has selected. */
  readonly runsOn = signal<string | null>(null);
  /** The server Settings has selected, named on the unset choice. */
  readonly selectedServer = signal<string | null>(null);
  /** The registered servers, each with its reach word from the Settings pane's own probe. */
  readonly serverChoices = signal<Array<{ name: string; paused: boolean; reach: string | null; problem: boolean }>>([]);
  /** True while main judges the on-screen selections against a newly chosen server. */
  readonly previewing = signal(false);
  private initialRunsOn: string | null = null;

  readonly hasChanges = computed(() => {
    if (this.runsOn() !== this.initialRunsOn) return true;
    const current = this.selections();
    const initial = this.initialSelections;
    const keys = Object.keys(initial);
    if (keys.length !== Object.keys(current).length) return true;
    return keys.some(key => current[key] !== initial[key]);
  });

  /** What a chapterless item's tags run on: the Tags row's current selection (#204). */
  readonly tagsModelLabel = computed(() => {
    const tags = this.tasks().find(task => task.id === 'tags');
    const chosen = tags?.options.find(option => option.id === this.selections()['tags']);
    return chosen?.label ?? 'the registry default';
  });

  constructor(
    private dialogRef: MatDialogRef<ModelRoutingDialog, ModelRoutingDialogResult>,
    private electron: ElectronService,
    private crucible: CrucibleService
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
      // The routing, and the registry the "Runs on" choices come from (the same view the
      // Settings pane draws). Either failing is the dialog's error: a Runs on row with no
      // servers to offer would be a choice that silently is not one.
      const [routing, registry] = await Promise.all([this.electron.getMetadataRouting(), this.crucible.servers()]);
      const selections: Record<string, string> = {};
      for (const task of routing.tasks) {
        selections[task.id] = task.selectedOptionId;
      }

      // Baseline first: hasChanges() must never see new selections against a stale baseline.
      this.initialSelections = { ...selections };
      this.initialRunsOn = routing.runsOn.routingServer;
      this.runsOn.set(routing.runsOn.routingServer);
      this.selectedServer.set(routing.runsOn.selectedServer);
      this.serverChoices.set(registry.routing.servers.map(row => ({ name: row.name, paused: row.paused, reach: null, problem: false })));
      this.server.set(routing.server);
      this.tasks.set(routing.tasks);
      this.selections.set(selections);
      this.phase.set('ready');
      for (const row of registry.routing.servers) void this.readReach(row.name);
    } catch (err) {
      this.error.set(this.describe(err));
      this.phase.set('error');
    }
  }

  /** One server's reach word, from the probe the Settings pane reads (at most 15 s old). */
  private async readReach(name: string): Promise<void> {
    let reach: string;
    let problem: boolean;
    try {
      const answer = await this.crucible.probe(name);
      reach = reachWord(answer.reach);
      problem = reachIsProblem(answer.reach);
    } catch (err) {
      reach = this.describe(err);
      problem = true;
    }
    this.serverChoices.update(rows => rows.map(row => (row.name === name ? { ...row, reach, problem } : row)));
  }

  /**
   * The "Runs on" pick. Main judges the selections on screen against that server (what it
   * offers, and whether each chosen model can run there) before anything is saved; the
   * selections themselves are never changed by the pick, so a model the new server lacks stays
   * chosen and its row says so, exactly as for a stored choice.
   */
  async selectServer(value: string): Promise<void> {
    const server = value === this.SELECTED ? null : value;
    const before = this.runsOn();
    this.runsOn.set(server);
    this.saveError.set('');
    this.previewing.set(true);
    try {
      const routing = await this.electron.getMetadataRouting({ server, selections: this.selections() });
      this.server.set(routing.server);
      this.tasks.set(routing.tasks);
    } catch (err) {
      this.runsOn.set(before);
      this.saveError.set(this.describe(err));
    } finally {
      this.previewing.set(false);
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
      const server = this.runsOn();
      await this.electron.setMetadataRouting({ ...this.selections(), ...(server === null ? {} : { server }) });
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
