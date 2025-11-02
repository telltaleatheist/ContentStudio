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
import { ElectronService } from '../../services/electron';
import { TextSubjectDialog } from '../text-subject-dialog/text-subject-dialog';
import { InputsStateService, InputItem } from '../../services/inputs-state';
import { JobQueueService, QueuedJob } from '../../services/job-queue';

interface PromptSetOption {
  id: string;
  name: string;
  platform: string;
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
    CommonModule
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
    public jobQueue: JobQueueService
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
        console.error('Error loading settings:', error);
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
      console.error('Error loading prompt sets:', error);
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
        const fileName = filePath.split('/').pop() || filePath;

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
            promptSet: this.inputsState.masterPromptSet()
          });
        }
      }
    }
  }

  removeInput(index: number) {
    this.inputsState.removeItem(index);
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
    if (this.queueStarted()) return;

    // Validate output directory before starting
    try {
      const settings = await this.electron.getSettings();
      const outputDir = settings.outputDirectory;

      if (!outputDir) {
        alert('No output directory configured. Please set one in Settings before processing.');
        return;
      }

      // Check if directory exists
      const dirCheck = await this.electron.checkDirectory(outputDir);
      if (!dirCheck.exists) {
        alert(`Output directory does not exist: ${outputDir}\n\nPlease create the directory or choose a different one in Settings.`);
        return;
      }

      // Check if directory is writable
      if (!dirCheck.writable) {
        alert(`Output directory is not writable: ${outputDir}\n\nPlease check permissions or choose a different directory in Settings.`);
        return;
      }
    } catch (error) {
      console.error('Error validating output directory:', error);
      alert('Failed to validate output directory. Please check your settings.');
      return;
    }

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

      // Listen for progress updates from Python
      const unsubscribe = this.electron.onProgress((progress: any) => {
        const job = this.jobQueue.getJob(nextJob.id);
        if (!job) return;

        // Handle preparing phase (when starting a new video) - this sets the current item
        if (progress.phase === 'preparing' && progress.filename) {
          const itemIndex = findItemIndexByFilename(progress.filename);
          if (itemIndex !== -1) {
            // Mark previous item as completed if we moved to a new item
            if (currentItemIndex < totalItems && currentItemIndex !== itemIndex && currentItemIndex > 0) {
              this.jobQueue.updateItemProgress(nextJob.id, currentItemIndex - 1, 100, 'completed');
            }

            currentItemIndex = itemIndex;
            this.jobQueue.updateItemProgress(nextJob.id, currentItemIndex, 0, 'processing');
          }
          this.jobQueue.updateJob(nextJob.id, { currentlyProcessing: `Processing: ${progress.filename}` });
        }

        // Update current item progress based on transcription phase
        if (progress.phase === 'transcription' && progress.progress !== undefined) {
          // Find which item is being transcribed if filename is provided
          if (progress.filename) {
            const itemIndex = findItemIndexByFilename(progress.filename);
            if (itemIndex !== -1 && itemIndex !== currentItemIndex) {
              currentItemIndex = itemIndex;
            }
          }

          // Update current item progress bar (0-50% for transcription)
          if (currentItemIndex < totalItems) {
            const transcriptionProgress = Math.floor(progress.progress / 2); // Map 0-100 to 0-50
            this.jobQueue.updateItemProgress(nextJob.id, currentItemIndex, transcriptionProgress, 'processing');
          }

          // Update job-level message with "Transcribing..."
          const message = progress.message || `Transcribing: ${progress.filename || ''}`;
          this.jobQueue.updateJob(nextJob.id, { currentlyProcessing: message });

          // Calculate overall progress (transcription is first 50%)
          const completedItems = job.itemProgress.filter(p => p.status === 'completed').length;
          const currentProgress = (progress.progress || 0) / 2; // 0-50%
          const overallProgress = ((completedItems + (currentProgress / 100)) / totalItems) * 100;
          this.jobQueue.updateJob(nextJob.id, { progress: Math.min(overallProgress, 95) });
        }

        // Handle metadata generation phase (AI summarization and generation)
        if (progress.phase === 'generating' && progress.progress !== undefined) {
          if (currentItemIndex < totalItems) {
            // Map AI progress from 0-100 to 50-100 (second half of progress bar)
            const aiProgress = 50 + Math.floor(progress.progress / 2);
            this.jobQueue.updateItemProgress(nextJob.id, currentItemIndex, aiProgress, 'processing');
          }

          // Update message to show what's happening in AI phase
          const message = progress.message || 'Generating metadata...';
          this.jobQueue.updateJob(nextJob.id, { currentlyProcessing: message });

          // If generation complete (100%), mark item as completed and move to next
          if (progress.progress === 100) {
            if (currentItemIndex < totalItems) {
              this.jobQueue.updateItemProgress(nextJob.id, currentItemIndex, 100, 'completed');
              currentItemIndex++;
            }
          }

          // Calculate overall progress (generation is second 50%)
          const completedItems = currentItemIndex;
          const currentProgress = 50 + ((progress.progress || 0) / 2); // 50-100%
          const overallProgress = ((completedItems + (currentProgress / 100)) / totalItems) * 100;
          this.jobQueue.updateJob(nextJob.id, { progress: Math.min(overallProgress, 99) });
        }
      });

      // Extract inputs
      const inputs = nextJob.inputs.map(item => item.path);

      const result = await this.electron.generateMetadata({
        inputs,
        promptSet: nextJob.promptSet,
        mode: nextJob.mode
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

        // Show error message
        this.showCompletionMessageFor(`Job "${nextJob.name}" failed: ${result.error}`);
      }
    } catch (error) {
      console.error('Error processing job:', error);
      if (elapsedInterval) clearInterval(elapsedInterval);

      this.jobQueue.updateJob(nextJob.id, {
        status: 'failed',
        progress: 0,
        currentlyProcessing: 'Error',
        completedAt: new Date(),
        error: String(error)
      });

      this.showCompletionMessageFor(`Job "${nextJob.name}" failed: ${error}`);
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

  removeJob(jobId: string) {
    this.jobQueue.removeJob(jobId);
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
    return job.itemProgress[itemIndex]?.status === 'processing';
  }

  getItemProgress(job: QueuedJob, itemIndex: number): number {
    const item = job.itemProgress[itemIndex];
    if (!item) return 0;

    if (item.status === 'completed') return 100;
    if (item.status === 'failed') return 100;
    if (item.status === 'processing') return item.progress;

    return 0;
  }
}
