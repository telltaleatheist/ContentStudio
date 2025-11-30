import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ElectronService } from '../../services/electron';
import { InputsStateService } from '../../services/inputs-state';
import { JobQueueService } from '../../services/job-queue';
import { NotificationService } from '../../services/notification';

export interface HistoryJob {
  id: string;
  name: string;
  inputs: any[];
  promptSet: string;
  mode: 'individual' | 'compilation';
  status: string;
  createdAt: string;
  completedAt?: string;
  outputFiles?: string[];
  processingTime?: number;
  metadataPath?: string;
}

@Component({
  selector: 'app-history',
  imports: [
    CommonModule,
    MatCardModule,
    MatIconModule,
    MatButtonModule,
    MatChipsModule,
    MatTooltipModule
  ],
  templateUrl: './history.html',
  styleUrl: './history.scss',
})
export class History implements OnInit {
  historyJobs = signal<HistoryJob[]>([]);
  loading = signal(false);

  constructor(
    private electron: ElectronService,
    public inputsState: InputsStateService,
    public jobQueue: JobQueueService,
    private notificationService: NotificationService
  ) {}

  async ngOnInit() {
    await this.loadHistory();
  }

  async loadHistory() {
    this.loading.set(true);
    try {
      const history = await this.electron.getJobHistory();
      this.historyJobs.set(history);
    } catch (error) {
      console.error('Error loading history:', error);
      this.notificationService.error('Failed to load history', String(error));
    } finally {
      this.loading.set(false);
    }
  }

  async reAddToQueue(job: any) {
    try {
      // Handle both old structure (inputs array) and new structure (items array with source_items)
      let itemsToAdd: any[] = [];

      if (job.items && Array.isArray(job.items)) {
        // New structure - items is an array of metadata items
        // We need the source items that were used to generate this
        if (job.source_items && Array.isArray(job.source_items)) {
          itemsToAdd = job.source_items;
        } else {
          this.notificationService.warning('No Source Items', 'This job does not have source items to re-add');
          return;
        }
      } else if (job.inputs && Array.isArray(job.inputs)) {
        // Old structure
        itemsToAdd = job.inputs;
      } else {
        this.notificationService.error('Invalid Data', 'Could not find items to re-add');
        return;
      }

      // Add the items back to the inputs state
      for (const input of itemsToAdd) {
        this.inputsState.addItem(input);
      }

      this.notificationService.success('Items Re-added', `Re-added ${itemsToAdd.length} item(s) to inputs`);
    } catch (error) {
      console.error('Error re-adding to queue:', error);
      this.notificationService.error('Failed to re-add items', String(error));
    }
  }

  getItemCount(job: any): number {
    if (job.items && Array.isArray(job.items)) {
      return job.items.length;
    }
    if (job.inputs && Array.isArray(job.inputs)) {
      return job.inputs.length;
    }
    if (job.source_items && Array.isArray(job.source_items)) {
      return job.source_items.length;
    }
    return 0;
  }

  async deleteHistory(job: any) {
    try {
      const jobId = job.job_id || job.id;
      if (!jobId) {
        this.notificationService.error('Delete Failed', 'Job ID not found');
        return;
      }

      const result = await this.electron.deleteJobHistory(jobId);
      if (result.success) {
        await this.loadHistory();
        this.notificationService.success('History Deleted', 'History entry deleted');
      } else {
        this.notificationService.error('Delete Failed', result.error || 'Unknown error');
      }
    } catch (error) {
      console.error('Error deleting history:', error);
      this.notificationService.error('Failed to delete history entry', String(error));
    }
  }

  async openOutputFolder(job: any) {
    try {
      let folderPath = '';

      if (job.txt_folder) {
        folderPath = job.txt_folder;
      } else if (job.outputFiles && job.outputFiles.length > 0) {
        const outputPath = job.outputFiles[0].split('/').slice(0, -1).join('/');
        folderPath = outputPath;
      }

      if (folderPath) {
        const result = await this.electron.openFolder(folderPath);
        if (!result.success) {
          this.notificationService.error('Failed to open folder', result.error || 'Unknown error');
        }
      }
    } catch (error) {
      console.error('Error opening folder:', error);
      this.notificationService.error('Failed to open folder', String(error));
    }
  }

  formatDate(dateString: string): string {
    if (!dateString) return 'Unknown date';
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return 'Invalid date';
    return date.toLocaleString();
  }

  formatDuration(ms?: number): string {
    if (!ms) return 'N/A';
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return minutes > 0 ? `${minutes}m ${remainingSeconds}s` : `${seconds}s`;
  }

  getStatusIcon(status: string): string {
    switch (status) {
      case 'completed': return 'check_circle';
      case 'failed': return 'error';
      case 'processing': return 'hourglass_empty';
      case 'pending': return 'schedule';
      default: return 'info';
    }
  }

  async clearAllHistory() {
    if (!confirm(`Are you sure you want to clear all ${this.historyJobs().length} history entries? This cannot be undone.`)) {
      return;
    }

    try {
      let successCount = 0;
      let errorCount = 0;

      for (const job of this.historyJobs()) {
        try {
          const jobId = (job as any).job_id || (job as any).id;
          if (jobId) {
            const result = await this.electron.deleteJobHistory(jobId);
            if (result.success) {
              successCount++;
            } else {
              errorCount++;
            }
          }
        } catch (error) {
          console.error('Error deleting job:', error);
          errorCount++;
        }
      }

      // Reload the history
      await this.loadHistory();

      if (successCount > 0) {
        this.notificationService.success('History Cleared', `Deleted ${successCount} history entries`);
      }

      if (errorCount > 0) {
        this.notificationService.warning('Partial Clear', `${errorCount} entries failed to delete`);
      }
    } catch (error) {
      console.error('Error clearing history:', error);
      this.notificationService.error('Failed to clear history', String(error));
    }
  }
}
