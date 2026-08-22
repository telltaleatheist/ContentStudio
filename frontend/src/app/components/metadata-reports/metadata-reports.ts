import { Component, ElementRef, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { MatCardModule } from '@angular/material/card';
import { MatListModule } from '@angular/material/list';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatChipsModule } from '@angular/material/chips';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { ElectronService } from '../../services/electron';
import { NotificationService } from '../../services/notification';
import { PublishState } from '../../features/publish/publish-state';
import { YouTubePushDialog, YouTubePushDialogData } from '../../features/publish/youtube-push-dialog';
import { MAX_AB_VARIANTS } from '../../features/publish/publish.types';
import {
  basename,
  describePublishAt,
  formatBytes,
  offsetLabel,
  offsetStringFor,
  splitPublishAt,
} from '../../features/publish/publish-schedule';

interface MetadataReport {
  name: string;
  path: string;
  date: Date;
  size: number;
  promptSet?: string; // The prompt set used for generation
  displayTitle?: string; // The actual title from the metadata
  txtFolder?: string; // Path to the folder containing txt files
  jobId?: string; // The job ID this item belongs to
  /**
   * The item's permanent id — what a delete names, and the only field here that keeps
   * meaning after a sibling is removed.
   *
   * Optional ONLY because the pre-`.contentstudio/metadata` legacy layout below has no
   * items to have ids: those rows are folders. Every row built from a job file has one,
   * and a job item without one is reported as corrupt rather than listed.
   */
  itemId?: string;
  itemIndex?: number; // Position within the job — for reading items[], never for identity
  txtFilePath?: string; // The TXT file this item recorded, when it recorded one
  selected?: boolean; // Selection state for batch operations
}

interface ParsedMetadata {
  titles: string[];
  thumbnail_text: string[];
  description: string;
  tags: string | string[]; // Can be comma-separated string OR array
  hashtags: string;
  pinned_comment?: string[]; // Pinned comment suggestions
  clip_suggestions?: string[]; // Shorts-able moment suggestions
  chapters?: Array<{ timestamp: string; title: string; sequence: number }>; // YouTube chapter markers
  // Why this item has no chapters, as the run recorded it on the job JSON. Shown where
  // the chapter list would have been — a report read later has no other account of it.
  chaptersSkipped?: { outcome: 'failed' | 'skipped'; reason: string };
  _title?: string; // The display title from the source
  _prompt_set?: string; // The prompt set used for generation
}

@Component({
  selector: 'app-metadata-reports',
  standalone: true,
  imports: [
    MatCardModule,
    MatListModule,
    MatIconModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    MatChipsModule,
    MatCheckboxModule,
    MatDialogModule
  ],
  templateUrl: './metadata-reports.html',
  styleUrl: './metadata-reports.scss'
})
export class MetadataReports implements OnInit {
  reports = signal<MetadataReport[]>([]);
  selectedReport = signal<MetadataReport | null>(null);
  metadata = signal<ParsedMetadata | null>(null);
  isLoading = signal(false);
  reportsDirectory = signal('');

  // Track copied state for visual feedback
  copiedItem = signal<string | null>(null);
  private copiedTimeout: any = null;

  // Publish feature: the operator's chosen A/B titles for the open item. Held in a
  // shared service rather than local state so features/publish/ owns the selection —
  // this component only renders it. That's the single seam between the generator UI
  // and the publish feature.
  readonly publish = inject(PublishState);
  readonly MAX_AB_VARIANTS = MAX_AB_VARIANTS;

  constructor(
    private electron: ElectronService,
    private notificationService: NotificationService,
    private dialog: MatDialog
  ) {}

  /**
   * Toggle a title into/out of the A/B set. Click order becomes variant order —
   * variant 1 is YouTube's fallback when a test is inconclusive, so it's a real choice.
   */
  async toggleChosenTitle(title: any, event: MouseEvent) {
    // The row's own click handler copies to clipboard; picking shouldn't also copy.
    event.stopPropagation();
    await this.publish.toggleTitle(this.getTitleText(title));
  }

  isTitleChosen(title: any): boolean {
    return this.publish.isChosen(this.getTitleText(title));
  }

  /** 1-based variant number, or null when the title isn't picked. */
  titleVariantNumber(title: any): number | null {
    return this.publish.variantNumber(this.getTitleText(title));
  }

  /** True when the 3-variant cap blocks picking this one. */
  isTitleBlocked(title: any): boolean {
    return this.publish.isBlocked(this.getTitleText(title));
  }

  // -------------------------------------------------------------- publish panel
  //
  // The panel above Titles. Everything it edits lives in PublishState — what is here is
  // the two schedule boxes and the handlers that turn one click into one call.
  //
  // The boxes hold LOCAL WALL-CLOCK text with no zone in it, which is not yet a moment;
  // PublishState composes it with the offset in effect on that date before anything is
  // saved. That is why the offset is printed next to them rather than assumed.

  /** The operator's draft, or null for "show what is stored". */
  readonly scheduleDateDraft = signal<string | null>(null);
  readonly scheduleTimeDraft = signal<string | null>(null);

  /** What the date box shows: the draft if there is one, else the stored schedule. */
  readonly scheduleDate = computed(() => {
    const draft = this.scheduleDateDraft();
    if (draft !== null) return draft;
    const at = this.publish.publishAt();
    return at ? splitPublishAt(at).date : '';
  });

  readonly scheduleTime = computed(() => {
    const draft = this.scheduleTimeDraft();
    if (draft !== null) return draft;
    const at = this.publish.publishAt();
    return at ? splitPublishAt(at).time : '';
  });

  /** A moment needs both halves. Until then there is nothing to compose. */
  readonly scheduleComplete = computed(() => !!this.scheduleDate() && !!this.scheduleTime());

  /**
   * The offset the boxes will be composed with.
   *
   * The one in effect ON THAT DATE, which is not always the one in effect today — that
   * is the whole reason it is on screen. Before both boxes are filled there is no moment
   * to ask about, so it shows today's.
   */
  readonly scheduleOffset = computed(() => {
    if (!this.scheduleComplete()) return offsetLabel(offsetStringFor(new Date()));
    const at = new Date(`${this.scheduleDate()}T${this.scheduleTime()}:00`);
    if (Number.isNaN(at.getTime())) return offsetLabel(offsetStringFor(new Date()));
    return offsetLabel(offsetStringFor(at));
  });

  /**
   * How the stored schedule reads: local wall time, the offset it is read in, the offset
   * it was stored with, and how far off it is.
   *
   * Computed when the item loads and whenever the schedule changes, so "in 15 days" is
   * as of the last change rather than as of this second. That is the resolution the line
   * is for.
   */
  readonly scheduleDescription = computed(() => {
    const at = this.publish.publishAt();
    return at ? describePublishAt(at) : null;
  });

  /** `1920x1080 · 412 KB · image/png` for whichever image the row is describing. */
  thumbnailFacts(meta: { width: number; height: number; bytes: number; mime: string }): string {
    return `${meta.width}x${meta.height} · ${formatBytes(meta.bytes)} · ${meta.mime}`;
  }

  /** The file's own name — the path itself is on the row's tooltip. */
  fileName(absPath: string): string {
    return basename(absPath);
  }

  /** The picker's value, as a string the <select> can match. '' is "not routed". */
  channelSelectValue(): string {
    return this.publish.selectedChannelId() ?? '';
  }

  /** An explicit choice, including the empty option — see PublishState.chooseChannel. */
  async onChannelChange(event: Event) {
    const value = (event.target as HTMLSelectElement).value;
    await this.publish.chooseChannel(value === '' ? null : value);
  }

  async saveSchedule() {
    await this.publish.setPublishAtLocal(this.scheduleDate(), this.scheduleTime());
    // A rejected schedule keeps what was typed so it can be corrected; an accepted one
    // drops the drafts so the boxes go back to reflecting the record.
    if (this.publish.error()) return;
    this.clearScheduleDrafts();
  }

  async clearSchedule() {
    await this.publish.clearPublishAt();
    if (this.publish.error()) return;
    this.clearScheduleDrafts();
  }

  private clearScheduleDrafts() {
    this.scheduleDateDraft.set(null);
    this.scheduleTimeDraft.set(null);
  }

  async onPodcastChange(checked: boolean) {
    await this.publish.setPodcast(checked);
  }

  /**
   * Pick a thumbnail file.
   *
   * The dialog is unfiltered, and everything about whether the file is usable is decided
   * in the main process against the bytes — so a wrong pick comes back naming the file
   * and the rule instead of being screened out by an extension list that magic bytes
   * disagree with.
   */
  async changeThumbnail() {
    const picked = await this.electron.selectFiles();
    // Cancelling is not a failure and has nothing to report.
    if (!picked.success || picked.files.length === 0) return;
    if (picked.files.length > 1) {
      this.publish.showError(
        `A video has one thumbnail; you picked ${picked.files.length} files. Choose one.`
      );
      return;
    }
    await this.publish.setThumbnail(picked.files[0]);
  }

  // ------------------------------------------------------------- push to YouTube
  //
  // The only control on this page that changes something the audience can see. Two steps,
  // always: a dialog listing exactly what will be sent, then the call. There is no
  // "push without asking" path and there is no batch push — one video at a time, looked at.

  /** An ISO instant as this Mac reads it. Used for push timestamps in the panel. */
  localTime(iso: string): string {
    return describePublishAt(iso).local;
  }

  /** The channel's display name, or its raw id when the registry has no name for it. */
  pushChannelLabel(): string {
    const id = this.publish.channelId();
    if (!id) return 'no channel';
    const known = this.publish.channels().find((c) => c.channelId === id);
    return known ? `${known.name} (${id})` : id;
  }

  /**
   * Confirm, then push.
   *
   * Everything shown in the dialog is the value that will actually be sent: the title is
   * chosen variant 1, the description and tags are the RESOLVED ones (overrides applied,
   * composed in the main process) — the same values the extension would have typed into
   * Studio. Nothing is recomposed here for display.
   */
  async pushToYouTube() {
    const blocked = this.publish.pushBlockedReason();
    if (blocked) {
      this.publish.showError(`Cannot push: ${blocked}`);
      return;
    }

    const description = this.publish.resolvedDescription();
    const tags = this.publish.resolvedTags()
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    const schedule = this.publish.publishAt();
    const thumbnailPath = this.publish.thumbnailPath();
    const preview = this.publish.thumbnailPreview();

    const data: YouTubePushDialogData = {
      videoId: this.publish.videoId()!,
      channelLabel: this.pushChannelLabel(),
      title: this.publish.pushTitle()!,
      descriptionFirstLine: description.split('\n')[0].trim(),
      descriptionChars: description.length,
      tagCount: tags.length,
      tagsPreview: tags.slice(0, 8).join(', ') + (tags.length > 8 ? `, +${tags.length - 8} more` : ''),
      scheduleLabel: schedule ? this.describeScheduleForPush(schedule) : null,
      thumbnailName: thumbnailPath ? this.fileName(thumbnailPath) : null,
      // Only the image already on screen. Reading one here would be a second read of a
      // file the panel has already read, and a slow dialog for no new information.
      thumbnailDataUrl: preview && preview.path === thumbnailPath ? preview.dataUrl : null,
    };

    const confirmed = await firstValueFrom(
      this.dialog.open(YouTubePushDialog, { data, width: '640px' }).afterClosed()
    );
    if (!confirmed) return;

    const receipt = await this.publish.pushToYouTube();
    if (!receipt) return; // the failure is in the banner, verbatim
    this.notificationService.success(
      'Pushed to YouTube',
      `"${receipt.updated.title}" — video ${receipt.videoId} on ${this.pushChannelLabel()}.`
    );
  }

  /** The schedule as the dialog states it: local wall clock, its offset, and the raw instant. */
  private describeScheduleForPush(iso: string): string {
    const when = describePublishAt(iso);
    return `${when.local} (${when.localOffset}) — stored as ${when.raw}`;
  }

  // ------------------------------------------------------------------- editing
  //
  // Titles, description and tags are all editable, but they are NOT written back into the
  // job's report — that file stays the pristine generator output so an item can be
  // regenerated. Edits live in the selection store as overrides, and the extension reads
  // the resolved value. A cleared override means "use the generated value again", which is
  // why revert is a first-class action rather than retyping.

  /**
   * Which ROW is being edited, indexed into the generated title list; null when none.
   *
   * Keyed by row rather than by variant number so any title can be edited, not just the
   * ones already picked — an over-long generated title is otherwise unusable, since it
   * can't be selected until it's shortened.
   */
  readonly editingTitleIndex = signal<number | null>(null);
  readonly titleDraft = signal('');

  /**
   * The inline editor's input, focused explicitly after the row switches to edit mode.
   *
   * The `autofocus` attribute is unreliable on an element the framework creates after
   * first paint, and an editor you have to click twice to use reads as broken.
   */
  @ViewChild('titleInput') private titleInput?: ElementRef<HTMLInputElement>;

  readonly editingDescription = signal(false);
  readonly descriptionDraft = signal('');

  readonly editingTags = signal(false);
  readonly tagsDraft = signal('');

  startEditTitle(title: any, rowIndex: number, event: MouseEvent) {
    event.stopPropagation();
    this.editingTitleIndex.set(rowIndex);
    this.titleDraft.set(this.getTitleText(title));

    // After the row re-renders as an editor. Cursor at the end rather than select-all:
    // these are long titles being tweaked, not replaced wholesale.
    setTimeout(() => {
      const input = this.titleInput?.nativeElement;
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }

  isEditingTitle(rowIndex: number): boolean {
    return this.editingTitleIndex() === rowIndex;
  }

  cancelEditTitle(event?: MouseEvent) {
    event?.stopPropagation();
    this.editingTitleIndex.set(null);
    this.titleDraft.set('');
  }

  async saveEditTitle(original: any, event?: Event) {
    event?.stopPropagation();
    if (this.editingTitleIndex() === null) return;

    await this.publish.saveTitleEdit(this.getTitleText(original), this.titleDraft());
    // A rejected edit leaves the error banner up and the editor open, so the operator can
    // fix it rather than losing what they typed.
    if (this.publish.error()) return;
    this.cancelEditTitle();
  }

  /**
   * What the extension will actually put in the description field.
   *
   * Comes from the main process, which is the ONLY place a description is composed
   * (chapters at the top, hashtags before the link block) and the only place overrides are
   * applied. Composing a second copy here is what made the app show one description while
   * YouTube received another.
   */
  descriptionValue(): string {
    return this.publish.resolvedDescription();
  }

  tagsValue(): string {
    return this.publish.resolvedTags();
  }

  startEditDescription() {
    this.descriptionDraft.set(this.descriptionValue());
    this.editingDescription.set(true);
  }

  cancelEditDescription() {
    this.editingDescription.set(false);
    this.descriptionDraft.set('');
  }

  async saveDescription() {
    await this.publish.setFields({ descriptionOverride: this.descriptionDraft() });
    if (this.publish.error()) return;
    this.editingDescription.set(false);
  }

  /** Drop the override so the generated description flows through again. */
  async revertDescription() {
    await this.publish.setFields({ descriptionOverride: null });
    if (this.publish.error()) return;
    this.cancelEditDescription();
  }

  startEditTags() {
    this.tagsDraft.set(this.tagsValue());
    this.editingTags.set(true);
  }

  cancelEditTags() {
    this.editingTags.set(false);
    this.tagsDraft.set('');
  }

  async saveTags() {
    await this.publish.setFields({ tagsOverride: this.tagsDraft() });
    if (this.publish.error()) return;
    this.editingTags.set(false);
  }

  async revertTags() {
    await this.publish.setFields({ tagsOverride: null });
    if (this.publish.error()) return;
    this.cancelEditTags();
  }

  /** Tags as the extension will type them, split for chip display. */
  editedTagsArray(): string[] {
    return this.tagsValue()
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  }

  async ngOnInit() {
    await this.loadReports();
  }

  async loadReports() {
    try {
      this.isLoading.set(true);

      // Get settings to determine output directory. The backend get-settings
      // handler always returns a populated outputDirectory; if it's somehow
      // empty, show an explicit empty state instead of scanning a guessed path.
      const settings = await this.electron.getSettings();
      const baseDir = settings.outputDirectory;

      if (!baseDir) {
        this.reports.set([]);
        this.reportsDirectory.set('');
        this.notificationService.warning('No Output Directory', 'No output directory configured — set one in Settings.');
        return;
      }

      // New structure: JSON files are in .contentstudio/metadata/
      const metadataJsonDir = `${baseDir}/.contentstudio/metadata`;

      // Bring the files up to schema_version 2 BEFORE listing them, so every row below
      // can require an item id. This is the lazy trigger the migration is designed for:
      // the operator has opened the reports page, which means the output volume is
      // present. Whatever it did is said out loud — a silent migration is indistinguishable
      // from a migration that did not run.
      await this.reportMigrationOutcome();

      // Check if new structure exists
      let result: any = null;
      let readError: string | null = null;
      try {
        result = await this.electron.readDirectory(metadataJsonDir);
      } catch (e) {
        readError = (e as Error).message;
        console.warn('Could not read metadata directory at', metadataJsonDir, e);
      }

      // A missing CURRENT directory and an unreadable one are different things, and this used
      // to treat them identically: any non-success silently fell through to the legacy layout
      // and returned. A genuinely broken read — bad permissions, a disconnected volume, an
      // output directory pointing somewhere that no longer exists — showed the user an empty
      // or partial list with no indication that anything had gone wrong, and no way to tell
      // "you have no reports" from "we could not look".
      //
      // The legacy path is still tried, because old installs really do have that layout, but
      // it is now a documented migration step rather than a catch-all, and a failure of BOTH
      // says so.
      if (!result || !result.success) {
        const legacyFound = await this.loadReportsLegacy(baseDir);
        if (!legacyFound) {
          this.notificationService.error(
            'Could not read reports',
            readError
              ? `${metadataJsonDir} could not be read (${readError}), and no reports were found in the older layout either.`
              : `No reports directory at ${metadataJsonDir}, and none in the older layout either. Check the output directory in Settings.`,
          );
        }
        return;
      }

      this.reportsDirectory.set(metadataJsonDir);

      if (result.files) {
        const reports: MetadataReport[] = [];
        /** Report files that could not be listed. Counted, never silently dropped. */
        const skipped: string[] = [];

        // Read all JSON files
        for (const file of result.files) {
          if (!file.name.endsWith('.json')) continue;

          try {
            const jsonPath = `${metadataJsonDir}/${file.name}`;
            const content = await this.electron.readFile(jsonPath);
            if (content) {
              const jobData = JSON.parse(content);

              // Get the txt folder path
              const txtFolder = jobData.txt_folder || '';
              const jobDate = new Date(jobData.created_at || file.mtime);
              // No `|| file.name` fallback. A report file whose job_id is missing is a
              // corrupt file, not a file to guess an id for: every delete, every publish
              // selection and every draft match is keyed by that id, so inventing one from
              // the filename produces a report the operator can see and nothing can act on.
              // Skipped loudly instead — the file is named in the console and the run
              // continues, because one bad file must not hide the rest.
              const jobId = jobData.job_id;
              if (typeof jobId !== 'string' || !jobId) {
                console.warn(`[MetadataReports] ${file.name} has no job_id — skipped.`);
                skipped.push(file.name);
                continue;
              }

              // A job file with no items array is corrupt, not a job to build a
              // job-shaped row for: the row that used to be built here had no item index
              // and no item id, so it could be clicked (throwing "missing itemIndex") and
              // deleted (deleting nothing), which is worse than not being listed.
              if (!jobData.items || !Array.isArray(jobData.items)) {
                console.warn(`[MetadataReports] ${file.name} has no items array — skipped.`);
                skipped.push(file.name);
                continue;
              }

              // Create a report for EACH item in the job
              jobData.items.forEach((item: any, index: number) => {
                // After migration every item carries a permanent id. One without is a
                // corrupt (or unmigrated, or hand-edited) record, and it is skipped for
                // the same reason a missing job_id is: every action on the row — delete,
                // and shortly the publish link — is keyed by that id, so a row without
                // one is a row the operator can see and nothing can act on.
                const itemId = item.item_id;
                if (typeof itemId !== 'string' || !itemId) {
                  console.warn(`[MetadataReports] ${file.name} item ${index} has no item_id — skipped.`);
                  skipped.push(`${file.name} (item ${index + 1})`);
                  return;
                }

                // Get the display title from the item
                const itemTitle = item._title || `Item ${index + 1}`;

                // The item's own text file, as the run that wrote it recorded. Null means
                // the migration could not match one, and showInFolder falls back to the
                // folder rather than pointing at a file nobody claimed.
                const txtFilePath = typeof item.txt_path === 'string' ? item.txt_path : '';

                reports.push({
                  name: `${jobId}-item-${index}`,
                  path: jsonPath,  // Path to JSON file
                  date: jobDate,
                  size: file.size || 0,
                  promptSet: jobData.prompt_set,
                  displayTitle: itemTitle,
                  txtFolder: txtFolder,  // Store txt folder path
                  jobId: jobId,
                  itemId: itemId,
                  itemIndex: index,
                  txtFilePath: txtFilePath
                });
              });
            }
          } catch (e) {
            console.warn('Could not read metadata file', file.name, e);
            skipped.push(file.name);
          }
        }

        // Files that could not be listed are SAID, not just counted into the console. A
        // reports page silently missing three of forty rows looks exactly like a reports page
        // that has thirty-seven rows, and the operator has no way to tell.
        if (skipped.length > 0) {
          this.notificationService.warning(
            'Some reports could not be listed',
            `${skipped.length} file${skipped.length === 1 ? '' : 's'} skipped: ${skipped.slice(0, 5).join(', ')}` +
              (skipped.length > 5 ? `, and ${skipped.length - 5} more` : '') +
              '. They are unreadable, or missing the job_id / item_id every action is keyed by;' +
              ' see the console for detail.',
          );
        }

        // Sort by date descending
        reports.sort((a, b) => b.date.getTime() - a.date.getTime());
        this.reports.set(reports);
      }
    } catch (error) {
      this.notificationService.error('Load Error', 'Failed to load metadata reports: ' + (error as Error).message);
    } finally {
      this.isLoading.set(false);
    }
  }

  /**
   * Run the one-off report migration and tell the operator what it did.
   *
   * Nothing is thrown from here: a migration that could not run leaves the files exactly
   * as they were, and the listing below will report every item it then cannot identify.
   * Saying both — "the migration failed" and "these rows are unusable" — is the point.
   */
  private async reportMigrationOutcome(): Promise<void> {
    try {
      const outcome = await this.electron.ensureReportsMigrated();

      if (outcome.error) {
        this.notificationService.error(
          'Reports could not be updated',
          `The one-off update of the report files did not run: ${outcome.error}`,
        );
        return;
      }

      if (outcome.ran && outcome.message) {
        // Both halves of the pass are reported, and a failure in EITHER is a failure:
        // reports that could not be migrated and publish selections that could not be
        // moved are the same kind of fact, and burying the second under the first's
        // success is how the operator would learn about it by missing something.
        const failed =
          (outcome.receipt?.failures.length ?? 0) > 0 ||
          (outcome.selectionReceipt?.failures.length ?? 0) > 0;
        const orphaned = (outcome.selectionReceipt?.filesOrphaned ?? 0) > 0;

        if (failed) {
          this.notificationService.error('Reports updated, with failures', outcome.message);
        } else if (orphaned) {
          // Nothing broke, but chosen A/B titles were set aside rather than carried over,
          // and the operator has to know where they went to get them back.
          this.notificationService.warning('Reports updated, some selections set aside', outcome.message);
        } else {
          this.notificationService.success('Reports updated', outcome.message);
        }
      }
    } catch (e) {
      this.notificationService.error(
        'Reports could not be updated',
        `The one-off update of the report files could not be started: ${(e as Error).message}`,
      );
    }
  }

  /**
   * The pre-`.contentstudio/metadata` layout, for installs that predate it.
   *
   * Returns whether it FOUND anything, which the caller needs: this used to be a silent
   * catch-all for any failure of the current path, so "no reports here either" and "we could
   * not look" both ended as an empty list with nothing said.
   */
  private async loadReportsLegacy(baseDir: string): Promise<boolean> {
    // Legacy structure: try the old metadata folder under the output directory
    const possiblePaths = [
      `${baseDir}/metadata`
    ];

    let metadataDir = '';
    let result: any = null;

    for (const path of possiblePaths) {
      try {
        const testResult = await this.electron.readDirectory(path);
        if (testResult.success) {
          metadataDir = path;
          result = testResult;
          console.log('Found legacy metadata directory:', path);
          break;
        }
      } catch (e) {
        // Continue to next path
      }
    }

    if (!metadataDir || !result) {
      console.warn('No metadata directory found in any location');
      this.reportsDirectory.set(possiblePaths[0]);
      return false;
    }

    this.reportsDirectory.set(metadataDir);

    if (result.success && result.directories) {
      const reports: MetadataReport[] = [];

      for (const dir of result.directories) {
        let displayTitle = dir.name;
        let promptSet: string | undefined;

        try {
          const dirContents = await this.electron.readDirectory(dir.path);
          if (dirContents.success && dirContents.files) {
            const jsonFile = dirContents.files.find((f: any) => f.name.endsWith('.json'));
            if (jsonFile) {
              const jsonPath = `${dir.path}/${jsonFile.name}`;
              const content = await this.electron.readFile(jsonPath);
              if (content) {
                const parsed = JSON.parse(content);
                if (parsed._title) {
                  displayTitle = parsed._title;
                }
                if (parsed._prompt_set) {
                  promptSet = parsed._prompt_set;
                }
              }
            }
          }
        } catch (e) {
          console.warn('Could not read metadata for', dir.name);
        }

        reports.push({
          name: dir.name,
          path: dir.path,
          date: new Date(dir.mtime),
          size: dir.size || 0,
          promptSet,
          displayTitle
        });
      }

      reports.sort((a, b) => b.date.getTime() - a.date.getTime());
      this.reports.set(reports);
      return reports.length > 0;
    }
    // The directory was readable but held no files worth listing. Found the LOCATION, found
    // no reports — reported as "nothing here" rather than as a failure to look.
    return true;
  }

  async selectReport(report: MetadataReport) {
    try {
      this.isLoading.set(true);
      this.selectedReport.set(report);

      // Read the JSON file (report.path is now the path to the JSON file)
      let content = await this.electron.readFile(report.path);

      if (!content) {
        throw new Error('Empty file content');
      }

      const jobData = JSON.parse(content);
      console.log('[MetadataReports] Loaded job data:', jobData);
      console.log('[MetadataReports] Report itemIndex:', report.itemIndex);

      // Strict checking - no fallbacks
      if (report.itemIndex === undefined) {
        throw new Error('Report missing itemIndex - cannot determine which item to load');
      }

      if (!jobData.items || !Array.isArray(jobData.items)) {
        throw new Error('Job data missing items array - invalid structure');
      }

      if (jobData.items.length <= report.itemIndex) {
        throw new Error(`Item index ${report.itemIndex} out of bounds (only ${jobData.items.length} items in job)`);
      }

      const selectedItem = this.normalizeMetadataKeys(jobData.items[report.itemIndex]);
      console.log('[MetadataReports] Selected item from array:', selectedItem);
      console.log('[MetadataReports] Titles array:', selectedItem.titles);
      console.log('[MetadataReports] Thumbnail text array:', selectedItem.thumbnail_text);

      this.metadata.set(selectedItem);
      console.log('[MetadataReports] Final metadata signal value:', this.metadata());

      // Any half-finished edit belongs to the PREVIOUS item — drop it before the new
      // selection loads, or a save would write it onto the wrong report.
      this.cancelEditTitle();
      this.cancelEditDescription();
      this.cancelEditTags();
      this.clearScheduleDrafts();

      // Load any previously chosen A/B titles for this item, BY ITS ID. The row's
      // itemIndex is only ever a position into the array read above; it has never been
      // an identity, and passing it here is what re-pointed selections at the wrong item
      // when a sibling was deleted.
      //
      // Deliberately not awaited with the metadata read — a failure here must not blank
      // the report.
      //
      // The prompt set travels with it: it is the only input to channel seeding, and an
      // item opened without one gets a panel that says so rather than an empty picker.
      void this.publish.load(report.itemId, report.promptSet);
    } catch (error) {
      console.error('[MetadataReports] Error loading report:', error);
      this.notificationService.error('Read Error', 'Failed to read report: ' + (error as Error).message);
      this.metadata.set(null);
    } finally {
      this.isLoading.set(false);
    }
  }

  getDisplayTitle(report: MetadataReport): string {
    // If we have loaded metadata with a title, use it
    if (this.selectedReport()?.path === report.path && this.metadata()?._title) {
      return this.metadata()!._title!;
    }
    // Otherwise use the folder name
    return report.name;
  }

  async showInFolder(report: MetadataReport) {
    try {
      // Show the specific txt file if available, otherwise the txt folder, otherwise the JSON file location
      const pathToShow = report.txtFilePath || report.txtFolder || report.path;
      await this.electron.showInFolder(pathToShow);
    } catch (error) {
      this.notificationService.error('Show Error', 'Failed to show in folder: ' + (error as Error).message);
    }
  }

  /**
   * Ask the main process to delete one item, then re-read the directory.
   *
   * What used to be here: an unbounded `delete-directory` aimed at the txt file, a
   * renderer-side read-modify-write of the job JSON that bypassed the output handler's
   * write queue, and an in-memory renumber of the sibling rows that ran whether or not
   * the write had succeeded — so a failed write left the UI showing the wrong item's
   * metadata under the right title (P3). All three are gone. The renderer names an item
   * and re-reads what is actually on disk; it no longer keeps its own opinion about it.
   */
  async deleteReport(report: MetadataReport, event: Event) {
    event.stopPropagation();

    if (!report.jobId || !report.itemId) {
      // Not reachable from a listed row (rows without both ids are never built), which is
      // exactly why it is worth saying rather than silently returning.
      this.notificationService.error(
        'Cannot delete this report',
        `${report.name} has no job id or item id, so there is nothing the app can safely delete.`,
      );
      return;
    }

    try {
      const receipt = await this.electron.deleteReportItem(report.jobId, report.itemId);

      // The list is rebuilt from disk rather than patched: the delete may also have
      // removed the whole job file, and the positions of every sibling item have moved.
      await this.loadReports();

      if (this.selectedReport()?.name === report.name) {
        this.selectedReport.set(null);
        this.metadata.set(null);
      }

      // The one outcome the operator cannot see from the list: a text file left behind
      // because the item never recorded where it was. Said, not logged.
      if (!receipt.txtDeleted) {
        this.notificationService.warning(
          'Deleted, text file left behind',
          `The report entry is gone, but its text file was not removed (${receipt.txtReason}).` +
            (report.txtFolder ? ` Look in ${report.txtFolder}.` : ''),
        );
      } else {
        this.notificationService.success('Deleted', 'Report and its text file deleted');
      }
    } catch (error) {
      // A rejected delete did nothing at all — the main process is a single transaction
      // that throws rather than half-finishing — so the row stays exactly where it is.
      this.notificationService.error('Delete Error', 'Failed to delete report: ' + (error as Error).message);
    }
  }

  formatDate(date: Date): string {
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  copyToClipboard(text: string, itemKey?: string) {
    navigator.clipboard.writeText(text).then(() => {
      // Set copied state for visual feedback
      if (itemKey) {
        this.setCopiedItem(itemKey);
      }
      this.notificationService.success('Copied', 'Text copied to clipboard', false);
    }).catch(err => {
      this.notificationService.error('Copy Failed', 'Failed to copy to clipboard: ' + err.message);
    });
  }

  // Set copied item and auto-clear after delay
  private setCopiedItem(key: string) {
    // Clear any existing timeout
    if (this.copiedTimeout) {
      clearTimeout(this.copiedTimeout);
    }

    this.copiedItem.set(key);

    // Clear after 1.5 seconds
    this.copiedTimeout = setTimeout(() => {
      this.copiedItem.set(null);
    }, 1500);
  }

  // Check if a specific item was just copied
  isCopied(key: string): boolean {
    return this.copiedItem() === key;
  }

  copyChaptersToClipboard() {
    const meta = this.metadata();
    if (!meta || !meta.chapters) return;

    const chaptersText = meta.chapters
      .map((chapter: any) => `${this.getChapterTimestamp(chapter)} - ${this.getChapterTitle(chapter)}`)
      .join('\n');

    navigator.clipboard.writeText(chaptersText).then(() => {
      this.setCopiedItem('chapters-all');
      this.notificationService.success('Copied', 'All chapters copied to clipboard', false);
    }).catch(err => {
      this.notificationService.error('Copy Failed', 'Failed to copy chapters: ' + err.message);
    });
  }

  getTagsArray(): string[] {
    const meta = this.metadata();
    if (!meta || !meta.tags) return [];

    // Handle both string (comma-separated) and array formats
    if (Array.isArray(meta.tags)) {
      return meta.tags;
    }

    // If it's a string, split by comma
    if (typeof meta.tags === 'string') {
      return meta.tags.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0);
    }

    return [];
  }

  getTagsString(): string {
    const tags = this.getTagsArray();
    return tags.join(', ');
  }

  getTitleText(title: any): string {
    // Handle both string format and object format {text: "...", style: "..."}
    if (typeof title === 'string') {
      return title;
    }
    if (title && typeof title === 'object' && title.text) {
      return title.text;
    }
    return String(title);
  }

  getDescriptionText(description: any): string {
    // Handle both string format and object format
    if (typeof description === 'string') {
      return description;
    }
    if (description && typeof description === 'object') {
      // Try common object formats
      if (description.text) return description.text;
      if (description.content) return description.content;
      if (description.description) return description.description;
    }
    return String(description || '');
  }

  getThumbnailText(thumbnail: any): string {
    // Handle both string format and object format
    if (typeof thumbnail === 'string') {
      return thumbnail;
    }
    if (thumbnail && typeof thumbnail === 'object' && thumbnail.text) {
      return thumbnail.text;
    }
    return String(thumbnail);
  }

  getChapterTimestamp(chapter: any): string {
    // Handle various formats AI models might return
    if (typeof chapter === 'string') {
      // String format like "0:00 - Introduction"
      const match = chapter.match(/^(\d+:\d+)/);
      return match ? match[1] : '0:00';
    }
    if (chapter && typeof chapter === 'object') {
      // Try common property names
      if (chapter.timestamp) return String(chapter.timestamp);
      if (chapter.time) return String(chapter.time);
    }
    return '0:00';
  }

  getChapterTitle(chapter: any): string {
    // Handle various formats AI models might return
    if (typeof chapter === 'string') {
      // String format like "0:00 - Introduction"
      const match = chapter.match(/^\d+:\d+\s*-\s*(.+)$/);
      return match ? match[1] : chapter;
    }
    if (chapter && typeof chapter === 'object') {
      // Try common property names
      if (chapter.title) return String(chapter.title);
      if (chapter.text) return String(chapter.text);
      if (chapter.name) return String(chapter.name);
    }
    return String(chapter || 'Untitled');
  }

  /**
   * The recorded reason this item has no chapters — null when it has some, or when the
   * run recorded nothing (chapters were never requested, so there is nothing to explain).
   */
  chaptersMissing(): { outcome: 'failed' | 'skipped'; reason: string } | null {
    const meta = this.metadata();
    if (!meta || (meta.chapters && meta.chapters.length > 0)) return null;
    return meta.chaptersSkipped ?? null;
  }

  /**
   * Normalize variant key names from different AI models to the expected ParsedMetadata fields.
   * Also flattens objects to strings (some models return {text: "...", style: "..."} instead of plain strings).
   */
  private normalizeMetadataKeys(raw: any): ParsedMetadata {
    // Extract string from any value (handles objects AI models might return)
    const toStr = (val: any): string => {
      if (typeof val === 'string') return val;
      if (val && typeof val === 'object') {
        return val.text || val.title || val.value || val.content || val.label || JSON.stringify(val);
      }
      return String(val ?? '');
    };

    // Normalize an array of items to string[]
    const toStrArray = (arr: any): string[] => {
      if (!arr) return [];
      if (!Array.isArray(arr)) return [toStr(arr)];
      return arr.map(toStr);
    };

    // Tags: strip # prefix, handle string or array
    let tags: string | string[] = raw.tags || '';
    if (Array.isArray(tags)) {
      tags = tags.map((t: any) => toStr(t).replace(/^#\s*/, ''));
    } else if (typeof tags === 'string') {
      tags = tags.split(',').map((t: string) => t.trim().replace(/^#\s*/, '')).join(',');
    }

    return {
      titles: toStrArray(raw.titles || raw.titleOptions || raw.title_options || raw.titleSuggestions),
      thumbnail_text: toStrArray(raw.thumbnail_text || raw.thumbnailText || raw.thumbnailTextOptions
        || raw.thumbnail_text_options || raw.thumbnailOptions),
      description: raw.description || '',
      tags,
      hashtags: raw.hashtags || '',
      pinned_comment: toStrArray(raw.pinned_comment || raw.pinnedComment || raw.pinned_comments) || undefined,
      clip_suggestions: toStrArray(raw.clip_suggestions || raw.clipSuggestions || raw.clips) || undefined,
      chapters: raw.chapters,
      chaptersSkipped: raw.chaptersSkipped,
      _title: raw._title,
      _prompt_set: raw._prompt_set,
    };
  }

  toggleSelection(report: MetadataReport, event: Event) {
    event.stopPropagation();
    report.selected = !report.selected;
    this.reports.set([...this.reports()]);
  }

  toggleSelectAll() {
    const allSelected = this.reports().every(r => r.selected);
    this.reports().forEach(r => r.selected = !allSelected);
    this.reports.set([...this.reports()]);
  }

  getSelectedReports(): MetadataReport[] {
    return this.reports().filter(r => r.selected);
  }

  hasSelectedReports(): boolean {
    return this.reports().some(r => r.selected);
  }

  allReportsSelected(): boolean {
    return this.reports().length > 0 && this.reports().every(r => r.selected);
  }

  async exportSelectedAsTxt() {
    const selected = this.getSelectedReports();

    if (selected.length === 0) {
      this.notificationService.warning('No Selection', 'Please select at least one report to export');
      return;
    }

    try {
      // Ask user to select export directory
      const result = await this.electron.selectOutputDirectory();

      if (!result.success || !result.directory) {
        return; // User cancelled
      }

      const exportDir = result.directory;
      let successCount = 0;
      let errorCount = 0;

      for (const report of selected) {
        try {
          // Read the metadata
          const content = await this.electron.readFile(report.path);
          if (!content) {
            console.error('Empty content for report:', report.name);
            errorCount++;
            continue;
          }

          const jobData = JSON.parse(content);

          // Strict checking - no fallbacks
          if (report.itemIndex === undefined) {
            console.error('Report missing itemIndex:', report.name);
            errorCount++;
            continue;
          }

          if (!jobData.items || !Array.isArray(jobData.items)) {
            console.error('Job data missing items array:', report.name);
            errorCount++;
            continue;
          }

          if (jobData.items.length <= report.itemIndex) {
            console.error('Item index out of bounds:', report.name);
            errorCount++;
            continue;
          }

          const metadata: ParsedMetadata = this.normalizeMetadataKeys(jobData.items[report.itemIndex]);

          // Format the metadata as text
          const txtContent = this.formatMetadataAsTxt(metadata, report);

          // Create safe filename
          const safeName = (report.displayTitle || report.name)
            .replace(/[^a-zA-Z0-9-_]/g, '_')
            .substring(0, 100);
          const fileName = `${safeName}_metadata.txt`;

          // Export the file
          await this.electron.writeTextFile(`${exportDir}/${fileName}`, txtContent);
          successCount++;
        } catch (error) {
          console.error('Error exporting report:', report.name, error);
          errorCount++;
        }
      }

      if (successCount > 0) {
        this.notificationService.success(
          'Export Complete',
          `Exported ${successCount} file(s) to ${exportDir}`
        );
      }

      if (errorCount > 0) {
        this.notificationService.warning(
          'Export Partial',
          `${errorCount} file(s) failed to export`
        );
      }

      // Deselect all after export
      this.reports().forEach(r => r.selected = false);
      this.reports.set([...this.reports()]);

    } catch (error) {
      this.notificationService.error('Export Failed', 'Failed to export files: ' + (error as Error).message);
    }
  }

  private formatMetadataAsTxt(metadata: ParsedMetadata, report: MetadataReport): string {
    let output = '';

    // Header
    output += '='.repeat(80) + '\n';
    output += `METADATA EXPORT\n`;
    output += `Title: ${metadata._title || report.displayTitle || report.name}\n`;
    output += `Prompt Set: ${metadata._prompt_set || report.promptSet || 'N/A'}\n`;
    output += `Generated: ${report.date.toLocaleString()}\n`;
    output += '='.repeat(80) + '\n\n';

    // Titles
    if (metadata.titles && metadata.titles.length > 0) {
      output += '--- TITLES ---\n\n';
      metadata.titles.forEach((title, i) => {
        output += `${i + 1}. ${title}\n`;
      });
      output += '\n';
    }

    // Thumbnail Text
    if (metadata.thumbnail_text && metadata.thumbnail_text.length > 0) {
      output += '--- THUMBNAIL TEXT ---\n\n';
      metadata.thumbnail_text.forEach((text, i) => {
        output += `${i + 1}. ${text}\n`;
      });
      output += '\n';
    }

    // Pinned Comment
    if (metadata.pinned_comment && metadata.pinned_comment.length > 0) {
      output += '--- PINNED COMMENT ---\n\n';
      metadata.pinned_comment.forEach((comment, i) => {
        output += `${i + 1}. ${comment}\n`;
      });
      output += '\n';
    }

    // Clip Suggestions
    if (metadata.clip_suggestions && metadata.clip_suggestions.length > 0) {
      output += '--- CLIP SUGGESTIONS ---\n\n';
      metadata.clip_suggestions.forEach((clip, i) => {
        output += `${i + 1}. ${clip}\n`;
      });
      output += '\n';
    }

    // Description
    if (metadata.description) {
      output += '--- DESCRIPTION ---\n\n';
      const descText = this.getDescriptionText(metadata.description);
      output += descText + '\n\n';

      if (metadata.hashtags && !descText.includes(metadata.hashtags)) {
        output += metadata.hashtags + '\n\n';
      }
    }

    // Tags - handle both string and array formats
    if (metadata.tags) {
      output += '--- TAGS ---\n\n';
      if (Array.isArray(metadata.tags)) {
        output += metadata.tags.join(', ') + '\n\n';
      } else {
        output += metadata.tags + '\n\n';
      }
    }

    // Hashtags (if not already included)
    const descText = metadata.description ? this.getDescriptionText(metadata.description) : '';
    if (metadata.hashtags && !descText.includes(metadata.hashtags)) {
      output += '--- HASHTAGS ---\n\n';
      output += metadata.hashtags + '\n\n';
    }

    output += '='.repeat(80) + '\n';
    output += 'End of metadata export\n';

    return output;
  }
}
