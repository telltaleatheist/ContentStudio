import { Component, ElementRef, OnInit, ViewChild, inject, signal } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatListModule } from '@angular/material/list';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatChipsModule } from '@angular/material/chips';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { ElectronService } from '../../services/electron';
import { NotificationService } from '../../services/notification';
import { PublishState } from '../../features/publish/publish-state';
import { MAX_AB_VARIANTS } from '../../features/publish/publish.types';

interface MetadataReport {
  name: string;
  path: string;
  date: Date;
  size: number;
  promptSet?: string; // The prompt set used for generation
  displayTitle?: string; // The actual title from the metadata
  txtFolder?: string; // Path to the folder containing txt files
  jobId?: string; // The job ID this item belongs to
  itemIndex?: number; // Index of this item within the job (for multiple items)
  txtFilePath?: string; // Path to the specific TXT file for this item
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
    MatCheckboxModule
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
    private notificationService: NotificationService
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

              // Create a report for EACH item in the job
              if (jobData.items && Array.isArray(jobData.items)) {
                jobData.items.forEach((item: any, index: number) => {
                  // Get the display title from the item
                  const itemTitle = item._title || `Item ${index + 1}`;

                  // Get the corresponding txt file path if available
                  let txtFilePath = '';
                  if (jobData.txt_files && jobData.txt_files[index]) {
                    txtFilePath = jobData.txt_files[index];
                  }

                  reports.push({
                    name: `${jobId}-item-${index}`,
                    path: jsonPath,  // Path to JSON file
                    date: jobDate,
                    size: file.size || 0,
                    promptSet: jobData.prompt_set,
                    displayTitle: itemTitle,
                    txtFolder: txtFolder,  // Store txt folder path
                    jobId: jobId,
                    itemIndex: index,
                    txtFilePath: txtFilePath
                  });
                });
              } else {
                // Fallback for jobs without items array (shouldn't happen with new structure)
                reports.push({
                  name: jobId,
                  path: jsonPath,
                  date: jobDate,
                  size: file.size || 0,
                  promptSet: jobData.prompt_set,
                  displayTitle: jobData.job_name,
                  txtFolder: txtFolder,
                  jobId: jobId
                });
              }
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
              '. They are unreadable or missing a job_id; see the console for detail.',
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

      // Load any previously chosen A/B titles for this item. Deliberately not awaited
      // with the metadata read above — a failure here must not blank the report.
      void this.publish.load(report.jobId, report.itemIndex);
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

  async deleteReport(report: MetadataReport, event: Event) {
    event.stopPropagation();

    // Every partial failure below used to be a console.warn on the way to an unconditional
    // "Report deleted successfully". The operator was told the delete worked while the txt
    // file was still on disk, or while the JSON still held the item. Collected instead, and
    // reported at the end alongside whatever DID happen.
    const problems: string[] = [];

    try {
      // Delete the individual TXT file if it exists
      if (report.txtFilePath) {
        try {
          await this.electron.deleteDirectory(report.txtFilePath);
          console.log('[MetadataReports] Deleted TXT file:', report.txtFilePath);
        } catch (e) {
          console.warn('Could not delete txt file:', report.txtFilePath, e);
          problems.push(`the text file at ${report.txtFilePath} could not be removed (${(e as Error).message})`);
        }
      }

      // Check how many items from this job exist
      const jobReports = this.reports().filter(r => r.jobId === report.jobId);

      if (jobReports.length === 1) {
        // This is the last item - delete the entire JSON file
        await this.electron.deleteDirectory(report.path);
        console.log('[MetadataReports] Deleted JSON file (last item):', report.path);
      } else {
        // Multiple items exist - remove this item from the JSON
        try {
          const content = await this.electron.readFile(report.path);
          if (content) {
            const jobData = JSON.parse(content);

            // Remove the item at this index
            if (jobData.items && report.itemIndex !== undefined) {
              jobData.items.splice(report.itemIndex, 1);

              // Update txt_files array if it exists
              if (jobData.txt_files && jobData.txt_files[report.itemIndex]) {
                jobData.txt_files.splice(report.itemIndex, 1);
              }

              // Save the updated JSON
              await this.electron.writeTextFile(report.path, JSON.stringify(jobData, null, 2));
              console.log('[MetadataReports] Updated JSON file (removed item):', report.path);
            }
          }
        } catch (e) {
          console.warn('Could not update JSON file:', e);
          // The heaviest of the three: the row disappears from the list below regardless, so
          // without this the item is gone from view and still in the file, and it returns on
          // the next load with no explanation.
          problems.push(`the report file still lists this item (${(e as Error).message})`);
        }
      }

      // Remove from UI list (use unique name, not shared path) and renumber the
      // sibling rows for this job so their itemIndex stays aligned with the now
      // spliced jobData.items array (otherwise clicking a later sibling throws
      // "Item index out of bounds"). The txt file each sibling points at is
      // unchanged by the splice, so txtFilePath stays as-is.
      const deletedIndex = report.itemIndex;
      this.reports.update(reports =>
        reports
          .filter(r => r.name !== report.name)
          .map(r => {
            if (
              r.jobId === report.jobId &&
              deletedIndex !== undefined &&
              r.itemIndex !== undefined &&
              r.itemIndex > deletedIndex
            ) {
              const newIndex = r.itemIndex - 1;
              return { ...r, itemIndex: newIndex, name: `${r.jobId}-item-${newIndex}` };
            }
            return r;
          })
      );

      // Clear selection if deleted report was selected
      if (this.selectedReport()?.name === report.name) {
        this.selectedReport.set(null);
        this.metadata.set(null);
      }

      if (problems.length > 0) {
        this.notificationService.error(
          'Deleted, but not completely',
          `The report was removed from the list, but ${problems.join(', and ')}.`,
        );
      } else {
        this.notificationService.success('Deleted', 'Report deleted successfully');
      }
    } catch (error) {
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
