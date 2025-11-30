import { Component, OnInit, OnDestroy, signal } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatListModule } from '@angular/material/list';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatChipsModule } from '@angular/material/chips';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { ElectronService } from '../../services/electron';
import { NotificationService } from '../../services/notification';

interface MetadataReport {
  name: string;
  path: string;
  date: Date;
  size: number;
  promptSet?: string; // The prompt set used for generation
  displayTitle?: string; // The actual title from the metadata
  txtFolder?: string; // Path to the folder containing txt files
  jobId?: string; // The job ID this item belongs to
  itemIndex?: number; // Index of this item within the job (for multiple items)
  txtFilePath?: string; // Path to the specific TXT file for this item
  selected?: boolean; // Selection state for batch operations
}

interface ParsedMetadata {
  titles: string[];
  thumbnail_text: string[];
  description: string;
  tags: string;
  hashtags: string;
  chapters?: Array<{ timestamp: string; title: string; sequence: number }>; // YouTube chapter markers
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
    MatChipsModule,
    MatCheckboxModule
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

  constructor(
    private electron: ElectronService,
    private notificationService: NotificationService
  ) {}

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
              const jobDate = new Date(jobData.created_at || file.mtime);
              const jobId = jobData.job_id || file.name.replace('.json', '');

              // Create a report for EACH item in the job
              if (jobData.items && Array.isArray(jobData.items)) {
                jobData.items.forEach((item: any, index: number) => {
                  // Get the display title from the item
                  const itemTitle = item._title || `Item ${index + 1}`;

                  // Get the corresponding txt file path if available
                  let txtFilePath = '';
                  if (jobData.txt_files && jobData.txt_files[index]) {
                    txtFilePath = jobData.txt_files[index];
                  }

                  reports.push({
                    name: `${jobId}-item-${index}`,
                    path: jsonPath,  // Path to JSON file
                    date: jobDate,
                    size: file.size || 0,
                    promptSet: jobData.prompt_set,
                    displayTitle: itemTitle,
                    txtFolder: txtFolder,  // Store txt folder path
                    jobId: jobId,
                    itemIndex: index,
                    txtFilePath: txtFilePath
                  });
                });
              } else {
                // Fallback for jobs without items array (shouldn't happen with new structure)
                reports.push({
                  name: jobId,
                  path: jsonPath,
                  date: jobDate,
                  size: file.size || 0,
                  promptSet: jobData.prompt_set,
                  displayTitle: jobData.job_name,
                  txtFolder: txtFolder,
                  jobId: jobId
                });
              }
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
      this.notificationService.error('Load Error', 'Failed to load metadata reports: ' + (error as Error).message);
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

        // If we have an itemIndex, load that specific item
        if (report.itemIndex !== undefined && jobData.items && jobData.items.length > report.itemIndex) {
          this.metadata.set(jobData.items[report.itemIndex]);
        } else if (jobData.items && jobData.items.length > 0) {
          // Fallback to first item if no index specified
          this.metadata.set(jobData.items[0]);
        } else {
          // Legacy structure compatibility
          this.metadata.set(jobData);
        }
      }
    } catch (error) {
      this.notificationService.error('Read Error', 'Failed to read report: ' + (error as Error).message);
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
      // Show the specific txt file if available, otherwise the txt folder, otherwise the JSON file location
      const pathToShow = report.txtFilePath || report.txtFolder || report.path;
      await this.electron.showInFolder(pathToShow);
    } catch (error) {
      this.notificationService.error('Show Error', 'Failed to show in folder: ' + (error as Error).message);
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
      this.notificationService.error('Delete Error', 'Failed to delete report: ' + (error as Error).message);
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
      this.notificationService.success('Copied', 'Text copied to clipboard', false);
    }).catch(err => {
      this.notificationService.error('Copy Failed', 'Failed to copy to clipboard: ' + err.message);
    });
  }

  copyChaptersToClipboard() {
    const meta = this.metadata();
    if (!meta || !meta.chapters) return;

    const chaptersText = meta.chapters
      .map((chapter: any) => `${chapter.timestamp} - ${chapter.title}`)
      .join('\n');

    navigator.clipboard.writeText(chaptersText).then(() => {
      this.notificationService.success('Copied', 'All chapters copied to clipboard', false);
    }).catch(err => {
      this.notificationService.error('Copy Failed', 'Failed to copy chapters: ' + err.message);
    });
  }

  getDescriptionWithHashtags(): string {
    const meta = this.metadata();
    if (!meta) return '';

    let result = '';

    // Add chapters at the VERY TOP if present (YouTube requirement)
    if (meta.chapters && meta.chapters.length > 0) {
      const chaptersText = meta.chapters
        .map((chapter: any) => `${chapter.timestamp} ${chapter.title}`)
        .join('\n');
      result = chaptersText + '\n\n';
    }

    // Add the main description
    result += meta.description || '';

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

  toggleSelection(report: MetadataReport, event: Event) {
    event.stopPropagation();
    report.selected = !report.selected;
    this.reports.set([...this.reports()]);
  }

  toggleSelectAll() {
    const allSelected = this.reports().every(r => r.selected);
    this.reports().forEach(r => r.selected = !allSelected);
    this.reports.set([...this.reports()]);
  }

  getSelectedReports(): MetadataReport[] {
    return this.reports().filter(r => r.selected);
  }

  hasSelectedReports(): boolean {
    return this.reports().some(r => r.selected);
  }

  allReportsSelected(): boolean {
    return this.reports().length > 0 && this.reports().every(r => r.selected);
  }

  async exportSelectedAsTxt() {
    const selected = this.getSelectedReports();

    if (selected.length === 0) {
      this.notificationService.warning('No Selection', 'Please select at least one report to export');
      return;
    }

    try {
      // Ask user to select export directory
      const result = await this.electron.selectOutputDirectory();

      if (!result.success || !result.directory) {
        return; // User cancelled
      }

      const exportDir = result.directory;
      let successCount = 0;
      let errorCount = 0;

      for (const report of selected) {
        try {
          // Read the metadata
          const content = await this.electron.readFile(report.path);
          if (!content) continue;

          const jobData = JSON.parse(content);
          let metadata: ParsedMetadata;

          // Get the specific item's metadata
          if (report.itemIndex !== undefined && jobData.items && jobData.items.length > report.itemIndex) {
            metadata = jobData.items[report.itemIndex];
          } else if (jobData.items && jobData.items.length > 0) {
            metadata = jobData.items[0];
          } else {
            metadata = jobData;
          }

          // Format the metadata as text
          const txtContent = this.formatMetadataAsTxt(metadata, report);

          // Create safe filename
          const safeName = (report.displayTitle || report.name)
            .replace(/[^a-zA-Z0-9-_]/g, '_')
            .substring(0, 100);
          const fileName = `${safeName}_metadata.txt`;

          // Export the file
          await this.electron.writeTextFile(`${exportDir}/${fileName}`, txtContent);
          successCount++;
        } catch (error) {
          console.error('Error exporting report:', report.name, error);
          errorCount++;
        }
      }

      if (successCount > 0) {
        this.notificationService.success(
          'Export Complete',
          `Exported ${successCount} file(s) to ${exportDir}`
        );
      }

      if (errorCount > 0) {
        this.notificationService.warning(
          'Export Partial',
          `${errorCount} file(s) failed to export`
        );
      }

      // Deselect all after export
      this.reports().forEach(r => r.selected = false);
      this.reports.set([...this.reports()]);

    } catch (error) {
      this.notificationService.error('Export Failed', 'Failed to export files: ' + (error as Error).message);
    }
  }

  private formatMetadataAsTxt(metadata: ParsedMetadata, report: MetadataReport): string {
    let output = '';

    // Header
    output += '='.repeat(80) + '\n';
    output += `METADATA EXPORT\n`;
    output += `Title: ${metadata._title || report.displayTitle || report.name}\n`;
    output += `Prompt Set: ${metadata._prompt_set || report.promptSet || 'N/A'}\n`;
    output += `Generated: ${report.date.toLocaleString()}\n`;
    output += '='.repeat(80) + '\n\n';

    // Titles
    if (metadata.titles && metadata.titles.length > 0) {
      output += '--- TITLES ---\n\n';
      metadata.titles.forEach((title, i) => {
        output += `${i + 1}. ${title}\n`;
      });
      output += '\n';
    }

    // Thumbnail Text
    if (metadata.thumbnail_text && metadata.thumbnail_text.length > 0) {
      output += '--- THUMBNAIL TEXT ---\n\n';
      metadata.thumbnail_text.forEach((text, i) => {
        output += `${i + 1}. ${text}\n`;
      });
      output += '\n';
    }

    // Description
    if (metadata.description) {
      output += '--- DESCRIPTION ---\n\n';
      output += metadata.description + '\n\n';

      if (metadata.hashtags && !metadata.description.includes(metadata.hashtags)) {
        output += metadata.hashtags + '\n\n';
      }
    }

    // Tags
    if (metadata.tags) {
      output += '--- TAGS ---\n\n';
      output += metadata.tags + '\n\n';
    }

    // Hashtags (if not already included)
    if (metadata.hashtags && !metadata.description?.includes(metadata.hashtags)) {
      output += '--- HASHTAGS ---\n\n';
      output += metadata.hashtags + '\n\n';
    }

    output += '='.repeat(80) + '\n';
    output += 'End of metadata export\n';

    return output;
  }
}
