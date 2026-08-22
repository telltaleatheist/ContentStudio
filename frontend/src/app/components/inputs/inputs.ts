import { Component, signal, OnInit, effect, OnDestroy, ViewChild, ElementRef } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatListModule } from '@angular/material/list';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatCardModule } from '@angular/material/card';
import { MatBadgeModule } from '@angular/material/badge';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatExpansionModule } from '@angular/material/expansion';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { ElectronService } from '../../services/electron';
import { TextSubjectDialog } from '../text-subject-dialog/text-subject-dialog';
import { NotesDialog } from '../notes-dialog/notes-dialog';
import { SplitReviewDialog, SplitReviewDialogData, SplitReviewDialogResult } from '../split-review-dialog/split-review-dialog';
import { EditTextSubjectDialog, EditTextSubjectData } from '../edit-text-subject-dialog/edit-text-subject-dialog';
import { PromptViewDialog } from '../prompt-view-dialog/prompt-view-dialog';
import {
  StoryPickerDialog,
  StoryPickerDialogData,
  StoryPickerDialogResult,
} from '../story-picker-dialog/story-picker-dialog';
import {
  isDriftWarning,
  type CandidateScan,
  type DriftProbe,
  type TranscriptCandidate,
  type TranscriptChoice,
  type TranscriptLink,
} from '../../features/transcript-link/transcript-link.types';
import { InputsStateService, InputItem } from '../../services/inputs-state';
import { JobQueueService, QueuedJob } from '../../services/job-queue';
import { NotificationService } from '../../services/notification';

interface PromptSetOption {
  id: string;
  name: string;
  platform: string;
  instructions_prompt: string;
}


@Component({
  selector: 'app-inputs',
  imports: [
    MatIconModule,
    MatButtonModule,
    MatListModule,
    MatChipsModule,
    MatFormFieldModule,
    MatSelectModule,
    MatDialogModule,
    MatMenuModule,
    MatProgressBarModule,
    MatCheckboxModule,
    MatCardModule,
    MatBadgeModule,
    MatTooltipModule,
    MatExpansionModule,
    FormsModule,
    CommonModule,
    DragDropModule,
  ],
  templateUrl: './inputs.html',
  styleUrl: './inputs.scss',
})
export class Inputs implements OnInit, OnDestroy {
  @ViewChild('scrollContainer') scrollContainer?: ElementRef;

  private elapsedInterval: any;
  private processingInterval: any;

  completionMessage = signal<string>('');
  showCompletionMessage = signal(false);
  queueStarted = signal(false);
  expandedJobIds = signal<Set<string>>(new Set());

  // Universal "Transcribe only" toggle at the top of the Job Queue. When ON,
  // Start Queue transcribes each pending job and STOPS with the prompt held for
  // review ('held' status) instead of sending to the AI; pressing Start Queue
  // again (only held jobs remain) sends them. When OFF, Start Queue transcribes
  // AND sends in one stage (the original behavior).
  transcribeOnly = signal(false);
  // Locked at each Start Queue press so a transcribe run never auto-sends the
  // 'held' jobs it just produced: a run processes only jobs of this status.
  private queueRunTarget: 'pending' | 'held' = 'pending';

  // Available prompt sets
  availablePromptSets = signal<PromptSetOption[]>([]);

  constructor(
    private dialog: MatDialog,
    private electron: ElectronService,
    public inputsState: InputsStateService,
    public jobQueue: JobQueueService,
    private notificationService: NotificationService
  ) {
    // Auto-expand single job in queue
    effect(() => {
      const jobs = this.jobQueue.jobs();
      if (jobs.length === 1) {
        // Auto-expand if there's only one job
        const expanded = this.expandedJobIds();
        if (!expanded.has(jobs[0].id)) {
          const newExpanded = new Set(expanded);
          newExpanded.add(jobs[0].id);
          this.expandedJobIds.set(newExpanded);
        }
      }
    });

    // Ask the editor-transcript question for every video item, as soon as it lands.
    // Deferred out of the reactive pass on purpose: the scan writes signals of its own, and
    // an effect that writes what it read is how a loop starts. Reading inputItems() here is
    // what subscribes this effect to the list.
    effect(() => {
      this.inputsState.inputItems();
      queueMicrotask(() => void this.scanTranscriptCandidates());
    });
  }

  ngOnDestroy() {
    this.stopElapsedTimer();
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
    }
  }

  async ngOnInit() {
    // Load available prompt sets
    await this.loadPromptSets();

    // Load persisted settings only on first initialization
    if (!this.inputsState.hasLoadedSettings()) {
      try {
        const settings = await this.electron.getSettings();
        if (settings.promptSet) {
          this.inputsState.masterPromptSet.set(settings.promptSet);
        }
        this.inputsState.markSettingsLoaded();
        this.ensureRealPromptSetSelected();
      } catch (error) {
        this.notificationService.error('Settings Error', 'Failed to load settings: ' + (error as Error).message);
      }
    }
  }

  async loadPromptSets() {
    try {
      const result = await this.electron.listPromptSets();
      if (result.success) {
        this.availablePromptSets.set(result.promptSets);
        this.ensureRealPromptSetSelected();
      }
    } catch (error) {
      this.notificationService.error('Prompt Sets Error', 'Failed to load prompt sets: ' + (error as Error).message);
    }
  }

  /**
   * Make sure the selected channel is one that EXISTS.
   *
   * A stored selection can name a channel a later build removed, and a fresh install has no
   * stored selection at all. Either way the picker must show what will actually be used: the
   * first channel the main process listed, chosen here and visible in the dropdown, rather than
   * an id that quietly resolves to nothing when the run starts.
   */
  private ensureRealPromptSetSelected(): void {
    const available = this.availablePromptSets();
    if (available.length === 0) return;
    const current = this.inputsState.masterPromptSet();
    if (current && available.some((set) => set.id === current)) return;
    this.inputsState.masterPromptSet.set(available[0].id);
  }

  get selectedItems(): InputItem[] {
    return this.inputsState.inputItems().filter(item => item.selected);
  }

  get hasSelectedItems(): boolean {
    return this.selectedItems.length > 0;
  }

  get allItemsSelected(): boolean {
    const items = this.inputsState.inputItems();
    return items.length > 0 && items.every(item => item.selected);
  }

  toggleSelectAll() {
    const allSelected = this.allItemsSelected;
    this.inputsState.inputItems().forEach((_, index) => {
      this.toggleItemSelection(index, !allSelected);
    });
  }

  toggleItemSelection(index: number, value?: boolean) {
    const items = this.inputsState.inputItems();
    const newSelected = value !== undefined ? value : !items[index].selected;
    const updatedItems = [...items];
    updatedItems[index] = { ...updatedItems[index], selected: newSelected };
    this.inputsState.inputItems.set(updatedItems);
  }

  // Master prompt set changed - update all individual items
  onMasterPromptSetChange(promptSetId: string) {
    this.inputsState.masterPromptSet.set(promptSetId);

    // ALWAYS update all items to use this prompt set
    // (whether in compilation mode or not - the dropdowns just get disabled in compilation mode)
    const items = this.inputsState.inputItems();
    const updatedItems = items.map(item => ({
      ...item,
      promptSet: promptSetId
    }));
    this.inputsState.inputItems.set(updatedItems);
  }

  // Compilation mode toggled
  onCompilationModeChange(isCompilation: boolean) {
    this.inputsState.compilationMode.set(isCompilation);

    // If turning ON compilation mode, set all items to use master prompt set
    if (isCompilation) {
      const items = this.inputsState.inputItems();
      const updatedItems = items.map(item => ({
        ...item,
        promptSet: this.inputsState.masterPromptSet()
      }));
      this.inputsState.inputItems.set(updatedItems);
    }
  }

  // Individual item prompt set changed
  updateItemPromptSet(index: number, promptSetId: string) {
    const items = this.inputsState.inputItems();
    const updatedItems = [...items];
    updatedItems[index] = { ...updatedItems[index], promptSet: promptSetId };
    this.inputsState.inputItems.set(updatedItems);
  }

  openTextSubjectDialog() {
    const dialogRef = this.dialog.open(TextSubjectDialog, {
      width: '600px',
      disableClose: false
    });

    dialogRef.afterClosed().subscribe(result => {
      if (result) {
        const lines = result.split('\n').filter((line: string) => line.trim());
        lines.forEach((subject: string) => {
          const content = subject.trim();
          const displayName = content.length > 50 ? content.substring(0, 50) + '...' : content;
          this.inputsState.addItem({
            type: 'subject',
            path: content,
            displayName: displayName,
            icon: 'text_fields',
            selected: true,
            promptSet: this.inputsState.masterPromptSet(),
            textContent: content
          });
        });
      }
    });
  }

  async browseFiles() {
    const result = await this.electron.selectFiles();
    if (result.success && result.files.length > 0) {
      for (const filePath of result.files) {
        const isDir = await this.electron.isDirectory(filePath);
        // Handle both Windows (\) and Unix (/) path separators
        const fileName = filePath.split(/[/\\]/).pop() || filePath;

        if (isDir) {
          this.inputsState.addItem({
            type: 'directory',
            path: filePath,
            displayName: fileName,
            icon: 'folder',
            selected: true,
            promptSet: this.inputsState.masterPromptSet()
          });
        } else {
          const ext = fileName.split('.').pop()?.toLowerCase() || '';
          let icon = 'description';
          let type = 'file';

          if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v'].includes(ext)) {
            icon = 'movie';
            type = 'video';
          } else if (['mp3', 'wav', 'aiff', 'aif', 'm4a', 'aac', 'flac', 'ogg', 'wma'].includes(ext)) {
            icon = 'audiotrack';
            type = 'video';
          } else if (ext === 'txt') {
            icon = 'text_fields';
            type = 'transcript';
          } else if (ext === 'json') {
            // AutoCutStudio transcript JSON — same as the Import Transcript button.
            icon = 'record_voice_over';
            type = 'transcript-import';
          }

          this.inputsState.addItem({
            type,
            path: filePath,
            displayName: fileName,
            icon,
            selected: true,
            promptSet: this.inputsState.masterPromptSet(),
            generateChapters: (type === 'video' || type === 'transcript-import') ? true : undefined
          });
        }
      }
    }
  }

  /**
   * Import one or more AutoCutStudio transcript JSON files. Each valid file
   * becomes an input named after its story title; when its job runs, the
   * transcript is loaded directly (no Whisper) and metadata is generated as usual.
   */
  async importTranscript() {
    const result = await this.electron.importTranscript();

    if (result.errors?.length) {
      result.errors.forEach(err =>
        this.notificationService.warning('Transcript Import', err));
    }

    if (result.success && result.items.length > 0) {
      for (const item of result.items) {
        this.inputsState.addItem({
          type: 'transcript-import',
          path: item.path,
          displayName: item.title,
          icon: 'record_voice_over',
          selected: true,
          promptSet: this.inputsState.masterPromptSet(),
          generateChapters: true,
        });
      }
      const count = result.items.length;
      this.notificationService.success(
        'Transcript Import',
        `Imported ${count} transcript${count === 1 ? '' : 's'} — ready to generate (transcription skipped).`
      );
    }
  }

  // Drag and drop support
  isDraggingOver = signal(false);

  onDragOver(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingOver.set(true);
  }

  onDragLeave(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingOver.set(false);
  }

  async onDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingOver.set(false);

    if (!event.dataTransfer?.files) return;

    const files = Array.from(event.dataTransfer.files);

    for (const file of files) {
      // @ts-ignore - file.path is available in Electron
      const filePath = file.path;
      if (!filePath) continue;

      const isDir = await this.electron.isDirectory(filePath);
      const fileName = file.name;

      if (isDir) {
        this.inputsState.addItem({
          type: 'directory',
          path: filePath,
          displayName: fileName,
          icon: 'folder',
          selected: true,
          promptSet: this.inputsState.masterPromptSet()
        });
      } else {
        const ext = fileName.split('.').pop()?.toLowerCase() || '';
        let icon = 'description';
        let type = 'file';

        if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v'].includes(ext)) {
          icon = 'movie';
          type = 'video';
        } else if (['mp3', 'wav', 'aiff', 'aif', 'm4a', 'aac', 'flac', 'ogg', 'wma'].includes(ext)) {
          icon = 'audiotrack';
          type = 'video';
        } else if (ext === 'txt') {
          icon = 'text_fields';
          type = 'transcript';
        } else if (ext === 'json') {
          // AutoCutStudio transcript JSON — same as the Import Transcript button.
          icon = 'record_voice_over';
          type = 'transcript-import';
        }

        this.inputsState.addItem({
          type,
          path: filePath,
          displayName: fileName,
          icon,
          selected: true,
          promptSet: this.inputsState.masterPromptSet(),
          generateChapters: (type === 'video' || type === 'transcript-import') ? true : undefined
        });
      }
    }
  }

  removeInput(index: number) {
    this.inputsState.removeItem(index);
  }

  onInputDrop(event: CdkDragDrop<InputItem[]>) {
    if (event.previousIndex !== event.currentIndex) {
      this.inputsState.reorderItems(event.previousIndex, event.currentIndex);
    }
  }

  toggleChapterGeneration(index: number, value: boolean) {
    const items = this.inputsState.inputItems();
    const updatedItems = [...items];
    updatedItems[index] = { ...updatedItems[index], generateChapters: value };
    this.inputsState.inputItems.set(updatedItems);
  }

  // ==================== Editor transcript link (Phase 2) ====================
  //
  // An OFFER, not a question. A video item may be linked to the editor story it was cut
  // from, and then the content fields are written from that story's ad-free transcript
  // instead of the final export's; chapters never move. Nothing blocks on it, nothing is
  // pre-selected, and an item nobody touched runs exactly as it did before Phase 2.
  //
  // The finder still only hints — 75% of the 40 live exports get a candidate and about 1
  // in 4 of those is the wrong story — so a hint is offered in the menu and never taken
  // on the operator's behalf. What IS recorded, on every run, is which branch it took and
  // why: linked, declared final-only, or unlinked by default. See PHASE-1-2-SPEC.md §3.2.

  /** Scan results keyed by item.path. Not persisted: it is a fact about disk, re-read each session. */
  transcriptScans = signal<Record<string, CandidateScan>>({});
  /** Paths with a scan in flight, so the row can say so instead of looking empty. */
  transcriptScanning = signal<string[]>([]);
  /** Drift per (video, candidate transcript). Keyed by the pair — one .mov, several candidates. */
  transcriptDrift = signal<Record<string, DriftProbe>>({});
  /**
   * Why a drift probe failed, same key. Kept so "not measured" and "still measuring" stay
   * distinguishable — an absent entry means in flight, and only in flight.
   */
  driftFailures = signal<Record<string, string>>({});
  /** Paths whose picker dialog is open, so the button can't be double-fired. */
  pickingTranscriptFor = signal<string | null>(null);

  /** Only real video items are asked. A subject or an imported transcript has no final export. */
  canLinkTranscript(item: InputItem): boolean {
    return item.type === 'video';
  }

  driftKey(videoPath: string, transcriptPath: string): string {
    // A separator that cannot occur in a path, so the pair is a key and not a
    // coincidence of two paths that concatenate the same way.
    return videoPath + '\u0000' + transcriptPath;
  }

  scanFor(item: InputItem): CandidateScan | null {
    return this.transcriptScans()[item.path] || null;
  }

  isScanningTranscript(item: InputItem): boolean {
    return this.transcriptScanning().includes(item.path);
  }

  driftFor(item: InputItem, candidate: TranscriptCandidate): DriftProbe | null {
    return this.transcriptDrift()[this.driftKey(item.path, candidate.transcriptPath)] || null;
  }

  /**
   * Find the candidates for every video item that has not been scanned yet.
   *
   * Called after each of the four ways an item can arrive. Finding nothing is not a
   * decision and is not written onto the item: the row simply says nothing matched and
   * what was searched, and the run records the default-unlinked mode with that same
   * description attached — which is what keeps final-only a declared mode rather than a
   * fallback (spec §3.2).
   */
  private async scanTranscriptCandidates(): Promise<void> {
    // Every video the operator could be offered a link for: the ones on the page AND the
    // ones already sitting in a pending job. A queued item that was cleared off the Inputs
    // list still needs a scan, or its row has no candidates to offer and the run records a
    // default with nothing to say about what was searched.
    const byPath = new Map<string, InputItem>();
    for (const item of this.inputsState.inputItems()) byPath.set(item.path, item);
    for (const job of this.jobQueue.getPendingJobs()) {
      for (const item of job.inputs) if (!byPath.has(item.path)) byPath.set(item.path, item);
    }

    const pending = [...byPath.values()].filter(item =>
      this.canLinkTranscript(item) &&
      !this.transcriptScans()[item.path] &&
      !this.transcriptScanning().includes(item.path));
    if (pending.length === 0) return;

    // Claim ALL of them before the first await. Items arrive in bursts and every arrival
    // fires the effect again, so a claim made one-at-a-time inside the loop would let a
    // second pass pick up items this one has not reached yet and scan them twice.
    this.transcriptScanning.set([...this.transcriptScanning(), ...pending.map(i => i.path)]);

    for (const item of pending) {
      const res = await this.electron.transcriptFindCandidates(item.path);
      this.transcriptScanning.set(this.transcriptScanning().filter(p => p !== item.path));

      if (!res.success) {
        // A scan that cannot run is stated, not smoothed over: the row will show that the
        // question could not be asked, and Start Queue will still demand an answer.
        this.notificationService.error(
          'Editor transcript',
          `Could not look for an editor story for ${item.displayName}: ${res.error}`);
        continue;
      }

      const scan = res.data;
      this.transcriptScans.set({ ...this.transcriptScans(), [item.path]: scan });

      for (const problem of scan.problems) {
        this.notificationService.warning('Editor transcript', problem);
      }

      // Drift is part of the offer, so measure it before the menu is opened. Nothing to
      // measure when nothing matched, and nothing is decided either way.
      if (scan.candidates.length > 0) {
        void this.probeCandidateDrift(item.path, scan);
      }
    }
  }

  /** ffprobe the export once per candidate, so the row can show the drift line up front. */
  private async probeCandidateDrift(videoPath: string, scan: CandidateScan): Promise<void> {
    for (const candidate of scan.candidates) {
      if (!candidate.ref) continue;   // nothing linkable: nothing to measure against
      const res = await this.electron.transcriptProbeDrift(videoPath, candidate.ref);
      const key = this.driftKey(videoPath, candidate.transcriptPath);
      if (!res.success) {
        // Record the FAILURE, not nothing. Leaving the entry absent is indistinguishable
        // from "still in flight", and the row would say "measuring…" for ever.
        this.notificationService.warning(
          'Editor transcript',
          `Could not measure drift for "${candidate.storyTitle}": ${res.error}`);
        this.driftFailures.set({ ...this.driftFailures(), [key]: res.error || 'the probe failed' });
        continue;
      }
      this.transcriptDrift.set({ ...this.transcriptDrift(), [key]: res.data });
    }
  }

  /**
   * Write a decision onto the item, by path — an index goes stale across an await.
   *
   * ALSO writes it onto the same input inside any job already waiting in the queue.
   * `addJob` snapshots the items, so without this a link made after queueing would never
   * reach the run: the operator would pick a story on the Inputs row and the queued
   * snapshot would still be unlinked. The queue is where the decision has to land,
   * because the queue is what runs.
   */
  private setTranscriptChoice(itemPath: string, choice: TranscriptChoice): void {
    const items = this.inputsState.inputItems();
    const index = items.findIndex(it => it.path === itemPath);
    if (index !== -1) {
      const updated = [...items];
      updated[index] = { ...updated[index], transcriptChoice: choice };
      this.inputsState.inputItems.set(updated);
    }

    for (const job of this.jobQueue.getPendingJobs()) {
      if (!job.inputs.some(it => it.path === itemPath)) continue;
      this.jobQueue.updateJob(job.id, {
        inputs: job.inputs.map(it =>
          it.path === itemPath ? { ...it, transcriptChoice: choice } : it),
      });
    }
  }

  /** The operator picked one of the hinted candidates. */
  chooseCandidate(item: InputItem, candidate: TranscriptCandidate): void {
    // The template only renders this button when `ref` is set, so reaching here without one
    // means the two disagree. Say so rather than absorbing the click silently.
    if (!candidate.ref) {
      this.notificationService.error(
        'Editor transcript',
        `"${candidate.storyTitle}" cannot be linked: ${candidate.refUnavailableReason}`);
      return;
    }
    const drift = this.driftFor(item, candidate);
    this.setTranscriptChoice(item.path, {
      mode: 'linked',
      // Stamp the moment of the decision, not the moment of the scan.
      ref: { ...candidate.ref, linkedAt: new Date().toISOString() },
      driftSec: drift ? drift.driftSec : null,
      driftPct: drift ? drift.driftPct : null,
    });
  }

  /** The operator declared there is no editor story for this one. */
  chooseFinalOnly(item: InputItem): void {
    this.setTranscriptChoice(item.path, {
      mode: 'final-only',
      reason: 'declared by the operator: content fields come from the final export\'s transcript, ' +
        'including any sponsor reads',
    });
  }

  /** Open the picker. Progressive scope; whatever comes back is recorded as a manual link. */
  openStoryPicker(item: InputItem): void {
    const scan = this.scanFor(item);
    this.pickingTranscriptFor.set(item.path);

    const dialogRef = this.dialog.open(StoryPickerDialog, {
      width: '860px',
      maxWidth: '95vw',
      data: {
        videoName: item.displayName,
        week: scan ? scan.scannedWeek : null,
      } as StoryPickerDialogData,
    });

    dialogRef.afterClosed().subscribe(async (outcome: StoryPickerDialogResult | undefined) => {
      this.pickingTranscriptFor.set(null);
      if (!outcome) return;

      // Measure this story against THIS export before recording the choice — a manually
      // picked story is exactly the case where drift is worth seeing.
      let driftSec: number | null = null;
      let driftPct: number | null = null;
      const probe = await this.electron.transcriptProbeDrift(item.path, outcome.ref);
      if (probe.success) {
        driftSec = probe.data.driftSec;
        driftPct = probe.data.driftPct;
        this.transcriptDrift.set({
          ...this.transcriptDrift(),
          [this.driftKey(item.path, outcome.candidate.transcriptPath)]: probe.data,
        });
      } else {
        this.notificationService.warning(
          'Editor transcript',
          `Linked "${outcome.candidate.storyTitle}" but could not measure drift: ${probe.error}`);
      }

      this.setTranscriptChoice(item.path, { mode: 'linked', ref: outcome.ref, driftSec, driftPct });
    });
  }

  /** "Export it now" straight from the row, for the single-candidate case. */
  async exportStoryTranscripts(item: InputItem, candidate: TranscriptCandidate): Promise<void> {
    if (this.exportingTranscriptsFor()) return;
    this.exportingTranscriptsFor.set(item.path);
    const res = await this.electron.transcriptExportStories(candidate.projectFolder);
    this.exportingTranscriptsFor.set(null);

    if (!res.success) {
      this.notificationService.error('Export story transcripts', res.error || 'the export failed');
      return;
    }
    this.notificationService.success(
      'Export story transcripts',
      `Wrote ${res.data.storiesEmitted} transcript(s) to ${res.data.transcriptsDir}`);

    // Re-scan: the candidate that had no transcript now has one, and so do its siblings.
    this.forgetTranscriptScan(item.path);
    await this.scanTranscriptCandidates();
  }

  /**
   * Drop everything measured about one video so the next pass re-reads it.
   *
   * Clears the drift entries too: they are keyed by (video, transcript path) and a freshly
   * exported transcript at the same path is a DIFFERENT file. Keeping the old number would
   * show a measurement of something that no longer exists.
   */
  private forgetTranscriptScan(itemPath: string): void {
    const scans = { ...this.transcriptScans() };
    delete scans[itemPath];
    this.transcriptScans.set(scans);

    const prefix = itemPath + '\u0000';
    const keep = (map: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(map).filter(([k]) => !k.startsWith(prefix)));
    this.transcriptDrift.set(keep(this.transcriptDrift()) as Record<string, DriftProbe>);
    this.driftFailures.set(keep(this.driftFailures()) as Record<string, string>);
  }

  /** Ask again for one item after a scan failed, or after the week changed on disk. */
  async retryTranscriptScan(item: InputItem): Promise<void> {
    this.forgetTranscriptScan(item.path);
    await this.scanTranscriptCandidates();
  }

  exportingTranscriptsFor = signal<string | null>(null);

  /** Which of the five things the row can be saying. Drives the icon and the tint. */
  transcriptState(item: InputItem): 'linked' | 'declared' | 'unlinked' | 'scanning' | 'unavailable' {
    const choice = item.transcriptChoice;
    if (choice) return choice.mode === 'linked' ? 'linked' : 'declared';
    if (this.isScanningTranscript(item)) return 'scanning';
    return this.scanFor(item) ? 'unlinked' : 'unavailable';
  }

  /** The one line the row shows. Short enough to sit beside the trigger without wrapping. */
  transcriptStateText(item: InputItem): string {
    const choice = item.transcriptChoice;
    if (choice && choice.mode === 'linked') {
      const drift = choice.driftPct === null
        ? 'drift not measured'
        : `${choice.driftPct > 0 ? '+' : ''}${choice.driftPct.toFixed(1)}% vs final`;
      return `${choice.ref.storyTitle} · ${choice.ref.sourceSession} · ${drift}`;
    }
    if (choice) return 'final export only';
    if (this.isScanningTranscript(item)) return 'looking…';

    const scan = this.scanFor(item);
    // No scan at all is NOT "nothing matched": the lookup never ran, and saying it did
    // would be the row asserting a search it did not perform.
    if (!scan) return 'not linked — the lookup did not run';
    if (scan.candidates.length === 0) return 'not linked — nothing matched';
    return scan.candidates.length === 1
      ? 'not linked — 1 story matches'
      : `not linked — ${scan.candidates.length} stories match`;
  }

  /** The whole account, for the operator who wants to know why the line says that. */
  transcriptStateTooltip(item: InputItem): string {
    const choice = item.transcriptChoice;
    if (choice && choice.mode === 'linked') {
      const drift = choice.driftPct === null
        ? 'drift could not be measured'
        : `${Math.abs(choice.driftPct).toFixed(1)}% ${choice.driftPct < 0 ? 'shorter' : 'longer'} ` +
          'than the story';
      return `Content fields come from story ${choice.ref.storyNumber} "${choice.ref.storyTitle}" ` +
        `of session ${choice.ref.sourceSession} (${choice.ref.via}). The final cut is ${drift}. ` +
        'Chapters still come from the final export.';
    }

    const tail = 'Content fields come from the final export\'s own transcript, sponsor reads ' +
      'included. Chapters come from the same transcript, as they always do.';
    if (choice) return `Declared final export only. ${tail}`;

    const scan = this.scanFor(item);
    const searched = scan ? ` Searched ${scan.searchedDescription}.` : '';
    return `No editor story is linked, which is the default.${searched} ${tail}`;
  }

  /** The leading glyph. One icon per state, no second meaning loaded onto colour alone. */
  transcriptStateIcon(item: InputItem): string {
    switch (this.transcriptState(item)) {
      case 'linked': return 'link';
      case 'declared': return 'movie';
      case 'scanning': return 'search';
      case 'unavailable': return 'help_outline';
      default: return 'link_off';
    }
  }

  /** The candidates the menu offers, or none — the template must not unwrap the scan. */
  candidatesFor(item: InputItem): TranscriptCandidate[] {
    const scan = this.scanFor(item);
    return scan ? scan.candidates : [];
  }

  /** Is this the candidate the item is currently linked to? */
  isChosenCandidate(item: InputItem, candidate: TranscriptCandidate): boolean {
    const choice = item.transcriptChoice;
    return !!choice && choice.mode === 'linked' && choice.ref.path === candidate.transcriptPath;
  }

  /** The secondary line under a menu entry: where the story came from, and how far apart. */
  candidateMeta(item: InputItem, candidate: TranscriptCandidate): string {
    const via = candidate.via === 'exact-title' ? 'exact title' : 'label match';
    const head = `${candidate.sourceSession} · ${via}`;
    if (!candidate.ref) {
      return `${head} · ${candidate.refUnavailableReason || 'no usable transcript'}`;
    }
    const failure = this.driftFailures()[this.driftKey(item.path, candidate.transcriptPath)];
    if (failure) return `${head} · drift not measured: ${failure}`;
    const drift = this.driftFor(item, candidate);
    if (!drift) return `${head} · measuring drift…`;
    const shorter = drift.driftSec < 0 ? 'shorter' : 'longer';
    return `${head} · final cut ${Math.abs(drift.driftPct).toFixed(1)}% ${shorter} ` +
      `(${drift.driftSec > 0 ? '+' : ''}${drift.driftSec.toFixed(1)}s)`;
  }

  /**
   * Does this row paint as a warning?
   *
   * Only for a link the operator actually made. An unlinked row is the ordinary case now
   * and has nothing to warn about — drift is a fact about a link, not about a candidate
   * nobody chose.
   */
  rowIsWarning(item: InputItem): boolean {
    const choice = item.transcriptChoice;
    return !!choice && choice.mode === 'linked' && isDriftWarning(choice.driftPct);
  }

  // ==================== Split episode ====================

  // Which item's split modal is currently open (disables its button).
  splittingIndex = signal<number | null>(null);

  isTranscriptImport(item: InputItem): boolean {
    if (item.type === 'transcript-import') return true;
    // Also recognize a transcript .json added via Browse Files / drag-drop
    // (which may have been classified as a generic 'file' before it was routed
    // to the transcript-import type). Text subjects store content in `path`, so
    // exclude them.
    if (item.type === 'text-subject' || item.type === 'subject') return false;
    return item.path?.toLowerCase().endsWith('.json') ?? false;
  }

  /** Open the split modal for a transcript. The modal runs AI chapter detection
   *  on demand and lets the user group chapters into stories; on confirm the
   *  item is fanned into N transcript-import queue items. */
  openSplitDialog(index: number) {
    const item = this.inputsState.inputItems()[index];
    if (!item || !this.isTranscriptImport(item) || this.splittingIndex() !== null) return;

    this.splittingIndex.set(index);
    const dialogRef = this.dialog.open(SplitReviewDialog, {
      width: '860px',
      data: {
        filePath: item.path,
        title: item.displayName,
      } as SplitReviewDialogData,
    });

    dialogRef.afterClosed().subscribe(async (outcome: SplitReviewDialogResult | undefined) => {
      this.splittingIndex.set(null);
      if (!outcome || !outcome.cuts || outcome.cuts.length < 1) return;

      // Re-locate by path: the list may have changed while the dialog was open.
      const curIndex = this.inputsState.inputItems().findIndex(it => it.path === item.path);
      if (curIndex === -1) return;

      const commit = await this.electron.commitTranscriptSplit(item.path, outcome.cuts);
      if (!commit.success || !commit.items) {
        this.notificationService.error('Split Episode', commit.error || 'Failed to write split stories.');
        return;
      }

      const newItems: InputItem[] = commit.items.map(s => ({
        type: 'transcript-import',
        path: s.path,
        displayName: s.displayName,
        icon: 'record_voice_over',
        selected: true,
        promptSet: item.promptSet,
        generateChapters: item.generateChapters !== false,
      }));
      this.inputsState.replaceItemAt(curIndex, newItems);
      this.notificationService.success('Split Episode', `Split into ${newItems.length} stories.`);
    });
  }

  openNotesDialog(index: number) {
    const item = this.inputsState.inputItems()[index];
    const dialogRef = this.dialog.open(NotesDialog, {
      width: '600px',
      data: {
        itemName: item.displayName,
        notes: item.notes || ''
      }
    });

    dialogRef.afterClosed().subscribe(result => {
      if (result !== undefined) {
        // Update the item's notes
        const items = this.inputsState.inputItems();
        const updatedItems = [...items];
        updatedItems[index] = { ...updatedItems[index], notes: result || undefined };
        this.inputsState.inputItems.set(updatedItems);
      }
    });
  }

  openEditTextSubjectDialog(index: number) {
    const item = this.inputsState.inputItems()[index];
    const dialogRef = this.dialog.open(EditTextSubjectDialog, {
      width: '650px',
      data: {
        content: item.textContent || item.path || ''
      } as EditTextSubjectData
    });

    dialogRef.afterClosed().subscribe((result: EditTextSubjectData | undefined) => {
      if (result) {
        const items = this.inputsState.inputItems();
        const updatedItems = [...items];
        // Use first line (up to 50 chars) as display name
        const firstLine = result.content.split('\n')[0].trim();
        const displayName = firstLine.length > 50 ? firstLine.substring(0, 50) + '...' : firstLine;
        updatedItems[index] = {
          ...updatedItems[index],
          displayName: displayName || 'Text Subject',
          textContent: result.content,
          path: result.content // Keep path in sync for backwards compatibility
        };
        this.inputsState.inputItems.set(updatedItems);
      }
    });
  }

  isTextSubject(item: InputItem): boolean {
    return item.type === 'text-subject' || item.type === 'subject';
  }

  clearAllInputs() {
    // Clear all input items
    this.inputsState.inputItems.set([]);
  }

  addToQueue() {
    if (this.selectedItems.length === 0) return;

    // In compilation mode, create a single job with all selected items
    if (this.inputsState.compilationMode()) {
      const items = this.selectedItems;
      const promptSet = this.inputsState.masterPromptSet();

      let jobName: string;
      if (items.length === 1) {
        jobName = `${items[0].displayName} (compilation)`;
      } else {
        const firstName = items[0].displayName;
        const truncatedName = firstName.length > 30 ? firstName.substring(0, 30) + '...' : firstName;
        jobName = `${truncatedName} + ${items.length - 1} more (compilation)`;
      }

      this.jobQueue.addJob(jobName, items, promptSet, 'compilation');
    } else {
      // Individual mode - each item becomes its own job (like creamsicle)
      this.selectedItems.forEach(item => {
        this.jobQueue.addJob(item.displayName, [item], item.promptSet, 'individual');
      });
    }

    // Deselect all items after adding to queue
    this.inputsState.inputItems().forEach((_, index) => {
      this.toggleItemSelection(index, false);
    });

    // Scroll to bottom to show the job queue
    this.scrollToBottom();
  }

  private scrollToBottom() {
    // Use setTimeout to wait for DOM to update
    setTimeout(() => {
      if (this.scrollContainer) {
        const element = this.scrollContainer.nativeElement;
        element.scrollTo({
          top: element.scrollHeight,
          behavior: 'smooth'
        });
      }
    }, 100);
  }

  async startQueue() {
    console.log('[StartQueue] Button clicked, queueStarted:', this.queueStarted());
    if (this.queueStarted()) {
      console.log('[StartQueue] Already started, returning');
      return;
    }

    // Claim the guard immediately so a rapid double-click can't launch two
    // queue processor loops during the awaits below. Reset on early-return
    // error paths so the user can retry.
    this.queueStarted.set(true);

    // Validate output directory before starting
    try {
      console.log('[StartQueue] Getting settings...');
      const settings = await this.electron.getSettings();
      const outputDir = settings.outputDirectory;
      console.log('[StartQueue] Output directory:', outputDir);

      if (!outputDir) {
        console.log('[StartQueue] No output directory configured');
        this.notificationService.error('Configuration Error', 'No output directory configured. Please set one in Settings before processing.');
        this.queueStarted.set(false);
        return;
      }

      // Check if directory exists
      console.log('[StartQueue] Checking directory...');
      const dirCheck = await this.electron.checkDirectory(outputDir);
      console.log('[StartQueue] Directory check result:', dirCheck);

      if (!dirCheck.exists) {
        console.log('[StartQueue] Directory does not exist');
        this.notificationService.error('Directory Error', `Output directory does not exist: ${outputDir}\n\nPlease create the directory or choose a different one in Settings.`);
        this.queueStarted.set(false);
        return;
      }

      // Check if directory is writable
      if (!dirCheck.writable) {
        console.log('[StartQueue] Directory not writable');
        this.notificationService.error('Permission Error', `Output directory is not writable: ${outputDir}\n\nPlease check permissions or choose a different directory in Settings.`);
        this.queueStarted.set(false);
        return;
      }
    } catch (error) {
      console.error('[StartQueue] Error validating directory:', error);
      this.notificationService.error('Directory Error', 'Failed to validate output directory. Please check your settings.');
      this.queueStarted.set(false);
      return;
    }

    // NOTHING is refused for lacking an editor-story link. Linking is optional: an item
    // nobody linked runs on the final export's own transcript, which is what every item
    // did before Phase 2, and the run records that it took that branch by default rather
    // than by declaration (see `inputTranscripts` below).

    // RE-VALIDATE every declared link before the run starts.
    //
    // A link is a claim about a file on an external volume, made minutes or days ago. The
    // spec is explicit that a declared link whose file is missing or changed FAILS the run
    // rather than quietly falling back to final-only, and that a re-exported session must
    // never be reused silently — so this is where the claim is checked, once, loudly.
    const stale: string[] = [];
    for (const job of this.jobQueue.getPendingJobs()) {
      for (const item of job.inputs) {
        const choice = item.transcriptChoice;
        if (!choice || choice.mode !== 'linked') continue;
        const res = await this.electron.transcriptResolveRef(choice.ref);
        if (!res.success) {
          stale.push(`• ${item.displayName}: the link could not be checked — ${res.error}`);
          continue;
        }
        if (res.data.state === 'missing') {
          stale.push(`• ${item.displayName}: linked transcript is gone — ${res.data.reason}`);
        } else if (res.data.state === 'changed') {
          stale.push(`• ${item.displayName}: linked transcript changed — ${res.data.reason}`);
        }
      }
    }

    if (stale.length > 0) {
      this.notificationService.error(
        'Editor transcript link is no longer valid',
        `${stale.length} linked ${stale.length === 1 ? 'item' : 'items'} cannot run as ` +
        `declared. Re-confirm each link (or choose "Final export only") before starting:\n` +
        `${stale.join('\n')}`);
      this.queueStarted.set(false);
      return;
    }

    // Lock this run's target: if any pending jobs exist we transcribe them
    // (Stage 1 when "Transcribe only" is on; full run when off). Only once there
    // are no pending jobs does a Start Queue press send the held jobs (Stage 2).
    this.queueRunTarget = this.jobQueue.getPendingJobs().length > 0 ? 'pending' : 'held';

    console.log('[StartQueue] Starting queue processor... target:', this.queueRunTarget);
    this.jobQueue.isProcessing.set(true);
    this.startQueueProcessor();
  }

  private stopElapsedTimer() {
    if (this.elapsedInterval) {
      clearInterval(this.elapsedInterval);
      this.elapsedInterval = null;
    }
  }

  private startQueueProcessor() {
    // Check for pending jobs every second
    this.processingInterval = setInterval(() => {
      this.processNextJob();
    }, 1000);
  }

  private async processNextJob() {
    // Don't start a new job if one is already processing
    if (this.jobQueue.hasProcessingJob()) {
      return;
    }

    // A run processes only jobs matching the target locked at Start Queue time,
    // so a "transcribe" run never sweeps up the 'held' jobs it just created.
    const nextJob = this.queueRunTarget === 'held'
      ? this.jobQueue.getNextHeldJob()
      : this.jobQueue.getNextPendingJob();

    if (!nextJob) {
      // No more jobs of this run's target - stop processing
      if (this.queueStarted()) {
        this.queueStarted.set(false);
        this.jobQueue.isProcessing.set(false);
        if (this.processingInterval) {
          clearInterval(this.processingInterval);
          this.processingInterval = null;
        }
      }
      return;
    }

    if (this.queueRunTarget === 'held') {
      // Stage 2: send an already-transcribed job to the AI, reusing its transcript.
      await this.sendHeldJob(nextJob, { advanceQueue: true });
    } else {
      // Stage 1 (transcribeOnly) transcribes + holds; a normal run transcribes + sends.
      await this.runJob(nextJob, { showPrompt: this.transcribeOnly(), advanceQueue: true });
    }
  }

  /**
   * Runs a single job end-to-end: marks it processing, wires the elapsed timer
   * and the Python progress listener, calls generateMetadata, and finalizes the
   * job (success/failure). Used both by the queue processor (advanceQueue:true)
   * and by the per-job "Analyze" / "Show prompt" buttons (advanceQueue:false).
   *
   * With opts.showPrompt the backend transcribes + assembles the prompt but skips
   * the AI call, resolving { held: true, prompts }. In that case we pop the prompt
   * preview modal instead of completing the job.
   *
   * The normal (advanceQueue:true) path is behavior-identical to the original
   * processNextJob: the `settled` terminal-event guard, all progress handling and
   * the finally teardown are preserved exactly. The only advance-gating change is
   * that processNextJob() is now called only when opts.advanceQueue is true, so a
   * single-job button run never kicks the whole queue.
   */
  private async runJob(job: QueuedJob, opts: { showPrompt?: boolean; advanceQueue?: boolean }): Promise<void> {
    const nextJob = job;

    // Mark job as processing
    this.jobQueue.updateJob(nextJob.id, {
      status: 'processing',
      progress: 0,
      currentlyProcessing: 'Starting...'
    });

    const startTime = Date.now();
    let elapsedInterval: any;
    let unsubscribe: (() => void) | undefined;
    // Guards against finalizing twice: the backend sends a terminal
    // 'complete'/'error' progress event AND the generateMetadata promise
    // resolves. Whichever arrives first finalizes the job; the other is ignored.
    let settled = false;

    try {
      // Start elapsed time tracker for this job
      elapsedInterval = setInterval(() => {
        const job = this.jobQueue.getJob(nextJob.id);
        if (!job) return;

        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        let currentlyProcessing: string;
        if (elapsed < 60) {
          currentlyProcessing = `Processing... (${elapsed}s)`;
        } else {
          const minutes = Math.floor(elapsed / 60);
          const seconds = elapsed % 60;
          currentlyProcessing = `Processing... (${minutes}m ${seconds}s)`;
        }
        this.jobQueue.updateJob(nextJob.id, { currentlyProcessing });
      }, 1000);

      // Track progress from Python backend
      const totalItems = nextJob.inputs.length;
      let currentItemIndex = 0;

      // Helper to find item index by filename
      const findItemIndexByFilename = (filename: string): number => {
        const job = this.jobQueue.getJob(nextJob.id);
        if (!job) return -1;

        // Extract just the filename from the full path in progress.filename
        const baseFilename = filename.split('/').pop() || filename;

        // Find matching item by comparing filenames
        for (let i = 0; i < job.inputs.length; i++) {
          const itemFilename = job.inputs[i].path.split('/').pop() || '';
          if (itemFilename === baseFilename) {
            return i;
          }
        }
        return -1;
      };

      // Track which item is currently being generated (only one at a time for AI)
      let generatingItemIndex = -1;

      // Listen for progress updates from Python
      unsubscribe = this.electron.onProgress((progress: any) => {
        const job = this.jobQueue.getJob(nextJob.id);
        if (!job) return;

        // Terminal events from the backend: finalize the job here so the UI can
        // never hang on "generating" if the generateMetadata promise is delayed
        // or lost. The post-await block below is skipped once `settled` is set.
        if ((progress.phase === 'complete' || progress.phase === 'error') && !settled) {
          settled = true;
          if (progress.phase === 'complete') {
            for (let i = 0; i < job.inputs.length; i++) {
              this.jobQueue.updateItemProgress(nextJob.id, i, 100, 'completed');
            }
            const processingTime = (Date.now() - startTime) / 1000;
            this.jobQueue.updateJob(nextJob.id, {
              status: 'completed', progress: 100, currentlyProcessing: 'Complete!',
              completedAt: new Date(), processingTime
            });
            this.showCompletionMessageFor(`Job "${nextJob.name}" completed in ${processingTime.toFixed(1)}s`);
            this.notificationService.success('Job Completed', `"${nextJob.name}" completed successfully in ${processingTime.toFixed(1)}s`);
          } else {
            job.itemProgress.forEach((item, i) => {
              if (item.status !== 'completed' && item.status !== 'failed') {
                this.jobQueue.updateItemProgress(nextJob.id, i, 100, 'failed');
              }
            });
            this.jobQueue.updateJob(nextJob.id, {
              status: 'failed', progress: 0, currentlyProcessing: 'Failed',
              completedAt: new Date(), error: progress.message
            });
            this.notificationService.error('Job Failed', `"${nextJob.name}" failed: ${progress.message || 'Unknown error'}`);
          }
          // Tear down this job's listener/timer and advance the queue now, rather
          // than waiting on the (possibly stuck) promise's finally block.
          if (unsubscribe) unsubscribe();
          if (elapsedInterval) clearInterval(elapsedInterval);
          if (opts.advanceQueue) this.processNextJob();
          return;
        }

        // Handle preparing phase (when starting a new video for transcription)
        if (progress.phase === 'preparing' && progress.filename) {
          // Use itemIndex from backend if available, otherwise find by filename
          let itemIndex = progress.itemIndex;
          if (itemIndex === undefined) {
            itemIndex = findItemIndexByFilename(progress.filename);
          }

          if (itemIndex !== undefined && itemIndex >= 0) {
            currentItemIndex = itemIndex;
            this.jobQueue.updateItemProgress(nextJob.id, itemIndex, 0, 'transcribing');
          }
          this.jobQueue.updateJob(nextJob.id, { currentlyProcessing: `Processing: ${progress.filename}` });
        }

        // Update current item progress based on transcription phase
        if (progress.phase === 'transcription' && progress.percent !== undefined) {
          // Use itemIndex from backend (supports concurrent transcriptions)
          let itemIndex = progress.itemIndex;

          // Fallback: find by filename if itemIndex not provided
          if (itemIndex === undefined && progress.filename) {
            itemIndex = findItemIndexByFilename(progress.filename);
          }

          // Update the specific item's progress (supports multiple concurrent transcriptions)
          if (itemIndex !== undefined && itemIndex >= 0 && itemIndex < totalItems) {
            const transcriptionProgress = Math.floor(progress.percent / 2); // Map 0-100 to 0-50

            // Mark as transcribed when transcription hits 100%
            if (progress.percent === 100) {
              this.jobQueue.updateItemProgress(nextJob.id, itemIndex, 50, 'transcribed');
            } else {
              this.jobQueue.updateItemProgress(nextJob.id, itemIndex, transcriptionProgress, 'transcribing');
            }

            // Update job-level message with "Transcribing..."
            const message = progress.message || `Transcribing: ${progress.filename || ''}`;
            this.jobQueue.updateJob(nextJob.id, { currentlyProcessing: message });
          }

          // Calculate overall progress (transcription is first 50% of total job)
          const transcribedItems = job.itemProgress.filter(p =>
            p.status === 'transcribed' || p.status === 'generating' || p.status === 'completed'
          ).length;

          // Count items currently transcribing and sum their progress
          const transcribingItems = job.itemProgress.filter(p => p.status === 'transcribing');
          const transcribingProgress = transcribingItems.reduce((sum, item) => sum + (item.progress || 0), 0);

          // Overall progress = (completed items + sum of in-progress items) / total items * 50%
          const overallProgress = ((transcribedItems + (transcribingProgress / 50)) / totalItems) * 50;
          this.jobQueue.updateJob(nextJob.id, { progress: Math.min(overallProgress, 49) });
        }

        // Handle metadata generation phase (AI summarization and generation)
        if (progress.phase === 'generating' && progress.percent !== undefined) {
          const job = this.jobQueue.getJob(nextJob.id);

          // Use itemIndex from backend if provided, otherwise find first transcribed item
          if (progress.itemIndex !== undefined) {
            const itemIndex = progress.itemIndex;

            // Update the specific item's progress
            if (itemIndex >= 0 && itemIndex < totalItems) {
              // If this is a new item starting (0%), mark the previous item as completed
              if (progress.percent === 0 && itemIndex > 0 && job) {
                const prevIndex = itemIndex - 1;
                const prevStatus = job.itemProgress[prevIndex]?.status;
                if (prevStatus === 'generating') {
                  this.jobQueue.updateItemProgress(nextJob.id, prevIndex, 100, 'completed');
                }
              }

              // Map AI progress from 0-100 to 50-100 (second half of item's progress bar)
              const aiProgress = 50 + Math.floor(progress.percent / 2);
              this.jobQueue.updateItemProgress(nextJob.id, itemIndex, aiProgress, 'generating');

              generatingItemIndex = itemIndex;
              currentItemIndex = itemIndex;
            }

            // If generation complete (100%), mark item as completed
            if (progress.percent === 100 && itemIndex >= 0) {
              this.jobQueue.updateItemProgress(nextJob.id, itemIndex, 100, 'completed');
            }
          } else {
            // Fallback to old behavior if itemIndex not provided
            if (job) {
              const nextToGenerate = job.itemProgress.findIndex(p => p.status === 'transcribed');
              if (nextToGenerate !== -1 && generatingItemIndex !== nextToGenerate) {
                generatingItemIndex = nextToGenerate;
                currentItemIndex = nextToGenerate;
              }
            }

            if (generatingItemIndex >= 0 && generatingItemIndex < totalItems) {
              const aiProgress = 50 + Math.floor(progress.percent / 2);
              this.jobQueue.updateItemProgress(nextJob.id, generatingItemIndex, aiProgress, 'generating');
            }

            if (progress.percent === 100 && generatingItemIndex >= 0) {
              this.jobQueue.updateItemProgress(nextJob.id, generatingItemIndex, 100, 'completed');
              generatingItemIndex = -1;
            }
          }

          // Update message to show what's happening in AI phase
          const message = progress.message || 'Generating metadata...';
          this.jobQueue.updateJob(nextJob.id, { currentlyProcessing: message });

          // Calculate overall progress (50-100% for generation phase)
          if (job) {
            const completedItems = job.itemProgress.filter(p => p.status === 'completed').length;
            const generatingItems = job.itemProgress.filter(p => p.status === 'generating').length;
            const currentGenProgress = generatingItems > 0 ? (progress.percent || 0) / 100 : 0;
            const overallProgress = 50 + ((completedItems + currentGenProgress) / totalItems) * 50;
            this.jobQueue.updateJob(nextJob.id, { progress: Math.min(overallProgress, 99) });
          }
        }
      });

      // Extract inputs with notes
      // For text subjects, use textContent as the path (the actual content to analyze)
      const inputs = nextJob.inputs.map(item => ({
        path: item.type === 'text-subject' || item.type === 'subject' ? (item.textContent || item.path) : item.path,
        notes: item.notes
      }));

      // Extract chapter flags for video files (only for YouTube individual jobs)
      const chapterFlags: { [path: string]: boolean } = {};
      const isYouTube = this.isYouTubePromptSet(nextJob.promptSet);
      const isIndividual = nextJob.mode === 'individual';

      // Only generate chapters for YouTube videos in individual mode
      if (isYouTube && isIndividual) {
        nextJob.inputs.forEach(item => {
          console.log('Processing item:', item.type, item.path, 'generateChapters:', item.generateChapters);
          // Videos and imported transcripts both carry timestamped segments, so
          // both can produce chapters.
          if ((item.type === 'video' || item.type === 'transcript-import') && item.generateChapters !== false) {
            chapterFlags[item.path] = true;
          }
        });
      }

      console.log('Chapter flags being sent:', chapterFlags, '(YouTube:', isYouTube, ', Individual:', isIndividual, ')');

      // What each input declares about its content transcript, keyed the same way
      // chapterFlags is. EVERY linkable input gets an entry, including the ones nobody
      // touched: linking is optional, and "he left it unlinked" is a mode this run took,
      // not an absence. The three values are distinct on purpose (spec §3.2) —
      //
      //   a TranscriptRef              he linked this story
      //   via: 'declared'              he picked "Final export only" on the row
      //   via: 'default-unlinked'      he linked nothing; the final export writes the
      //                                content fields, as it did before Phase 2
      //   no entry at all              nothing to link (subject, imported transcript)
      //
      // so the report can say which branch ran and why, and can never imply a decision
      // nobody made. Compilation mode gets per-input entries like any other.
      const inputTranscripts: { [path: string]: TranscriptLink } = {};
      nextJob.inputs.forEach(item => {
        if (!this.canLinkTranscript(item)) return;

        const choice = item.transcriptChoice;
        if (choice) {
          // Nested, not chained: this compilation unit runs without `strict`, so a union
          // only narrows on a bare discriminant test — `choice && choice.mode === ...`
          // leaves the other branch un-narrowed and `choice.reason` fails to compile.
          if (choice.mode === 'linked') {
            inputTranscripts[item.path] = choice.ref;
          } else {
            inputTranscripts[item.path] = {
              kind: 'final-only', via: 'declared', reason: choice.reason,
            };
          }
          return;
        }

        // The default. It carries what the scan searched when there was a scan, so the
        // report can state that nothing matched rather than merely that nothing was
        // chosen — and says so plainly when the lookup never ran at all.
        const scan = this.transcriptScans()[item.path];
        inputTranscripts[item.path] = {
          kind: 'final-only',
          via: 'default-unlinked',
          reason: scan
            ? `no editor story was linked — ${scan.searchedDescription}`
            : 'no editor story was linked; the lookup did not run for this item',
        };
      });

      console.log('Input transcripts being sent:', inputTranscripts);

      const result = await this.electron.generateMetadata({
        inputs,
        promptSet: nextJob.promptSet,
        mode: nextJob.mode,
        jobId: nextJob.id,
        jobName: nextJob.name,
        chapterFlags,
        inputTranscripts,
        showPrompt: opts.showPrompt
      });

      // Show-prompt path: the backend transcribed + assembled the prompt, is
      // holding the transcript, and skipped the AI call (no terminal 'complete'
      // event fires — we key off result.held). Tear down the transcription
      // listener/timer and pop the preview modal instead of completing the job.
      if (result?.held === true) {
        if (unsubscribe) { unsubscribe(); unsubscribe = undefined; }
        if (elapsedInterval) { clearInterval(elapsedInterval); elapsedInterval = undefined; }
        // Chapters run during prompt assembly (they condition the prompt), so this
        // path can carry warnings too — surface them BEFORE the user decides whether
        // to send a prompt that may have been assembled without chapter subjects.
        if (result.warnings?.length) {
          result.warnings.forEach((warning: string) => {
            this.notificationService.warning('Generation Warning', warning);
          });
        }
        const prompt = (result.prompts || []).join('\n\n' + '─'.repeat(60) + '\n\n');
        // Mark the job transcribed & waiting. The backend holds the transcript; the
        // assembled prompt is captured for the view-only "Show prompt" modal; the job
        // now waits for the next Start Queue press (Stage 2) to send it. No modal here.
        const heldJob = this.jobQueue.getJob(nextJob.id);
        if (heldJob) {
          for (let i = 0; i < heldJob.inputs.length; i++) {
            this.jobQueue.updateItemProgress(nextJob.id, i, 100, 'transcribed');
          }
        }
        this.jobQueue.updateJob(nextJob.id, {
          status: 'held',
          progress: 100,
          currentlyProcessing: 'Transcribed — ready to send',
          heldPrompt: prompt
        });
        return;
      }

      const processingTime = ((Date.now() - startTime) / 1000);

      // Surface any backend warnings (partial item failures, chapters that
      // couldn't be generated) regardless of overall success/failure
      if (result.warnings?.length) {
        result.warnings.forEach((warning: string) => {
          this.notificationService.warning('Generation Warning', warning);
        });
      }

      if (settled) {
        // Already finalized by the terminal 'complete'/'error' progress event.
        // Just attach output files if the resolved result carries them.
        if (result?.success && result.output_files) {
          this.jobQueue.updateJob(nextJob.id, { outputFiles: result.output_files });
        }
      } else if (result.success) {
        // Mark all items as completed
        const job = this.jobQueue.getJob(nextJob.id);
        if (job) {
          for (let i = 0; i < job.inputs.length; i++) {
            this.jobQueue.updateItemProgress(nextJob.id, i, 100, 'completed');
          }
        }

        this.jobQueue.updateJob(nextJob.id, {
          status: 'completed',
          progress: 100,
          currentlyProcessing: 'Complete!',
          completedAt: new Date(),
          outputFiles: result.output_files,
          processingTime
        });

        // Show completion message
        this.showCompletionMessageFor(`Job "${nextJob.name}" completed in ${processingTime.toFixed(1)}s`);
        this.notificationService.success('Job Completed', `"${nextJob.name}" completed successfully in ${processingTime.toFixed(1)}s`);
      } else {
        // Mark every item that never reached a terminal state as failed;
        // otherwise siblings stay stuck on 'transcribing'/'generating' forever
        const job = this.jobQueue.getJob(nextJob.id);
        if (job) {
          job.itemProgress.forEach((item, i) => {
            if (item.status !== 'completed' && item.status !== 'failed') {
              this.jobQueue.updateItemProgress(nextJob.id, i, 100, 'failed');
            }
          });
        }

        this.jobQueue.updateJob(nextJob.id, {
          status: 'failed',
          progress: 0,
          currentlyProcessing: 'Failed',
          completedAt: new Date(),
          error: result.error,
          processingTime
        });

        // Show error notification only (not on-screen banner)
        this.notificationService.error('Job Failed', `"${nextJob.name}" failed: ${result.error}`);
      }
    } catch (error) {
      this.notificationService.error('Job Processing Error', `Error processing job: ${(error as Error).message}`);

      // Mark every non-terminal item as failed so nothing stays stuck
      const job = this.jobQueue.getJob(nextJob.id);
      if (job) {
        job.itemProgress.forEach((item, i) => {
          if (item.status !== 'completed' && item.status !== 'failed') {
            this.jobQueue.updateItemProgress(nextJob.id, i, 100, 'failed');
          }
        });
      }

      this.jobQueue.updateJob(nextJob.id, {
        status: 'failed',
        progress: 0,
        currentlyProcessing: 'Error',
        completedAt: new Date(),
        error: String(error)
      });
    } finally {
      // Tear down the progress listener and timer on every path so a failed
      // job's listener can't rewrite its progress from later jobs' events
      if (unsubscribe) unsubscribe();
      if (elapsedInterval) clearInterval(elapsedInterval);
      // After job completes (success or failure), process next job in queue —
      // but only when this run owns the queue (single-job button runs must not).
      if (opts.advanceQueue) this.processNextJob();
    }
  }

  // ==================== Job Queue: view prompt / send held ====================

  /**
   * View-only "Show prompt" for a transcribed ('held') job: opens the modal with
   * the already-assembled prompt for reading/copying. No transcription and no AI
   * call — sending is done by pressing Start Queue again.
   */
  viewPrompt(job: QueuedJob) {
    if (!job.heldPrompt) return;
    this.dialog.open(PromptViewDialog, {
      data: { prompt: job.heldPrompt, jobName: job.name },
      width: '900px',
      maxWidth: '95vw'
    });
  }

  /**
   * Stage 2 of the "Transcribe only" flow: send an already-transcribed ('held')
   * job to the AI, reusing the transcript the backend is holding (no re-transcribe).
   * sendHeldPrompt emits 'generating' + terminal 'complete'/'error'; a lightweight
   * listener only animates the bar and we finalize from the resolved result.
   * Advances the queue when opts.advanceQueue is set.
   */
  private async sendHeldJob(job: QueuedJob, opts: { advanceQueue?: boolean }) {
    const startTime = Date.now();

    // Transcription already ran; jump straight into generation.
    this.jobQueue.updateJob(job.id, {
      status: 'processing',
      progress: 50,
      currentlyProcessing: 'Generating metadata...',
      heldPrompt: undefined
    });
    const startJob = this.jobQueue.getJob(job.id);
    if (startJob) {
      for (let i = 0; i < startJob.itemProgress.length; i++) {
        this.jobQueue.updateItemProgress(job.id, i, 50, 'generating');
      }
    }

    let unsubscribe: (() => void) | undefined;

    try {
      unsubscribe = this.electron.onProgress((progress: any) => {
        const cur = this.jobQueue.getJob(job.id);
        if (!cur) return;
        // Animate only; finalization happens from the resolved value below.
        if (progress.phase === 'generating' && progress.percent !== undefined) {
          const message = progress.message || 'Generating metadata...';
          const overall = 50 + Math.floor((progress.percent || 0) / 2);
          this.jobQueue.updateJob(job.id, {
            currentlyProcessing: message,
            progress: Math.min(overall, 99)
          });
        }
      });

      const result = await this.electron.sendHeldPrompt(job.id);
      const processingTime = ((Date.now() - startTime) / 1000);

      if (result.warnings?.length) {
        result.warnings.forEach((warning: string) => {
          this.notificationService.warning('Generation Warning', warning);
        });
      }

      if (result.success) {
        const cur = this.jobQueue.getJob(job.id);
        if (cur) {
          for (let i = 0; i < cur.inputs.length; i++) {
            this.jobQueue.updateItemProgress(job.id, i, 100, 'completed');
          }
        }
        this.jobQueue.updateJob(job.id, {
          status: 'completed',
          progress: 100,
          currentlyProcessing: 'Complete!',
          completedAt: new Date(),
          outputFiles: result.output_files,
          processingTime
        });
        this.showCompletionMessageFor(`Job "${job.name}" completed in ${processingTime.toFixed(1)}s`);
        this.notificationService.success('Job Completed', `"${job.name}" completed successfully in ${processingTime.toFixed(1)}s`);
      } else {
        const cur = this.jobQueue.getJob(job.id);
        if (cur) {
          cur.itemProgress.forEach((item, i) => {
            if (item.status !== 'completed' && item.status !== 'failed') {
              this.jobQueue.updateItemProgress(job.id, i, 100, 'failed');
            }
          });
        }
        this.jobQueue.updateJob(job.id, {
          status: 'failed',
          progress: 0,
          currentlyProcessing: 'Failed',
          completedAt: new Date(),
          error: result.error,
          processingTime
        });
        this.notificationService.error('Job Failed', `"${job.name}" failed: ${result.error}`);
      }
    } catch (error) {
      this.notificationService.error('Job Processing Error', `Error processing job: ${(error as Error).message}`);
      const cur = this.jobQueue.getJob(job.id);
      if (cur) {
        cur.itemProgress.forEach((item, i) => {
          if (item.status !== 'completed' && item.status !== 'failed') {
            this.jobQueue.updateItemProgress(job.id, i, 100, 'failed');
          }
        });
      }
      this.jobQueue.updateJob(job.id, {
        status: 'failed',
        progress: 0,
        currentlyProcessing: 'Error',
        completedAt: new Date(),
        error: String(error)
      });
    } finally {
      if (unsubscribe) unsubscribe();
      // Advance the queue only when this run owns it (Stage 2 queue processing).
      if (opts.advanceQueue) this.processNextJob();
    }
  }

  private showCompletionMessageFor(message: string) {
    this.completionMessage.set(message);
    this.showCompletionMessage.set(true);

    // Auto-hide after 5 seconds
    setTimeout(() => {
      this.showCompletionMessage.set(false);
    }, 5000);
  }

  dismissCompletionMessage() {
    this.showCompletionMessage.set(false);
  }

  toggleJobExpansion(jobId: string) {
    const expanded = this.expandedJobIds();
    const newExpanded = new Set(expanded);
    if (newExpanded.has(jobId)) {
      newExpanded.delete(jobId);
    } else {
      newExpanded.add(jobId);
    }
    this.expandedJobIds.set(newExpanded);
  }

  isJobExpanded(jobId: string): boolean {
    return this.expandedJobIds().has(jobId);
  }

  clearCompletedJobs() {
    this.jobQueue.clearCompletedJobs();
  }

  async cancelJob(jobId: string) {
    // Call backend to cancel the job
    const result = await this.electron.cancelJob(jobId);

    if (result.success) {
      // Update job status to cancelled
      this.jobQueue.updateJob(jobId, {
        status: 'failed',
        currentlyProcessing: 'Cancelled by user',
        error: 'Job cancelled by user'
      });

      this.notificationService.info('Job Cancelled', 'The job has been cancelled.');
    } else {
      this.notificationService.error('Cancel Failed', result.error || 'Failed to cancel job');
    }
  }

  removeJob(jobId: string) {
    // Free any held transcript the backend is keeping for this job so it can't leak.
    const job = this.jobQueue.getJob(jobId);
    if (job?.status === 'held') {
      void this.electron.discardHeldPrompt(jobId);
    }
    this.jobQueue.removeJob(jobId);
  }

  removeItemFromJob(jobId: string, itemIndex: number) {
    const job = this.jobQueue.getJob(jobId);
    if (!job) {
      console.warn('[Inputs] Cannot remove item: job not found:', jobId);
      return;
    }

    // Build new arrays instead of mutating the signal-held job in place, and
    // keep inputs / itemProgress spliced in lockstep so progress math stays sane
    const newInputs = job.inputs.filter((_, i) => i !== itemIndex);

    // If no items left, remove the entire job
    if (newInputs.length === 0) {
      console.log('[Inputs] Last item removed, removing entire job');
      this.removeJob(jobId);
      return;
    }

    const newItemProgress = job.itemProgress.filter((_, i) => i !== itemIndex);

    // Adjust the currently-processing pointer: shift down if it referenced an
    // item after the removed one, then clamp into the new bounds
    let newCurrentItemIndex = job.currentItemIndex;
    if (newCurrentItemIndex > itemIndex) {
      newCurrentItemIndex -= 1;
    }
    if (newCurrentItemIndex > newItemProgress.length - 1) {
      newCurrentItemIndex = newItemProgress.length - 1;
    }

    console.log(`[Inputs] Removed item ${itemIndex} from job ${jobId}. ${newInputs.length} items remaining.`);
    this.jobQueue.updateJob(jobId, {
      inputs: newInputs,
      itemProgress: newItemProgress,
      currentItemIndex: newCurrentItemIndex
    });
  }

  getJobStatusIcon(status: string): string {
    switch (status) {
      case 'pending': return 'schedule';
      case 'processing': return 'hourglass_empty';
      case 'held': return 'pause_circle';
      case 'completed': return 'check_circle';
      case 'failed': return 'error';
      default: return 'help';
    }
  }

  getJobStatusColor(status: string): string {
    switch (status) {
      case 'pending': return 'accent';
      case 'processing': return 'primary';
      case 'held': return 'accent';
      case 'completed': return 'primary';
      case 'failed': return 'warn';
      default: return '';
    }
  }

  // Helper to get prompt set name by ID
  getPromptSetName(promptSetId: string): string {
    const promptSet = this.availablePromptSets().find(ps => ps.id === promptSetId);
    return promptSet ? promptSet.name : promptSetId;
  }

  // Helper to get prompt set platform icon
  getPromptSetIcon(promptSetId: string): string {
    const promptSet = this.availablePromptSets().find(ps => ps.id === promptSetId);
    return promptSet?.platform === 'youtube' ? 'video_library' : 'podcasts';
  }

  // Helper to check if a prompt set is YouTube platform
  isYouTubePromptSet(promptSetId: string): boolean {
    const promptSet = this.availablePromptSets().find(ps => ps.id === promptSetId);
    return promptSet?.platform === 'youtube';
  }

  // Helper to check if chapters should be available for an item
  canGenerateChapters(item: InputItem): boolean {
    // Chapters available for any video, transcript file, or imported transcript
    return item.type === 'video' || item.type === 'transcript' || item.type === 'transcript-import';
  }

  // Master chapters checkbox helpers
  hasVideoItems(): boolean {
    return this.inputsState.inputItems().some(item => this.canGenerateChapters(item));
  }

  allChaptersEnabled(): boolean {
    const videoItems = this.inputsState.inputItems().filter(item => this.canGenerateChapters(item));
    if (videoItems.length === 0) return false;
    return videoItems.every(item => item.generateChapters !== false);
  }

  someChaptersEnabled(): boolean {
    const videoItems = this.inputsState.inputItems().filter(item => this.canGenerateChapters(item));
    if (videoItems.length === 0) return false;
    return videoItems.some(item => item.generateChapters !== false);
  }

  toggleAllChapters(enabled: boolean) {
    const items = this.inputsState.inputItems();
    const updatedItems = items.map(item => {
      if (this.canGenerateChapters(item)) {
        return { ...item, generateChapters: enabled };
      }
      return item;
    });
    this.inputsState.inputItems.set(updatedItems);
  }

  // Global queue progress helpers
  getGlobalQueueProgress(): number {
    const jobs = this.jobQueue.jobs();
    if (jobs.length === 0) return 0;

    const totalProgress = jobs.reduce((sum, job) => {
      if (job.status === 'completed') return sum + 100;
      if (job.status === 'failed') return sum + 100;
      return sum + job.progress;
    }, 0);

    return totalProgress / jobs.length;
  }

  getCompletedJobsCount(): number {
    return this.jobQueue.jobs().filter(job =>
      job.status === 'completed' || job.status === 'failed'
    ).length;
  }

  // Job-level progress helpers
  getJobProgress(job: QueuedJob): number {
    if (job.status === 'completed') return 100;
    if (job.status === 'failed') return 100;
    if (job.inputs.length === 0) return 0;

    // Sum up actual progress of all items (0-100 each)
    const totalProgress = job.itemProgress.reduce((sum, item, index) => {
      return sum + this.getItemProgress(job, index);
    }, 0);

    return totalProgress / job.inputs.length;
  }

  getCompletedItemsCount(job: QueuedJob): number {
    return job.itemProgress.filter(item =>
      item.status === 'completed' || item.status === 'failed'
    ).length;
  }

  // Item-level progress helpers
  isItemCompleted(job: QueuedJob, itemIndex: number): boolean {
    return job.itemProgress[itemIndex]?.status === 'completed';
  }

  isItemProcessing(job: QueuedJob, itemIndex: number): boolean {
    const status = job.itemProgress[itemIndex]?.status;
    return status === 'transcribing' || status === 'generating';
  }

  isItemTranscribed(job: QueuedJob, itemIndex: number): boolean {
    return job.itemProgress[itemIndex]?.status === 'transcribed';
  }

  getItemStatusText(job: QueuedJob, itemIndex: number): string {
    const item = job.itemProgress[itemIndex];
    const status = item?.status;
    switch (status) {
      case 'transcribing':
        // Progress is stored as 0-50 (half of total), multiply by 2 to get transcription %
        const transcribePercent = Math.min(100, (item?.progress || 0) * 2);
        return `Transcribing ${transcribePercent}%`;
      case 'transcribed': return 'Transcribed';
      case 'generating': return 'Generating...';
      case 'completed': return 'Completed';
      case 'failed': return 'Failed';
      default: return 'Pending';
    }
  }

  getItemStatusClass(job: QueuedJob, itemIndex: number): string {
    return job.itemProgress[itemIndex]?.status || 'pending';
  }

  getItemProgress(job: QueuedJob, itemIndex: number): number {
    const item = job.itemProgress[itemIndex];
    if (!item) return 0;

    if (item.status === 'completed') return 100;
    if (item.status === 'failed') return 100;
    if (item.status === 'transcribed') return 50; // Transcription done, generation pending
    if (item.status === 'transcribing' || item.status === 'generating') return item.progress;

    return 0;
  }
}
