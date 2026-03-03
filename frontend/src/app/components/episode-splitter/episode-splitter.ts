import { Component, signal, OnInit, OnDestroy, NgZone } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatChipsModule } from '@angular/material/chips';
import { CommonModule } from '@angular/common';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { ElectronService } from '../../services/electron';
import { NotificationService } from '../../services/notification';
import { EpisodeSplitterStateService, AudioFileItem, EpisodeJob } from '../../services/episode-splitter-state';

@Component({
  selector: 'app-episode-splitter',
  standalone: true,
  imports: [
    MatIconModule,
    MatButtonModule,
    MatCardModule,
    MatProgressBarModule,
    MatTooltipModule,
    MatChipsModule,
    CommonModule,
    DragDropModule,
  ],
  templateUrl: './episode-splitter.html',
  styleUrl: './episode-splitter.scss',
})
export class EpisodeSplitter implements OnInit, OnDestroy {
  // Currently viewed report (for results display)
  activeReport = signal<any>(null);

  private progressUnsubscribe: (() => void) | null = null;

  constructor(
    private electron: ElectronService,
    private notificationService: NotificationService,
    public state: EpisodeSplitterStateService,
    private ngZone: NgZone
  ) {}

  ngOnInit() {
    // If we were processing when we left, reset state
    if (this.state.isProcessing()) {
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

  // Expose state signals for template
  get audioFiles() { return this.state.audioFiles; }
  get jobs() { return this.state.jobs; }
  get isProcessing() { return this.state.isProcessing; }

  // File selection
  async browseAudio() {
    const result = await this.electron.selectEpisodeAudio();
    if (result.success && result.filePaths && result.filePaths.length > 0) {
      const items: AudioFileItem[] = result.filePaths.map(fp => ({
        path: fp,
        displayName: fp.split(/[/\\]/).pop() || fp,
      }));
      this.state.addFiles(items);
    }
  }

  removeFile(index: number) {
    this.state.removeFile(index);
  }

  clearAllFiles() {
    this.state.clearFiles();
  }

  onDrop(event: CdkDragDrop<AudioFileItem[]>) {
    if (event.previousIndex !== event.currentIndex) {
      this.state.reorderFiles(event.previousIndex, event.currentIndex);
    }
  }

  // Analysis
  addToQueue() {
    const files = this.state.audioFiles();
    if (files.length === 0) return;

    const job: EpisodeJob = {
      id: `episode-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      name: files.length === 1 ? files[0].displayName : `${files.length} files`,
      audioPaths: files.map(f => f.path),
      status: 'pending',
      progress: 0,
      message: 'Waiting...'
    };
    this.state.addJob(job);

    this.notificationService.success('Added to Queue', `Added ${files.length} file(s) for episode analysis`);
  }

  async startQueue() {
    if (this.state.isProcessing()) return;

    const pendingJobs = this.state.jobs().filter(j => j.status === 'pending');
    if (pendingJobs.length === 0) return;

    this.state.isProcessing.set(true);

    // Subscribe to progress events
    this.progressUnsubscribe = this.electron.onEpisodeSplitterProgress((progress) => {
      this.ngZone.run(() => {
        if (progress.jobId) {
          this.state.updateJob(progress.jobId, {
            progress: progress.percent || 0,
            message: progress.message || 'Processing...'
          });
        }
      });
    });

    // Process jobs sequentially (each job is the full multi-file analysis)
    for (const job of pendingJobs) {
      await this.processJob(job);
    }

    // Cleanup
    if (this.progressUnsubscribe) {
      this.progressUnsubscribe();
      this.progressUnsubscribe = null;
    }
    this.state.isProcessing.set(false);
  }

  private async processJob(job: EpisodeJob): Promise<void> {
    this.state.updateJob(job.id, { status: 'processing', progress: 0, message: 'Queued for analysis...' });

    try {
      const result = await this.electron.analyzeEpisodes({
        audioPaths: job.audioPaths,
        jobId: job.id
      });

      if (result.success) {
        this.state.updateJob(job.id, {
          status: 'completed',
          progress: 100,
          message: `Found ${result.report?.episodeCount || 0} episodes`,
          report: result.report
        });

        this.activeReport.set(result.report);
        this.notificationService.success('Analysis Complete', `Found ${result.report?.episodeCount || 0} episode boundaries`);
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

  // View a completed job's report
  viewJobReport(job: EpisodeJob) {
    if (job.report) {
      this.activeReport.set(job.report);
    }
  }

  clearReport() {
    this.activeReport.set(null);
  }

  // Copy timecodes to clipboard
  copyTimecodes() {
    const report = this.activeReport();
    if (!report || !report.episodes) return;

    const sections: string[] = [];

    // Episode boundaries
    sections.push('=== EPISODE BOUNDARIES ===');
    for (const ep of report.episodes) {
      sections.push(`Episode ${ep.episodeNumber}: ${ep.startTimestamp} - ${ep.endTimestamp} (${this.formatDuration(ep.durationSeconds)}) - ${ep.title}`);
    }

    // Profanity flags
    const allMarkers = report.episodes.flatMap((ep: any) =>
      (ep.profanityMarkers || []).map((m: any) => ({ ...m, episodeNumber: ep.episodeNumber }))
    );
    if (allMarkers.length > 0) {
      sections.push('');
      sections.push('=== PROFANITY FLAGS ===');
      for (const ep of report.episodes) {
        if (ep.profanityMarkers && ep.profanityMarkers.length > 0) {
          sections.push(`\nEpisode ${ep.episodeNumber}: ${ep.profanityMarkers.length} flagged`);
          for (const m of ep.profanityMarkers) {
            const label = m.inOpening ? ' ⚠ IN FIRST 3 MIN' : '';
            sections.push(`  ${m.localTimestamp} "${m.word}"${label}`);
          }
        }
      }
    }

    // Source file breakdown
    if (report.sourceFileBreakdown && report.sourceFileBreakdown.length > 0) {
      sections.push('');
      sections.push('=== SOURCE FILE BREAKDOWN ===');
      for (const file of report.sourceFileBreakdown) {
        sections.push(`\nFile ${file.fileIndex}: ${file.fileName} (${file.fileDuration})`);
        for (const seg of file.segments) {
          sections.push(`  → Episode ${seg.episodeNumber}: ${seg.localStartTimestamp} - ${seg.localEndTimestamp} (${this.formatDuration(seg.durationSeconds)})`);
        }
      }
    }

    const text = sections.join('\n');
    navigator.clipboard.writeText(text).then(() => {
      this.notificationService.success('Copied', 'Episode timecodes and file breakdown copied to clipboard');
    });
  }

  // Helpers
  formatDuration(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
      return `${h}h ${m}m`;
    }
    return `${m}m ${s}s`;
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

  getSegmentBarWidth(segment: any, file: any): string {
    if (!file.fileDurationSeconds) return '0%';
    return `${(segment.durationSeconds / file.fileDurationSeconds) * 100}%`;
  }

  getSegmentBarColor(index: number): string {
    const colors = ['#4caf50', '#2196f3', '#ff9800', '#9c27b0', '#00bcd4', '#e91e63', '#8bc34a', '#ff5722'];
    return colors[index % colors.length];
  }

  getDurationBarWidth(episode: any): string {
    const report = this.activeReport();
    if (!report) return '0%';
    return `${(episode.durationSeconds / report.totalDurationSeconds) * 100}%`;
  }

  getDurationBarColor(episode: any): string {
    if (episode.exceedsMaxDuration) return '#f44336';
    if (episode.durationSeconds > 3600) return 'var(--primary-orange)';
    return '#4caf50';
  }

  // Profanity helpers
  hasOpeningProfanity(episode: any): boolean {
    return episode.profanityMarkers?.some((m: any) => m.inOpening) || false;
  }

  getProfanitySummary(episode: any): string {
    const markers = episode.profanityMarkers || [];
    const openingCount = markers.filter((m: any) => m.inOpening).length;
    if (openingCount > 0) {
      return `${openingCount} in first 3 min, ${markers.length} total`;
    }
    return `${markers.length} flagged (none in first 3 min)`;
  }

  getOpeningBarWidth(episode: any): string {
    if (!episode.durationSeconds) return '0%';
    const openingSeconds = Math.min(180, episode.durationSeconds);
    return `${(openingSeconds / episode.durationSeconds) * 100}%`;
  }

  getProfanityDotPosition(marker: any, episode: any): string {
    if (!episode.durationSeconds) return '0%';
    return `${(marker.localSeconds / episode.durationSeconds) * 100}%`;
  }
}
