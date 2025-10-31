import { Component, OnInit, signal } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatListModule } from '@angular/material/list';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatChipsModule } from '@angular/material/chips';
import { ElectronService } from '../../services/electron';

interface MetadataReport {
  name: string;
  path: string;
  date: Date;
  size: number;
  platform: string;
}

interface ParsedMetadata {
  titles: string[];
  thumbnail_text: string[];
  description: string;
  tags: string;
  hashtags: string;
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
    MatChipsModule
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

  constructor(private electron: ElectronService) {}

  async ngOnInit() {
    await this.loadReports();
  }

  async loadReports() {
    try {
      this.isLoading.set(true);

      // Get settings to determine output directory
      const settings = await this.electron.getSettings();
      const baseDir = settings.outputDirectory || `${this.getUserHome()}/Documents/LaunchPad Output`;
      this.reportsDirectory.set(`${baseDir}/metadata`);

      // Read metadata directory
      const result = await this.electron.readDirectory(this.reportsDirectory());

      if (result.success && result.directories) {
        const reports: MetadataReport[] = [];

        for (const dir of result.directories) {
          // Each directory contains metadata.json and metadata.txt
          const jsonPath = `${dir.path}/metadata.json`;
          const platform = dir.name.includes('youtube') ? 'youtube' :
                          dir.name.includes('spreaker') ? 'spreaker' : 'unknown';

          reports.push({
            name: dir.name,
            path: dir.path,
            date: new Date(dir.mtime),
            size: dir.size || 0,
            platform
          });
        }

        // Sort by date descending
        reports.sort((a, b) => b.date.getTime() - a.date.getTime());
        this.reports.set(reports);
      }
    } catch (error) {
      console.error('Error loading reports:', error);
    } finally {
      this.isLoading.set(false);
    }
  }

  async selectReport(report: MetadataReport) {
    try {
      this.isLoading.set(true);
      this.selectedReport.set(report);

      // Read the metadata.json file
      const jsonPath = `${report.path}/metadata.json`;
      const content = await this.electron.readFile(jsonPath);

      if (content) {
        const parsed = JSON.parse(content);
        this.metadata.set(parsed);
      }
    } catch (error) {
      console.error('Error reading report:', error);
      alert('Failed to read report: ' + error);
    } finally {
      this.isLoading.set(false);
    }
  }

  async showInFolder(report: MetadataReport) {
    try {
      await this.electron.showInFolder(report.path);
    } catch (error) {
      console.error('Error showing in folder:', error);
      alert('Failed to show in folder');
    }
  }

  async deleteReport(report: MetadataReport, event: Event) {
    event.stopPropagation();

    const confirmed = confirm(
      `Are you sure you want to delete "${report.name}"?\n\nThis will permanently delete the metadata files. This action cannot be undone.`
    );

    if (!confirmed) return;

    try {
      await this.electron.deleteDirectory(report.path);

      // Remove from list
      this.reports.update(reports => reports.filter(r => r.path !== report.path));

      // Clear selection if deleted report was selected
      if (this.selectedReport()?.path === report.path) {
        this.selectedReport.set(null);
        this.metadata.set(null);
      }

      alert('Report deleted successfully');
    } catch (error) {
      console.error('Error deleting report:', error);
      alert('Failed to delete report');
    }
  }

  getPlatformIcon(platform: string): string {
    const icons: {[key: string]: string} = {
      'youtube': 'video_library',
      'spreaker': 'podcasts',
      'unknown': 'description'
    };
    return icons[platform] || 'description';
  }

  getPlatformColor(platform: string): string {
    const colors: {[key: string]: string} = {
      'youtube': '#FF0000',
      'spreaker': '#F5620F',
      'unknown': '#757575'
    };
    return colors[platform] || '#757575';
  }

  formatFileSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  formatDate(date: Date): string {
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).then(() => {
      // Optional: Show a toast notification
      console.log('Copied to clipboard');
    }).catch(err => {
      console.error('Failed to copy:', err);
      alert('Failed to copy to clipboard');
    });
  }

  getDescriptionWithHashtags(): string {
    const meta = this.metadata();
    if (!meta) return '';

    // Build description with hashtags above description links
    let result = meta.description || '';

    // If description already contains hashtags (they're embedded), return as-is
    if (meta.hashtags && result.includes(meta.hashtags)) {
      return result;
    }

    // Otherwise, we need to insert hashtags
    // Find where description links start (they usually start with emoji or "Support")
    const linksMarkers = ['🔥', '📖', '🎥', 'Support the Channel', 'Become a YouTube Member'];
    let insertPosition = -1;

    for (const marker of linksMarkers) {
      const pos = result.indexOf(marker);
      if (pos !== -1) {
        insertPosition = pos;
        break;
      }
    }

    if (insertPosition !== -1 && meta.hashtags) {
      // Insert hashtags before description links
      result = result.substring(0, insertPosition) + '\n\n' + meta.hashtags + '\n\n' + result.substring(insertPosition);
    } else if (meta.hashtags) {
      // Just append hashtags at the end
      result = result + '\n\n' + meta.hashtags;
    }

    return result;
  }

  private getUserHome(): string {
    // This will be replaced by actual electron call in production
    return '/Users/telltale';
  }
}
