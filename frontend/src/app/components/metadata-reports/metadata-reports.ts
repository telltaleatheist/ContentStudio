import { Component, OnInit, OnDestroy, signal } from '@angular/core';
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
  txtFolder?: string; // Path to the folder containing txt files
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
export class MetadataReports implements OnInit, OnDestroy {
  reports = signal<MetadataReport[]>([]);
  selectedReport = signal<MetadataReport | null>(null);
  metadata = signal<ParsedMetadata | null>(null);
  isLoading = signal(false);
  reportsDirectory = signal('');

  private visibilityChangeHandler: (() => void) | null = null;

  constructor(private electron: ElectronService) {}

  async ngOnInit() {
    await this.loadReports();

    // Auto-refresh when tab becomes visible (e.g., after Cmd+Tab back to app)
    this.visibilityChangeHandler = () => {
      if (!document.hidden) {
        console.log('Tab became visible, refreshing reports...');
        this.loadReports();
      }
    };
    document.addEventListener('visibilitychange', this.visibilityChangeHandler);
  }

  ngOnDestroy() {
    if (this.visibilityChangeHandler) {
      document.removeEventListener('visibilitychange', this.visibilityChangeHandler);
    }
  }

  async loadReports() {
    try {
      this.isLoading.set(true);

      // Get settings to determine output directory
      const settings = await this.electron.getSettings();
      const baseDir = settings.outputDirectory || `${this.getUserHome()}/Documents/ContentStudio Output`;

      // New structure: JSON files are in .contentstudio/metadata/
      const metadataJsonDir = `${baseDir}/.contentstudio/metadata`;

      // Check if new structure exists
      let result: any = null;
      try {
        result = await this.electron.readDirectory(metadataJsonDir);
      } catch (e) {
        console.warn('No metadata directory found at', metadataJsonDir);
      }

      if (!result || !result.success) {
        // Fallback to old structure for backward compatibility
        await this.loadReportsLegacy(baseDir);
        return;
      }

      this.reportsDirectory.set(metadataJsonDir);

      if (result.files) {
        const reports: MetadataReport[] = [];

        // Read all JSON files
        for (const file of result.files) {
          if (!file.name.endsWith('.json')) continue;

          try {
            const jsonPath = `${metadataJsonDir}/${file.name}`;
            const content = await this.electron.readFile(jsonPath);
            if (content) {
              const jobData = JSON.parse(content);

              // Get the txt folder path
              const txtFolder = jobData.txt_folder || '';

              reports.push({
                name: jobData.job_id || file.name.replace('.json', ''),
                path: jsonPath,  // Path to JSON file
                date: new Date(jobData.created_at || file.mtime),
                size: file.size || 0,
                promptSet: jobData.prompt_set,
                displayTitle: jobData.job_name,
                txtFolder: txtFolder  // Store txt folder path
              });
            }
          } catch (e) {
            console.warn('Could not read metadata file', file.name, e);
          }
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

  private async loadReportsLegacy(baseDir: string) {
    // Legacy structure: Try old metadata folder locations
    const possiblePaths = [
      `${baseDir}/metadata`,
      `${this.getUserHome()}/Documents/ContentStudio Output/metadata`,
      `${this.getUserHome()}/Documents/LaunchPad Output/metadata`
    ];

    let metadataDir = '';
    let result: any = null;

    for (const path of possiblePaths) {
      try {
        const testResult = await this.electron.readDirectory(path);
        if (testResult.success) {
          metadataDir = path;
          result = testResult;
          console.log('Found legacy metadata directory:', path);
          break;
        }
      } catch (e) {
        // Continue to next path
      }
    }

    if (!metadataDir || !result) {
      console.warn('No metadata directory found in any location');
      this.reportsDirectory.set(possiblePaths[0]);
      return;
    }

    this.reportsDirectory.set(metadataDir);

    if (result.success && result.directories) {
      const reports: MetadataReport[] = [];

      for (const dir of result.directories) {
        let displayTitle = dir.name;
        let promptSet: string | undefined;

        try {
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

      reports.sort((a, b) => b.date.getTime() - a.date.getTime());
      this.reports.set(reports);
    }
  }

  async selectReport(report: MetadataReport) {
    try {
      this.isLoading.set(true);
      this.selectedReport.set(report);

      // Read the JSON file (report.path is now the path to the JSON file)
      let content = await this.electron.readFile(report.path);

      if (content) {
        const jobData = JSON.parse(content);

        // For new structure, get the first item's metadata
        // (or we could show all items - for now just show first one)
        if (jobData.items && jobData.items.length > 0) {
          this.metadata.set(jobData.items[0]);
        } else {
          // Legacy structure compatibility
          this.metadata.set(jobData);
        }
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
      // Show the txt folder if available, otherwise the JSON file location
      const pathToShow = report.txtFolder || report.path;
      await this.electron.showInFolder(pathToShow);
    } catch (error) {
      console.error('Error showing in folder:', error);
    }
  }

  async deleteReport(report: MetadataReport, event: Event) {
    event.stopPropagation();

    try {
      // Delete the TXT folder if it exists (do this first)
      if (report.txtFolder) {
        try {
          await this.electron.deleteDirectory(report.txtFolder);
        } catch (e) {
          console.warn('Could not delete txt folder:', report.txtFolder, e);
        }
      }

      // Delete the JSON file
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
