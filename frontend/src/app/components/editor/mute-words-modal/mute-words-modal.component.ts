import { ChangeDetectorRef, Component, EventEmitter, Inject, Input, OnInit, Output } from '@angular/core';
import { EDITOR_HOST, EditorHost } from '../editor-host';
import {
  MuteCatalog, MuteGroup, MuteMode, MuteSettings, WordMuteReport, muteSummary, parseCustomWords, windowClock,
} from '../model/mute-words';

/**
 * "Mute words" (LEDGER #226): pick which words are muted on this project's master timeline.
 *
 * Opened from the processing modal (before a run) and from a project's right-click menu. The
 * choice is saved per project (`<cleanName>_mute-words.json` in the project folder) and also
 * remembered as the starting point for new projects. The mutes themselves are written when the
 * master timeline is exported (File ▸ Export…); "Save and apply" re-mutes a timeline that is
 * already exported, for a project that has a transcript.
 *
 * The word lists come from the main process (editor-backend/core/mute_words.json) — the same
 * data the Python pass matches with, so what a group shows here is exactly what it mutes.
 */
@Component({
  selector: 'app-mute-words-modal',
  templateUrl: './mute-words-modal.component.html',
  styleUrls: ['./mute-words-modal.component.scss'],
  standalone: false
})
export class MuteWordsModalComponent implements OnInit {
  @Input() folder = '';
  @Input() cleanName = '';
  @Input() projectName = '';
  /** Set when the project has been processed: Apply needs its zip. */
  @Input() zipPath: string | null = null;
  @Input() hasTranscript = false;
  /** 'setup': opened from the processing modal (Save only). 'project': Save and apply offered. */
  @Input() mode: 'setup' | 'project' = 'project';

  @Output() closed = new EventEmitter<void>();
  /** Emitted after a successful save, with the one-line summary of what was saved. */
  @Output() saved = new EventEmitter<string>();

  catalog: MuteCatalog | null = null;
  settings: MuteSettings | null = null;
  customText = '';
  source: 'project' | 'remembered' | 'blank' | null = null;
  error: string | null = null;
  busy = false;
  report: WordMuteReport | null = null;
  appliedPath: string | null = null;
  shown = new Set<string>();

  readonly modes: MuteMode[] = ['off', 'everywhere', 'opening'];

  constructor(@Inject(EDITOR_HOST) private host: EditorHost, private cdr: ChangeDetectorRef) {}

  async ngOnInit(): Promise<void> {
    try {
      this.catalog = await this.host.muteWordsCatalog();
      const loaded = await this.host.loadMuteWords({ folder: this.folder, cleanName: this.cleanName });
      this.settings = JSON.parse(JSON.stringify(loaded.settings));
      this.customText = loaded.settings.customWords.join(', ');
      this.source = loaded.source;
    } catch (e: any) {
      this.error = e?.message || String(e);
    }
    this.cdr.detectChanges();
  }

  modeLabel(m: MuteMode): string {
    if (m === 'off') return 'Off';
    if (m === 'everywhere') return 'Everywhere';
    return `First ${this.windowText} only`;
  }

  get windowText(): string {
    return this.settings ? windowClock(this.settings.openingWindow.minutes) : '';
  }

  get summary(): string {
    if (!this.settings || !this.catalog) return '';
    return muteSummary({ ...this.settings, customWords: parseCustomWords(this.customText) }, this.catalog);
  }

  get minutesValid(): boolean {
    const m = this.settings?.openingWindow.minutes;
    return typeof m === 'number' && Number.isFinite(m) && m > 0 && !!this.catalog && m <= this.catalog.maxMinutes;
  }

  /** Apply is offered only where it can act; `applyBlocked` says why not, in place of the button. */
  get applyBlocked(): string | null {
    if (this.mode !== 'project') return null;
    if (!this.zipPath) return 'Process the project first — there is no master timeline yet.';
    if (!this.hasTranscript) return 'Transcribe the project first — the mutes are placed from its word times.';
    return null;
  }

  wordCount(g: MuteGroup): number {
    return g.contains.length + g.exact.length;
  }

  toggleWords(id: string): void {
    if (this.shown.has(id)) this.shown.delete(id);
    else this.shown.add(id);
  }

  private collect(): MuteSettings {
    const s = this.settings!;
    return {
      schemaVersion: 1,
      groups: { ...s.groups },
      customWords: parseCustomWords(this.customText),
      customMode: s.customMode,
      openingWindow: { allSwearing: s.openingWindow.allSwearing, minutes: Number(s.openingWindow.minutes) },
    };
  }

  async save(apply = false): Promise<void> {
    if (!this.settings || this.busy) return;
    if (!this.minutesValid) {
      this.error = `The opening window must be more than 0 and at most ${this.catalog?.maxMinutes} minutes.`;
      return;
    }
    this.busy = true;
    this.error = null;
    this.report = null;
    this.appliedPath = null;
    this.cdr.detectChanges();
    try {
      const settings = this.collect();
      await this.host.saveMuteWords({ folder: this.folder, cleanName: this.cleanName, settings });
      this.source = 'project';
      this.saved.emit(this.summary);
      if (apply && this.zipPath) {
        const res = await this.host.applyMuteWords({ zipPath: this.zipPath });
        this.report = res.wordMutes;
        this.appliedPath = res.path;
      } else {
        this.closed.emit();
      }
    } catch (e: any) {
      // The main process / Python message is the reason; shown as-is.
      this.error = e?.message || String(e);
    } finally {
      this.busy = false;
      this.cdr.detectChanges();
    }
  }

  onClose(): void {
    if (this.busy) return;
    this.closed.emit();
  }
}
