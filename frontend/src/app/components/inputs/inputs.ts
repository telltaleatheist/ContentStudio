import { Component, signal, OnInit, effect, OnDestroy } from '@angular/core';
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
  private elapsedInterval: any;
  private processingInterval: any;

  completionMessage = signal<string>('');
  showCompletionMessage = signal(false);
  queueStarted = signal(false);
  expandedJobIds = signal<Set<string>>(new Set());

  constructor(
    private dialog: MatDialog,
    private electron: ElectronService,
    public inputsState: InputsStateService,
    public jobQueue: JobQueueService
  ) {}

  ngOnDestroy() {
    this.stopElapsedTimer();
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
    }
  }

  async ngOnInit() {
    // Load persisted settings only on first initialization
    if (!this.inputsState.hasLoadedSettings()) {
      try {
        const settings = await this.electron.getSettings();
        if (settings.platform) {
          this.inputsState.setPlatform(settings.platform);
        }
        if (settings.mode) {
          this.inputsState.setMode(settings.mode);
        }
        this.inputsState.markSettingsLoaded();
      } catch (error) {
        console.error('Error loading settings:', error);
      }
    }

    // Queue processor will be started manually by user
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

  get allItemsSpreaker(): boolean {
    const items = this.inputsState.inputItems();
    return items.length > 0 && items.every(item => item.platform === 'spreaker');
  }

  get allItemsCompilation(): boolean {
    const items = this.inputsState.inputItems();
    return items.length > 0 && items.every(item => item.mode === 'compilation');
  }

  toggleSelectAll() {
    const allSelected = this.allItemsSelected;
    this.inputsState.inputItems().forEach((_, index) => {
      this.toggleItemSelection(index, !allSelected);
    });
  }

  toggleAllSpreaker() {
    const allSpreaker = this.allItemsSpreaker;
    const items = this.inputsState.inputItems();
    const updatedItems = items.map(item => ({
      ...item,
      platform: (allSpreaker ? 'youtube' : 'spreaker') as 'youtube' | 'spreaker'
    }));
    this.inputsState.inputItems.set(updatedItems);
  }

  toggleAllCompilation() {
    const allCompilation = this.allItemsCompilation;
    const items = this.inputsState.inputItems();
    const updatedItems = items.map(item => ({
      ...item,
      mode: (allCompilation ? 'individual' : 'compilation') as 'individual' | 'compilation'
    }));
    this.inputsState.inputItems.set(updatedItems);
  }

  toggleItemSelection(index: number, value?: boolean) {
    const items = this.inputsState.inputItems();
    const newSelected = value !== undefined ? value : !items[index].selected;
    const updatedItems = [...items];
    updatedItems[index] = { ...updatedItems[index], selected: newSelected };
    this.inputsState.inputItems.set(updatedItems);
  }

  updateItemPlatform(index: number, platform: 'youtube' | 'spreaker') {
    const items = this.inputsState.inputItems();
    const updatedItems = [...items];
    updatedItems[index] = { ...updatedItems[index], platform };
    this.inputsState.inputItems.set(updatedItems);
  }

  updateItemMode(index: number, mode: 'individual' | 'compilation') {
    const items = this.inputsState.inputItems();
    const updatedItems = [...items];
    updatedItems[index] = { ...updatedItems[index], mode };
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
            platform: this.inputsState.selectedPlatform() as 'youtube' | 'spreaker',
            mode: this.inputsState.selectedMode() as 'individual' | 'compilation'
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
            platform: this.inputsState.selectedPlatform() as 'youtube' | 'spreaker',
            mode: this.inputsState.selectedMode() as 'individual' | 'compilation'
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
            platform: this.inputsState.selectedPlatform() as 'youtube' | 'spreaker',
            mode: this.inputsState.selectedMode() as 'individual' | 'compilation'
          });
        }
      }
    }
  }

  removeInput(index: number) {
    this.inputsState.removeItem(index);
  }

  async onPlatformChange() {
    // Persist platform selection
    try {
      await this.electron.updateSettings({ platform: this.inputsState.selectedPlatform() });
    } catch (error) {
      console.error('Error saving platform:', error);
    }
  }

  async onModeChange() {
    // Persist mode selection
    try {
      await this.electron.updateSettings({ mode: this.inputsState.selectedMode() });
    } catch (error) {
      console.error('Error saving mode:', error);
    }
  }

  addToQueue() {
    if (this.selectedItems.length === 0) return;

    // Group items by platform and mode
    const groups: { [key: string]: InputItem[] } = {};

    this.selectedItems.forEach(item => {
      const key = `${item.platform}-${item.mode}`;
      if (!groups[key]) {
        groups[key] = [];
      }
      groups[key].push(item);
    });

    // Create a job for each group
    Object.entries(groups).forEach(([key, items]) => {
      const [platform, mode] = key.split('-');

      // Create a descriptive job name using the first item
      let jobName: string;
      if (items.length === 1) {
        // Single item: just use the item name
        jobName = `${items[0].displayName} - ${platform} (${mode})`;
      } else {
        // Multiple items: use first item + count
        const firstName = items[0].displayName;
        // Truncate if too long
        const truncatedName = firstName.length > 30 ? firstName.substring(0, 30) + '...' : firstName;
        jobName = `${truncatedName} + ${items.length - 1} more - ${platform} (${mode})`;
      }

      this.jobQueue.addJob(jobName, items);
    });

    // Deselect all items after adding to queue
    this.inputsState.inputItems().forEach((_, index) => {
      this.toggleItemSelection(index, false);
    });
  }

  startQueue() {
    if (this.queueStarted()) return;
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

      // Simulate progress
      const totalItems = nextJob.inputs.length;
      const estimatedTimePerItem = 30;
      const totalEstimatedTime = totalItems * estimatedTimePerItem;
      let simulatedProgress = 0;

      const progressInterval = setInterval(() => {
        if (simulatedProgress < 90) {
          simulatedProgress += (100 / totalEstimatedTime) * 2;
          if (simulatedProgress > 90) simulatedProgress = 90;
          this.jobQueue.updateJob(nextJob.id, { progress: simulatedProgress });
        }
      }, 2000);

      // Extract inputs based on platform and mode from the first item
      // (all items in the job have the same platform and mode)
      const firstItem = nextJob.inputs[0];
      const inputs = nextJob.inputs.map(item => item.path);

      const result = await this.electron.generateMetadata({
        inputs,
        platform: firstItem.platform,
        mode: firstItem.mode
      });

      clearInterval(progressInterval);
      clearInterval(elapsedInterval);

      const processingTime = ((Date.now() - startTime) / 1000);

      if (result.success) {
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
}
