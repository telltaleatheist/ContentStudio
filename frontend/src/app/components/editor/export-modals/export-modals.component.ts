import { Component, EventEmitter, Input, Output } from '@angular/core';
import { WordMuteReport } from '../model/mute-words';

/**
 * The editor's two export dialogs: the chooser (pick what to export) and the result modal
 * (exported path + Show in Folder, or the verbatim Python error).
 *
 * Presentational only. It runs no export, owns no export state and never saves — the shell keeps
 * `exporting`, `exportResultPath`, `exportError`, `exportMicMuteBlocks`, `exportChooserOpen` and
 * `muteMicDuringScreen`, and decides what a choice or a dismissal does.
 *
 * `muteMic` is a banana-box because the same flag is written from the top bar. Note the
 * asymmetry the editor deliberately keeps: ticking the box HERE does not persist, while the
 * top-bar toggle calls scheduleEditsSave(). The shell's (muteMicChange) handler is therefore a
 * bare assignment — routing it through toggleMuteMicDuringScreen() would silently change that.
 */
@Component({
  selector: 'app-editor-export-modals',
  templateUrl: './export-modals.component.html',
  styleUrls: ['./export-modals.component.scss'],
  standalone: false
})
export class ExportModalsComponent {
  @Input() chooserOpen = false;

  @Input() resultPath: string | null = null;
  @Input() error: string | null = null;
  /** Mic blocks disabled under screen audio; null when the pass did not run. 0 is meaningful. */
  @Input() micMuteBlocks: number | null = null;
  /** The Mute words report for THIS export (LEDGER #226); null when no FCPXML was written. */
  @Input() wordMutes: WordMuteReport | null = null;
  /** One line in the chooser: what Mute words will do for this project on export. */
  @Input() muteSummary: string | null = null;
  /**
   * What became of the per-story Content Studio transcripts on THIS export, straight from
   * Python. 'no sidecar' is a reported outcome, not a silent skip — the whole point of the
   * field is that the operator learns the transcripts are missing here, at the export, and
   * not later when Content Studio has nothing to import. Null on a plain-cuts export, where
   * stories (and so story transcripts) do not exist.
   */
  @Input() transcripts: 'exported' | 'no sidecar' | null = null;
  /** Where they landed; set only alongside transcripts === 'exported'. */
  @Input() transcriptsDir: string | null = null;

  @Input() cutCount = 0;
  @Input() storyCount = 0;
  @Input() hasStories = false;
  @Input() transcriptReady = false;
  @Input() canMuteMic = false;

  @Input() muteMic = true;
  @Output() muteMicChange = new EventEmitter<boolean>();

  @Output() chooserClosed = new EventEmitter<void>();
  @Output() choice = new EventEmitter<'fcpxml' | 'transcripts'>();
  @Output() showInFolder = new EventEmitter<void>();
  /** The result/error modal was dismissed (backdrop, Done or Close). */
  @Output() dismissed = new EventEmitter<void>();
}
