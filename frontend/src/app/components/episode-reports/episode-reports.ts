import { Component, OnInit, signal } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ElectronService } from '../../services/electron';
import { NotificationService } from '../../services/notification';

interface EpisodeReportItem {
  path: string;
  report: any;
}

@Component({
  selector: 'app-episode-reports',
  standalone: true,
  imports: [
    MatCardModule,
    MatIconModule,
    MatButtonModule,
    MatChipsModule,
    MatProgressSpinnerModule,
    MatTooltipModule
  ],
  templateUrl: './episode-reports.html',
  styleUrl: './episode-reports.scss'
})
export class EpisodeReports implements OnInit {
  reports = signal<EpisodeReportItem[]>([]);
  selectedReport = signal<EpisodeReportItem | null>(null);
  isLoading = signal(false);

  constructor(
    private electron: ElectronService,
    private notificationService: NotificationService
  ) {}

  async ngOnInit() {
    await this.loadReports();
  }

  async loadReports() {
    try {
      this.isLoading.set(true);
      const result = await this.electron.listEpisodeReports();

      if (result.success && result.reports) {
        this.reports.set(result.reports);
      } else {
        this.reports.set([]);
      }
    } catch (error) {
      this.notificationService.error('Load Error', 'Failed to load episode reports: ' + (error as Error).message);
    } finally {
      this.isLoading.set(false);
    }
  }

  selectReport(report: EpisodeReportItem) {
    const currentSelected = this.selectedReport();
    if (currentSelected?.path === report.path) {
      this.selectedReport.set(null);
    } else {
      this.selectedReport.set(report);
    }
  }

  async deleteReport(report: EpisodeReportItem, event: Event) {
    event.stopPropagation();

    try {
      const result = await this.electron.deleteEpisodeReport(report.path);
      if (result.success) {
        this.reports.update(reports => reports.filter(r => r.path !== report.path));
        if (this.selectedReport()?.path === report.path) {
          this.selectedReport.set(null);
        }
        this.notificationService.success('Deleted', 'Report deleted successfully');
      } else {
        this.notificationService.error('Delete Error', result.error || 'Failed to delete report');
      }
    } catch (error) {
      this.notificationService.error('Delete Error', 'Failed to delete report: ' + (error as Error).message);
    }
  }

  copyTimecodes() {
    const report = this.selectedReport()?.report;
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
            const label = m.inOpening ? ' \u26a0 IN FIRST 3 MIN' : '';
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
          sections.push(`  \u2192 Episode ${seg.episodeNumber}: ${seg.localStartTimestamp} - ${seg.localEndTimestamp} (${this.formatDuration(seg.durationSeconds)})`);
        }
      }
    }

    const text = sections.join('\n');
    navigator.clipboard.writeText(text).then(() => {
      this.notificationService.success('Copied', 'Episode timecodes and file breakdown copied to clipboard');
    });
  }

  // Helpers
  formatDate(dateString: string): string {
    const date = new Date(dateString);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  formatDuration(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
      return `${h}h ${m}m`;
    }
    return `${m}m ${s}s`;
  }

  getReportTitle(report: any): string {
    if (report.audioFiles.length === 1) {
      return report.audioFiles[0].name;
    }
    return `${report.audioFiles.length} files`;
  }

  getDurationBarWidth(episode: any): string {
    const report = this.selectedReport()?.report;
    if (!report) return '0%';
    return `${(episode.durationSeconds / report.totalDurationSeconds) * 100}%`;
  }

  getDurationBarColor(episode: any): string {
    if (episode.exceedsMaxDuration) return '#f44336';
    if (episode.durationSeconds > 3600) return 'var(--primary-orange)';
    return '#4caf50';
  }

  getSegmentBarWidth(segment: any, file: any): string {
    if (!file.fileDurationSeconds) return '0%';
    return `${(segment.durationSeconds / file.fileDurationSeconds) * 100}%`;
  }

  getSegmentBarColor(index: number): string {
    const colors = ['#4caf50', '#2196f3', '#ff9800', '#9c27b0', '#00bcd4', '#e91e63', '#8bc34a', '#ff5722'];
    return colors[index % colors.length];
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
}
