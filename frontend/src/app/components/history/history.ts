import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ElectronService } from '../../services/electron';
import { NotificationService } from '../../services/notification';

interface TextInputEntry {
  text: string;
  date: string;
  jobId: string;
  promptSet: string;
}

@Component({
  selector: 'app-history',
  imports: [
    CommonModule,
    MatCardModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule
  ],
  templateUrl: './history.html',
  styleUrl: './history.scss',
})
export class History implements OnInit {
  entries = signal<TextInputEntry[]>([]);
  loading = signal(false);

  // Track copied state for visual feedback
  copiedIndex = signal<number | null>(null);
  private copiedTimeout: any = null;

  constructor(
    private electron: ElectronService,
    private notificationService: NotificationService
  ) {}

  async ngOnInit() {
    await this.loadHistory();
  }

  async loadHistory() {
    this.loading.set(true);
    try {
      const history = await this.electron.getJobHistory();
      // Flatten jobs into individual text input entries
      const entries: TextInputEntry[] = [];

      for (const job of history) {
        const inputs = job.original_inputs || [];
        const date = job.created_at || job.createdAt || '';
        const jobId = job.job_id || job.id || '';
        const promptSet = job.prompt_set || job.promptSet || '';

        if (inputs.length > 0) {
          for (const input of inputs) {
            entries.push({ text: input, date, jobId, promptSet });
          }
        } else {
          // Fallback: use job_name as the text
          const name = job.job_name || job.name || '';
          if (name) {
            entries.push({ text: name, date, jobId, promptSet });
          }
        }
      }

      this.entries.set(entries);
    } catch (error) {
      console.error('Error loading history:', error);
      this.notificationService.error('Failed to load history', String(error));
    } finally {
      this.loading.set(false);
    }
  }

  copyEntry(entry: TextInputEntry, index: number) {
    navigator.clipboard.writeText(entry.text).then(() => {
      this.setCopied(index);
    }).catch(err => {
      this.notificationService.error('Copy Failed', err.message);
    });
  }

  copyAll() {
    const allText = this.entries().map(e => e.text).join('\n');
    navigator.clipboard.writeText(allText).then(() => {
      this.notificationService.success('Copied', `${this.entries().length} entries copied to clipboard`, false);
    }).catch(err => {
      this.notificationService.error('Copy Failed', err.message);
    });
  }

  private setCopied(index: number) {
    if (this.copiedTimeout) {
      clearTimeout(this.copiedTimeout);
    }
    this.copiedIndex.set(index);
    this.copiedTimeout = setTimeout(() => {
      this.copiedIndex.set(null);
    }, 1500);
  }

  formatDate(dateString: string): string {
    if (!dateString) return '';
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return '';
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  async clearAllHistory() {
    if (!confirm(`Clear all ${this.entries().length} history entries? This cannot be undone.`)) {
      return;
    }

    try {
      // Get unique job IDs to delete
      const jobIds = new Set(this.entries().map(e => e.jobId));
      let successCount = 0;

      for (const jobId of jobIds) {
        try {
          const result = await this.electron.deleteJobHistory(jobId);
          if (result.success) successCount++;
        } catch (error) {
          console.error('Error deleting job:', error);
        }
      }

      await this.loadHistory();

      if (successCount > 0) {
        this.notificationService.success('History Cleared', `Deleted ${successCount} entries`);
      }
    } catch (error) {
      console.error('Error clearing history:', error);
      this.notificationService.error('Failed to clear history', String(error));
    }
  }
}
