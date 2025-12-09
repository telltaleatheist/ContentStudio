import { Component, signal, OnInit, effect, OnDestroy, ViewChild, ElementRef } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatListModule } from '@angular/material/list';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
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
      }
    } catch (error) {
      this.notificationService.error('Prompt Sets Error', 'Failed to load prompt sets: ' + (error as Error).message);
    }
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
          this.inputsState.addItem({
            type: 'subject',
            path: subject.trim(),
            displayName: subject.trim(),
            icon: 'text_fields',
            selected: true,
            promptSet: this.inputsState.masterPromptSet()
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
          } else if (ext === 'txt') {
            icon = 'text_fields';
            type = 'transcript';
          }

          this.inputsState.addItem({
            type,
            path: filePath,
            displayName: fileName,
            icon,
            selected: true,
            promptSet: this.inputsState.masterPromptSet(),
            generateChapters: type === 'video' ? true : undefined
          });
        }
      }
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
        } else if (ext === 'txt') {
          icon = 'text_fields';
          type = 'transcript';
        }

        this.inputsState.addItem({
          type,
          path: filePath,
          displayName: fileName,
          icon,
          selected: true,
          promptSet: this.inputsState.masterPromptSet(),
          generateChapters: type === 'video' ? true : undefined
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
      // Individual mode - group items by prompt set
      const groups: { [promptSet: string]: InputItem[] } = {};

      this.selectedItems.forEach(item => {
        if (!groups[item.promptSet]) {
          groups[item.promptSet] = [];
        }
        groups[item.promptSet].push(item);
      });

      // Create a job for each group
      Object.entries(groups).forEach(([promptSet, items]) => {
        let jobName: string;
        if (items.length === 1) {
          jobName = `${items[0].displayName}`;
        } else {
          const firstName = items[0].displayName;
          const truncatedName = firstName.length > 30 ? firstName.substring(0, 30) + '...' : firstName;
          jobName = `${truncatedName} + ${items.length - 1} more`;
        }

        this.jobQueue.addJob(jobName, items, promptSet, 'individual');
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

    // Validate output directory before starting
    try {
      console.log('[StartQueue] Getting settings...');
      const settings = await this.electron.getSettings();
      const outputDir = settings.outputDirectory;
      console.log('[StartQueue] Output directory:', outputDir);

      if (!outputDir) {
        console.log('[StartQueue] No output directory configured');
        this.notificationService.error('Configuration Error', 'No output directory configured. Please set one in Settings before processing.');
        return;
      }

      // Check if directory exists
      console.log('[StartQueue] Checking directory...');
      const dirCheck = await this.electron.checkDirectory(outputDir);
      console.log('[StartQueue] Directory check result:', dirCheck);

      if (!dirCheck.exists) {
        console.log('[StartQueue] Directory does not exist');
        this.notificationService.error('Directory Error', `Output directory does not exist: ${outputDir}\n\nPlease create the directory or choose a different one in Settings.`);
        return;
      }

      // Check if directory is writable
      if (!dirCheck.writable) {
        console.log('[StartQueue] Directory not writable');
        this.notificationService.error('Permission Error', `Output directory is not writable: ${outputDir}\n\nPlease check permissions or choose a different directory in Settings.`);
        return;
      }
    } catch (error) {
      console.error('[StartQueue] Error validating directory:', error);
      this.notificationService.error('Directory Error', 'Failed to validate output directory. Please check your settings.');
      return;
    }

    console.log('[StartQueue] Starting queue processor...');
    this.queueStarted.set(true);
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

    const nextJob = this.jobQueue.getNextPendingJob();
    if (!nextJob) {
      // No more jobs - stop processing
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

    // Mark job as processing
    this.jobQueue.updateJob(nextJob.id, {
      status: 'processing',
      progress: 0,
      currentlyProcessing: 'Starting...'
    });

    const startTime = Date.now();
    let elapsedInterval: any;

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
      const unsubscribe = this.electron.onProgress((progress: any) => {
        const job = this.jobQueue.getJob(nextJob.id);
        if (!job) return;

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
      const inputs = nextJob.inputs.map(item => ({
        path: item.path,
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
          if (item.type === 'video' && item.generateChapters !== false) {
            chapterFlags[item.path] = true;
          }
        });
      }

      console.log('Chapter flags being sent:', chapterFlags, '(YouTube:', isYouTube, ', Individual:', isIndividual, ')');

      const result = await this.electron.generateMetadata({
        inputs,
        promptSet: nextJob.promptSet,
        mode: nextJob.mode,
        jobId: nextJob.id,
        jobName: nextJob.name,
        chapterFlags
      });

      unsubscribe();
      clearInterval(elapsedInterval);

      const processingTime = ((Date.now() - startTime) / 1000);

      if (result.success) {
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
        // Mark current item as failed if there is one
        const job = this.jobQueue.getJob(nextJob.id);
        if (job && currentItemIndex < job.inputs.length) {
          this.jobQueue.updateItemProgress(nextJob.id, currentItemIndex, 100, 'failed');
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
      if (elapsedInterval) clearInterval(elapsedInterval);

      this.jobQueue.updateJob(nextJob.id, {
        status: 'failed',
        progress: 0,
        currentlyProcessing: 'Error',
        completedAt: new Date(),
        error: String(error)
      });
    } finally {
      // After job completes (success or failure), process next job in queue
      this.processNextJob();
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
    this.jobQueue.removeJob(jobId);
  }

  removeItemFromJob(jobId: string, itemIndex: number) {
    const job = this.jobQueue.getJob(jobId);
    if (!job) {
      console.warn('[Inputs] Cannot remove item: job not found:', jobId);
      return;
    }

    // Remove the item from the job's inputs array
    job.inputs.splice(itemIndex, 1);

    // If no items left, remove the entire job
    if (job.inputs.length === 0) {
      console.log('[Inputs] Last item removed, removing entire job');
      this.removeJob(jobId);
    } else {
      console.log(`[Inputs] Removed item ${itemIndex} from job ${jobId}. ${job.inputs.length} items remaining.`);
      // Update the job with the modified inputs array
      this.jobQueue.updateJob(jobId, { inputs: job.inputs });
    }
  }

  getJobStatusIcon(status: string): string {
    switch (status) {
      case 'pending': return 'schedule';
      case 'processing': return 'hourglass_empty';
      case 'completed': return 'check_circle';
      case 'failed': return 'error';
      default: return 'help';
    }
  }

  getJobStatusColor(status: string): string {
    switch (status) {
      case 'pending': return 'accent';
      case 'processing': return 'primary';
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
    // Chapters available for any video or transcript file
    return item.type === 'video' || item.type === 'transcript';
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

    const completedItems = job.itemProgress.filter(item =>
      item.status === 'completed' || item.status === 'failed'
    ).length;

    return (completedItems / job.inputs.length) * 100;
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
