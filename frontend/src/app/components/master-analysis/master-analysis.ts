import { Component, signal, OnInit, OnDestroy, NgZone } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatChipsModule } from '@angular/material/chips';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { ElectronService } from '../../services/electron';
import { NotificationService } from '../../services/notification';
import { MasterAnalysisStateService, VideoItem, MasterJob } from '../../services/master-analysis-state';
import { Router } from '@angular/router';

interface MasterPromptSetOption {
  id: string;
  name: string;
  description?: string;
}

@Component({
  selector: 'app-master-analysis',
  standalone: true,
  imports: [
    MatIconModule,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatSelectModule,
    MatProgressBarModule,
    MatTooltipModule,
    MatCheckboxModule,
    MatChipsModule,
    FormsModule,
    CommonModule,
    DragDropModule,
  ],
  templateUrl: './master-analysis.html',
  styleUrl: './master-analysis.scss',
})
export class MasterAnalysis implements OnInit, OnDestroy {
  // Master analysis prompt sets (local, loaded fresh each time)
  masterPromptSets = signal<MasterPromptSetOption[]>([]);

  private progressUnsubscribe: (() => void) | null = null;

  constructor(
    private electron: ElectronService,
    private notificationService: NotificationService,
    public state: MasterAnalysisStateService,
    private router: Router,
    private ngZone: NgZone
  ) {}

  async ngOnInit() {
    await this.loadMasterPromptSets();

    // If we were processing when we left, reset state (jobs need to be restarted manually)
    if (this.state.isProcessing()) {
      // Reset processing jobs to pending
      const jobs = this.state.jobs();
      jobs.forEach(job => {
        if (job.status === 'processing') {
          this.state.updateJob(job.id, { status: 'pending', progress: 0, message: '' });
        }
      });
      this.state.isProcessing.set(false);
    }
  }

  ngOnDestroy() {
    if (this.progressUnsubscribe) {
      this.progressUnsubscribe();
    }
  }

  async loadMasterPromptSets() {
    try {
      const result = await this.electron.listMasterPromptSets();
      if (result.success) {
        this.masterPromptSets.set(result.promptSets);
        if (result.promptSets.length > 0) {
          const currentSelection = this.state.selectedPromptSet();
          const exists = result.promptSets.some((ps: MasterPromptSetOption) => ps.id === currentSelection);
          if (!exists) {
            this.state.selectedPromptSet.set(result.promptSets[0].id);
          }
        }
      }
    } catch (error) {
      this.notificationService.error('Error', 'Failed to load master prompt sets: ' + (error as Error).message);
    }
  }

  // Expose state signals for template
  get videoItems() { return this.state.videoItems; }
  get selectedPromptSet() { return this.state.selectedPromptSet; }
  get jobs() { return this.state.jobs; }
  get isProcessing() { return this.state.isProcessing; }

  // File selection
  async browseVideos() {
    const result = await this.electron.selectMasterVideo();
    if (result.success && result.videoPath) {
      const fileName = result.videoPath.split(/[/\\]/).pop() || result.videoPath;
      this.state.addVideo({
        path: result.videoPath,
        displayName: fileName,
        selected: true
      });
    }
  }

  // Selection helpers
  get selectedItems(): VideoItem[] {
    return this.state.videoItems().filter(item => item.selected);
  }

  get hasSelectedItems(): boolean {
    return this.selectedItems.length > 0;
  }

  get allItemsSelected(): boolean {
    const items = this.state.videoItems();
    return items.length > 0 && items.every(item => item.selected);
  }

  toggleSelectAll() {
    this.state.toggleSelectAll(!this.allItemsSelected);
  }

  toggleItemSelection(index: number) {
    this.state.toggleVideoSelection(index);
  }

  removeVideo(index: number) {
    this.state.removeVideo(index);
  }

  clearAllVideos() {
    this.state.clearVideos();
  }

  onDrop(event: CdkDragDrop<VideoItem[]>) {
    if (event.previousIndex !== event.currentIndex) {
      this.state.videoItems.update(items => {
        const updated = [...items];
        moveItemInArray(updated, event.previousIndex, event.currentIndex);
        return updated;
      });
    }
  }

  // Queue management
  addToQueue() {
    const selected = this.selectedItems;
    if (selected.length === 0) return;

    const promptSet = this.state.selectedPromptSet();

    selected.forEach(video => {
      const job: MasterJob = {
        id: `master-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        name: video.displayName,
        videoPath: video.path,
        promptSet: promptSet,
        status: 'pending',
        progress: 0,
        message: 'Waiting...'
      };
      this.state.addJob(job);
    });

    // Deselect all items after adding to queue
    this.state.toggleSelectAll(false);

    this.notificationService.success('Added to Queue', `Added ${selected.length} video(s) to the analysis queue`);
  }

  async startQueue() {
    if (this.state.isProcessing()) return;

    const pendingJobs = this.state.jobs().filter(j => j.status === 'pending');
    if (pendingJobs.length === 0) return;

    this.state.isProcessing.set(true);

    // Subscribe to progress events (routes by jobId)
    this.progressUnsubscribe = this.electron.onMasterAnalysisProgress((progress) => {
      this.ngZone.run(() => {
        if (progress.jobId) {
          this.state.updateJob(progress.jobId, {
            progress: progress.percent || 0,
            message: progress.message || 'Processing...'
          });
        }
      });
    });

    // Start ALL pending jobs in parallel (backend queue manager handles concurrency: 5 transcription, 1 AI)
    const jobPromises = pendingJobs.map(job => this.processJob(job));

    // Wait for all jobs to complete
    await Promise.allSettled(jobPromises);

    // Cleanup
    if (this.progressUnsubscribe) {
      this.progressUnsubscribe();
      this.progressUnsubscribe = null;
    }
    this.state.isProcessing.set(false);
  }

  private async processJob(job: MasterJob): Promise<void> {
    // Update job status
    this.state.updateJob(job.id, { status: 'processing', progress: 0, message: 'Queued for analysis...' });

    try {
      const result = await this.electron.analyzeMaster({
        videoPath: job.videoPath,
        masterPromptSet: job.promptSet,
        jobId: job.id
      });

      if (result.success) {
        this.state.updateJob(job.id, {
          status: 'completed',
          progress: 100,
          message: `Found ${result.report?.sectionCount || 0} sections`
        });

        this.notificationService.success('Analysis Complete', `"${job.name}" - Found ${result.report?.sectionCount || 0} sections`);
      } else {
        this.state.updateJob(job.id, {
          status: 'failed',
          progress: 0,
          message: 'Failed',
          error: result.error
        });

        this.notificationService.error('Analysis Failed', result.error || 'Unknown error');
      }
    } catch (error) {
      this.state.updateJob(job.id, {
        status: 'failed',
        progress: 0,
        message: 'Error',
        error: (error as Error).message
      });

      this.notificationService.error('Analysis Error', (error as Error).message);
    }
  }

  removeJob(jobId: string) {
    this.state.removeJob(jobId);
  }

  clearCompletedJobs() {
    this.state.clearCompletedJobs();
  }

  // Navigation
  viewReports() {
    this.router.navigate(['/master-reports']);
  }

  // Helper methods
  getPromptSetName(id: string): string {
    const ps = this.masterPromptSets().find(p => p.id === id);
    return ps?.name || id;
  }

  getPendingJobsCount(): number {
    return this.state.getPendingJobsCount();
  }

  getCompletedJobsCount(): number {
    return this.state.getCompletedJobsCount();
  }

  getOverallProgress(): number {
    const allJobs = this.state.jobs();
    if (allJobs.length === 0) return 0;

    const total = allJobs.reduce((sum, job) => {
      if (job.status === 'completed') return sum + 100;
      if (job.status === 'failed') return sum + 100;
      return sum + job.progress;
    }, 0);

    return total / allJobs.length;
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
      case 'pending': return 'var(--text-muted)';
      case 'processing': return 'var(--primary-orange)';
      case 'completed': return '#4caf50';
      case 'failed': return '#f44336';
      default: return 'var(--text-muted)';
    }
  }
}
