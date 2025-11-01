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
  promptSet?: string; // The prompt set used for generation
  displayTitle?: string; // The actual title from the metadata
}

interface ParsedMetadata {
  titles: string[];
  thumbnail_text: string[];
  description: string;
  tags: string;
  hashtags: string;
  _title?: string; // The display title from the source
  _prompt_set?: string; // The prompt set used for generation
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

      // Try multiple possible locations for metadata directory
      const possiblePaths = [
        `${baseDir}/metadata`,
        `/Volumes/Callisto/LaunchPad/metadata`, // Legacy path
        `/Volumes/Callisto/Projects/LaunchPad/output/metadata`,
        `${this.getUserHome()}/Documents/LaunchPad Output/metadata`
      ];

      let metadataDir = '';
      let result: any = null;

      // Find the first path that exists and has contents
      for (const path of possiblePaths) {
        try {
          const testResult = await this.electron.readDirectory(path);
          if (testResult.success) {
            metadataDir = path;
            result = testResult;
            console.log('Found metadata directory:', path);
            break;
          }
        } catch (e) {
          // Continue to next path
        }
      }

      if (!metadataDir || !result) {
        console.warn('No metadata directory found in any location');
        this.reportsDirectory.set(possiblePaths[0]); // Use default for display
        return;
      }

      this.reportsDirectory.set(metadataDir);

      if (result.success && result.directories) {
        const reports: MetadataReport[] = [];

        for (const dir of result.directories) {
          // Try to read the title and prompt set from the JSON file
          let displayTitle = dir.name;
          let promptSet: string | undefined;

          try {
            // Try to find and read any JSON file in the directory
            const dirContents = await this.electron.readDirectory(dir.path);
            if (dirContents.success && dirContents.files) {
              const jsonFile = dirContents.files.find((f: any) => f.name.endsWith('.json'));
              if (jsonFile) {
                const jsonPath = `${dir.path}/${jsonFile.name}`;
                const content = await this.electron.readFile(jsonPath);
                if (content) {
                  const parsed = JSON.parse(content);
                  if (parsed._title) {
                    displayTitle = parsed._title;
                  }
                  if (parsed._prompt_set) {
                    promptSet = parsed._prompt_set;
                  }
                }
              }
            }
          } catch (e) {
            // Fallback to folder name if reading fails
            console.warn('Could not read metadata for', dir.name);
          }

          reports.push({
            name: dir.name,
            path: dir.path,
            date: new Date(dir.mtime),
            size: dir.size || 0,
            promptSet,
            displayTitle
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

      // Try to read the JSON file with the actual title name first
      // Fall back to metadata.json if not found
      let jsonPath = `${report.path}/metadata.json`;
      let content = await this.electron.readFile(jsonPath);

      // If not found, try finding any .json file in the directory
      if (!content) {
        const dirContents = await this.electron.readDirectory(report.path);
        if (dirContents.success && dirContents.files) {
          const jsonFile = dirContents.files.find((f: any) => f.name.endsWith('.json'));
          if (jsonFile) {
            jsonPath = `${report.path}/${jsonFile.name}`;
            content = await this.electron.readFile(jsonPath);
          }
        }
      }

      if (content) {
        const parsed = JSON.parse(content);
        this.metadata.set(parsed);
      }
    } catch (error) {
      console.error('Error reading report:', error);
    } finally {
      this.isLoading.set(false);
    }
  }

  getDisplayTitle(report: MetadataReport): string {
    // If we have loaded metadata with a title, use it
    if (this.selectedReport()?.path === report.path && this.metadata()?._title) {
      return this.metadata()!._title!;
    }
    // Otherwise use the folder name
    return report.name;
  }

  async showInFolder(report: MetadataReport) {
    try {
      await this.electron.showInFolder(report.path);
    } catch (error) {
      console.error('Error showing in folder:', error);
    }
  }

  async deleteReport(report: MetadataReport, event: Event) {
    event.stopPropagation();

    try {
      await this.electron.deleteDirectory(report.path);

      // Remove from list
      this.reports.update(reports => reports.filter(r => r.path !== report.path));

      // Clear selection if deleted report was selected
      if (this.selectedReport()?.path === report.path) {
        this.selectedReport.set(null);
        this.metadata.set(null);
      }
    } catch (error) {
      console.error('Error deleting report:', error);
    }
  }

  formatDate(date: Date): string {
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).then(() => {
      console.log('Copied to clipboard');
    }).catch(err => {
      console.error('Failed to copy:', err);
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
