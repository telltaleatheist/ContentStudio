import { Component, OnInit, signal, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ButtonComponent } from '../../components/button/button.component';
import { CascadeComponent } from '../../components/cascade/cascade.component';
import { ElectronService } from '../../services/electron.service';
import { InputsStateService } from '../../services/inputs-state.service';
import { NotificationService } from '../../services/notification.service';
import { CascadeGroup, CascadeItem, ContextMenuAction } from '../../models/file.model';

export interface HistoryJob {
  id: string;
  job_id?: string;
  name: string;
  job_name?: string;
  inputs: any[];
  items?: any[];
  source_items?: any[];
  promptSet: string;
  prompt_set?: string;
  mode: 'individual' | 'compilation';
  status: string;
  createdAt: string;
  created_at?: string;
  completedAt?: string;
  outputFiles?: string[];
  processingTime?: number;
  processing_time?: number;
  txt_folder?: string;
}

@Component({
  selector: 'app-history',
  standalone: true,
  imports: [CommonModule, ButtonComponent, CascadeComponent],
  templateUrl: './history.component.html',
  styleUrls: ['./history.component.scss']
})
export class HistoryComponent implements OnInit {
  private electron = inject(ElectronService);
  public inputsState = inject(InputsStateService);
  private notificationService = inject(NotificationService);

  historyJobs = signal<HistoryJob[]>([]);
  loading = signal(false);
  selectedJob = signal<HistoryJob | null>(null);

  // Context menu actions for cascade
  contextMenuActions: ContextMenuAction[] = [
    { label: 'Re-add to Queue', icon: '🔄', action: 'readd' },
    { label: 'Open Folder', icon: '📂', action: 'open' },
    { label: '', icon: '', action: '', divider: true },
    { label: 'Delete', icon: '🗑️', action: 'delete' }
  ];

  // Convert history jobs to cascade groups (grouped by date)
  cascadeGroups = computed<CascadeGroup[]>(() => {
    const jobs = this.historyJobs();
    if (jobs.length === 0) return [];

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);

    const groups: { [key: string]: HistoryJob[] } = {
      'Today': [],
      'Yesterday': [],
      'This Week': [],
      'Older': []
    };

    for (const job of jobs) {
      const jobDate = new Date(job.created_at || job.createdAt);
      jobDate.setHours(0, 0, 0, 0);

      if (jobDate.getTime() === today.getTime()) {
        groups['Today'].push(job);
      } else if (jobDate.getTime() === yesterday.getTime()) {
        groups['Yesterday'].push(job);
      } else if (jobDate > weekAgo) {
        groups['This Week'].push(job);
      } else {
        groups['Older'].push(job);
      }
    }

    const cascadeGroups: CascadeGroup[] = [];
    for (const [label, items] of Object.entries(groups)) {
      if (items.length > 0) {
        cascadeGroups.push({
          label,
          items: items.map(job => ({
            id: job.job_id || job.id,
            name: job.job_name || job.name || 'Unnamed Job',
            subtitle: `${this.getItemCount(job)} item${this.getItemCount(job) !== 1 ? 's' : ''} • ${this.formatShortDate(job.created_at || job.createdAt)}`,
            icon: this.getStatusIcon(job.status),
            status: job.status === 'completed' ? 'complete' as const :
                   job.status === 'failed' ? 'error' as const :
                   job.status === 'processing' ? 'active' as const : 'pending' as const
          })),
          expanded: true
        });
      }
    }

    return cascadeGroups;
  });

  async ngOnInit() {
    await this.loadHistory();
  }

  onCascadeSelectionChanged(event: { count: number; ids: Set<string> }) {
    if (event.ids.size === 1) {
      const compositeId = Array.from(event.ids)[0];
      const itemId = this.extractItemId(compositeId);
      const job = this.historyJobs().find(j => (j.job_id || j.id) === itemId);
      if (job) {
        this.selectedJob.set(job);
      }
    }
  }

  onJobDoubleClick(item: CascadeItem) {
    const job = this.historyJobs().find(j => (j.job_id || j.id) === item.id);
    if (job) {
      this.openOutputFolder(job);
    }
  }

  onCascadeAction(event: { action: string; items: CascadeItem[] }) {
    const jobs = event.items
      .map(item => this.historyJobs().find(j => (j.job_id || j.id) === item.id))
      .filter((j): j is HistoryJob => j !== undefined);

    if (jobs.length === 0) return;

    switch (event.action) {
      case 'readd':
        jobs.forEach(job => this.reAddToQueue(job));
        break;
      case 'open':
        this.openOutputFolder(jobs[0]);
        break;
      case 'delete':
        jobs.forEach(job => this.deleteHistory(job));
        break;
    }
  }

  private extractItemId(compositeId: string): string {
    const parts = compositeId.split('|');
    return parts.length > 1 ? parts.slice(1).join('|') : compositeId;
  }

  async loadHistory() {
    this.loading.set(true);
    try {
      const history = await this.electron.getJobHistory();
      this.historyJobs.set(history);
    } catch (error) {
      this.notificationService.error('Load Error', 'Failed to load history');
    } finally {
      this.loading.set(false);
    }
  }

  async reAddToQueue(job: any) {
    try {
      let itemsToAdd: any[] = [];

      if (job.items && Array.isArray(job.items)) {
        if (job.source_items && Array.isArray(job.source_items)) {
          itemsToAdd = job.source_items;
        } else {
          this.notificationService.warning('No Source Items', 'This job does not have source items to re-add');
          return;
        }
      } else if (job.inputs && Array.isArray(job.inputs)) {
        itemsToAdd = job.inputs;
      } else {
        this.notificationService.error('Invalid Data', 'Could not find items to re-add');
        return;
      }

      for (const input of itemsToAdd) {
        this.inputsState.addItem(input);
      }

      this.notificationService.success('Items Re-added', `Re-added ${itemsToAdd.length} item(s) to inputs`);
    } catch (error) {
      this.notificationService.error('Failed', 'Failed to re-add items');
    }
  }

  getItemCount(job: any): number {
    if (job.items && Array.isArray(job.items)) return job.items.length;
    if (job.inputs && Array.isArray(job.inputs)) return job.inputs.length;
    if (job.source_items && Array.isArray(job.source_items)) return job.source_items.length;
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
        // Clear selection if deleted job was selected
        if (this.selectedJob()?.id === job.id || this.selectedJob()?.job_id === job.job_id) {
          this.selectedJob.set(null);
        }
        await this.loadHistory();
        this.notificationService.success('Deleted', 'History entry deleted');
      } else {
        this.notificationService.error('Delete Failed', result.error || 'Unknown error');
      }
    } catch (error) {
      this.notificationService.error('Failed', 'Failed to delete history entry');
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
      } else {
        this.notificationService.warning('No Output', 'This job has no output folder');
      }
    } catch (error) {
      this.notificationService.error('Failed', 'Failed to open folder');
    }
  }

  formatDate(dateString: string): string {
    if (!dateString) return 'Unknown date';
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return 'Invalid date';
    return date.toLocaleString();
  }

  formatShortDate(dateString: string): string {
    if (!dateString) return '';
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return '';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
      case 'completed': return '✅';
      case 'failed': return '❌';
      case 'processing': return '⏳';
      case 'pending': return '🕐';
      default: return 'ℹ️';
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
          errorCount++;
        }
      }

      this.selectedJob.set(null);
      await this.loadHistory();

      if (successCount > 0) {
        this.notificationService.success('History Cleared', `Deleted ${successCount} history entries`);
      }

      if (errorCount > 0) {
        this.notificationService.warning('Partial Clear', `${errorCount} entries failed to delete`);
      }
    } catch (error) {
      this.notificationService.error('Failed', 'Failed to clear history');
    }
  }
}
