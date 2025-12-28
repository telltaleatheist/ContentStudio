import { Component, OnInit, OnDestroy, signal, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonComponent } from '../../components/button/button.component';
import { CascadeComponent } from '../../components/cascade/cascade.component';
import { ElectronService } from '../../services/electron.service';
import { NotificationService } from '../../services/notification.service';
import { CascadeGroup, CascadeItem, ContextMenuAction } from '../../models/file.model';

interface MetadataReport {
  name: string;
  path: string;
  date: Date;
  size: number;
  promptSet?: string;
  displayTitle?: string;
  txtFolder?: string;
  jobId?: string;
  itemIndex?: number;
  txtFilePath?: string;
  selected?: boolean;
}

interface ParsedMetadata {
  titles: string[];
  thumbnail_text: string[];
  description: string;
  tags: string | string[];
  hashtags: string;
  pinned_comment?: string[];
  chapters?: Array<{ timestamp: string; title: string; sequence: number }>;
  _title?: string;
  _prompt_set?: string;
}

@Component({
  selector: 'app-metadata-reports',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonComponent, CascadeComponent],
  templateUrl: './metadata-reports.component.html',
  styleUrls: ['./metadata-reports.component.scss']
})
export class MetadataReportsComponent implements OnInit, OnDestroy {
  private electron = inject(ElectronService);
  private notificationService = inject(NotificationService);

  reports = signal<MetadataReport[]>([]);
  selectedReport = signal<MetadataReport | null>(null);
  metadata = signal<ParsedMetadata | null>(null);
  isLoading = signal(false);
  reportsDirectory = signal('');
  private selectedCascadeIds = signal<Set<string>>(new Set());

  // Track which item was just copied for visual feedback
  copiedItemKey = signal<string | null>(null);

  private visibilityChangeHandler: (() => void) | null = null;

  // Context menu actions for cascade
  contextMenuActions: ContextMenuAction[] = [
    { label: 'Export as TXT', icon: '📄', action: 'export' },
    { label: 'Show in Folder', icon: '📂', action: 'open' },
    { label: '', icon: '', action: '', divider: true },
    { label: 'Delete', icon: '🗑️', action: 'delete' }
  ];

  // Convert reports to cascade groups (grouped by date)
  cascadeGroups = computed<CascadeGroup[]>(() => {
    const reportsList = this.reports();
    if (reportsList.length === 0) return [];

    // Group by date (today, yesterday, this week, older)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);

    const groups: { [key: string]: MetadataReport[] } = {
      'Today': [],
      'Yesterday': [],
      'This Week': [],
      'Older': []
    };

    for (const report of reportsList) {
      const reportDate = new Date(report.date);
      reportDate.setHours(0, 0, 0, 0);

      if (reportDate.getTime() === today.getTime()) {
        groups['Today'].push(report);
      } else if (reportDate.getTime() === yesterday.getTime()) {
        groups['Yesterday'].push(report);
      } else if (reportDate > weekAgo) {
        groups['This Week'].push(report);
      } else {
        groups['Older'].push(report);
      }
    }

    // Convert to CascadeGroup format
    const cascadeGroups: CascadeGroup[] = [];
    for (const [label, items] of Object.entries(groups)) {
      if (items.length > 0) {
        cascadeGroups.push({
          label,
          items: items.map(report => ({
            id: report.name,
            name: report.displayTitle || report.name,
            subtitle: this.formatDate(report.date) + (report.promptSet ? ` • ${report.promptSet}` : ''),
            icon: '📄',
            status: 'complete' as const
          })),
          expanded: true
        });
      }
    }

    return cascadeGroups;
  });

  async ngOnInit() {
    await this.loadReports();

    this.visibilityChangeHandler = () => {
      if (!document.hidden) {
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

  onCascadeSelectionChanged(event: { count: number; ids: Set<string> }) {
    this.selectedCascadeIds.set(event.ids);

    // Extract actual item IDs from composite IDs (format: "groupLabel|itemId")
    const extractItemId = (compositeId: string) => {
      const parts = compositeId.split('|');
      return parts.length > 1 ? parts.slice(1).join('|') : compositeId;
    };

    const itemIds = new Set(Array.from(event.ids).map(extractItemId));

    // Update report selection state
    const reports = this.reports();
    const updatedReports = reports.map(r => ({
      ...r,
      selected: itemIds.has(r.name)
    }));
    this.reports.set(updatedReports);

    // If single selection, load that report
    if (event.ids.size === 1) {
      const selectedId = extractItemId(Array.from(event.ids)[0]);
      const report = reports.find(r => r.name === selectedId);
      if (report) {
        this.selectReport(report);
      }
    }
  }

  onReportDoubleClick(item: CascadeItem) {
    const report = this.reports().find(r => r.name === item.id);
    if (report) {
      this.showInFolder(report);
    }
  }

  onCascadeAction(event: { action: string; items: CascadeItem[] }) {
    const reports = event.items
      .map(item => this.reports().find(r => r.name === item.id))
      .filter((r): r is MetadataReport => r !== undefined);

    if (reports.length === 0) return;

    switch (event.action) {
      case 'export':
        this.exportReports(reports);
        break;
      case 'open':
        this.showInFolder(reports[0]);
        break;
      case 'delete':
        this.deleteReports(reports);
        break;
    }
  }

  async exportReports(reports: MetadataReport[]) {
    if (reports.length === 0) return;

    try {
      const result = await this.electron.selectOutputDirectory();
      if (!result.success || !result.directory) return;

      const exportDir = result.directory;
      let successCount = 0;

      for (const report of reports) {
        try {
          const content = await this.electron.readFile(report.path);
          if (!content) continue;

          const jobData = JSON.parse(content);
          if (report.itemIndex === undefined || !jobData.items || jobData.items.length <= report.itemIndex) continue;

          const metadata: ParsedMetadata = jobData.items[report.itemIndex];
          const txtContent = this.formatMetadataAsTxt(metadata, report);

          const safeName = (report.displayTitle || report.name)
            .replace(/[^a-zA-Z0-9-_]/g, '_')
            .substring(0, 100);
          const fileName = `${safeName}_metadata.txt`;

          await this.electron.writeTextFile(`${exportDir}/${fileName}`, txtContent);
          successCount++;
        } catch (error) {
          console.error('Export error:', error);
        }
      }

      if (successCount > 0) {
        this.notificationService.success('Exported', `Exported ${successCount} file(s)`);
      }
    } catch (error) {
      this.notificationService.error('Export Failed', 'Failed to export files');
    }
  }

  async deleteReports(reports: MetadataReport[]) {
    if (reports.length === 0) return;

    // Group reports by jobId to avoid deleting the same job multiple times
    const jobIds = new Set<string>();
    for (const report of reports) {
      if (report.jobId) {
        jobIds.add(report.jobId);
      }
    }

    if (jobIds.size === 0) {
      this.notificationService.error('Delete Failed', 'No valid job IDs found');
      return;
    }

    try {
      let successCount = 0;
      let errorCount = 0;

      for (const jobId of jobIds) {
        try {
          const result = await this.electron.deleteJobHistory(jobId);
          if (result.success) {
            successCount++;
          } else {
            errorCount++;
          }
        } catch (error) {
          errorCount++;
        }
      }

      // Clear selection if we deleted the selected report
      const selectedReport = this.selectedReport();
      if (selectedReport && reports.some(r => r.name === selectedReport.name)) {
        this.selectedReport.set(null);
        this.metadata.set(null);
      }

      // Reload reports
      await this.loadReports();

      if (successCount > 0) {
        this.notificationService.success('Deleted', `Deleted ${successCount} job(s)`);
      }
      if (errorCount > 0) {
        this.notificationService.warning('Partial Delete', `${errorCount} job(s) failed to delete`);
      }
    } catch (error) {
      this.notificationService.error('Delete Failed', 'Failed to delete reports');
    }
  }

  async loadReports() {
    try {
      this.isLoading.set(true);

      const settings = await this.electron.getSettings();
      const baseDir = settings.outputDirectory || `${this.getUserHome()}/Documents/ContentStudio Output`;
      const metadataJsonDir = `${baseDir}/.contentstudio/metadata`;

      let result: any = null;
      try {
        result = await this.electron.readDirectory(metadataJsonDir);
      } catch (e) {
        console.warn('No metadata directory found at', metadataJsonDir);
      }

      if (!result || !result.success) {
        await this.loadReportsLegacy(baseDir);
        return;
      }

      this.reportsDirectory.set(metadataJsonDir);

      if (result.files) {
        const reports: MetadataReport[] = [];

        for (const file of result.files) {
          if (!file.name.endsWith('.json')) continue;

          try {
            const jsonPath = `${metadataJsonDir}/${file.name}`;
            const content = await this.electron.readFile(jsonPath);
            if (content) {
              const jobData = JSON.parse(content);
              const txtFolder = jobData.txt_folder || '';
              const jobDate = new Date(jobData.created_at || file.mtime);
              const jobId = jobData.job_id || file.name.replace('.json', '');

              if (jobData.items && Array.isArray(jobData.items)) {
                jobData.items.forEach((item: any, index: number) => {
                  const itemTitle = item._title || `Item ${index + 1}`;
                  let txtFilePath = '';
                  if (jobData.txt_files && jobData.txt_files[index]) {
                    txtFilePath = jobData.txt_files[index];
                  }

                  reports.push({
                    name: `${jobId}-item-${index}`,
                    path: jsonPath,
                    date: jobDate,
                    size: file.size || 0,
                    promptSet: jobData.prompt_set,
                    displayTitle: itemTitle,
                    txtFolder: txtFolder,
                    jobId: jobId,
                    itemIndex: index,
                    txtFilePath: txtFilePath
                  });
                });
              } else {
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
          break;
        }
      } catch (e) {
        // Continue
      }
    }

    if (!metadataDir || !result) {
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
                if (parsed._title) displayTitle = parsed._title;
                if (parsed._prompt_set) promptSet = parsed._prompt_set;
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

      let content = await this.electron.readFile(report.path);
      if (!content) throw new Error('Empty file content');

      const jobData = JSON.parse(content);

      if (report.itemIndex === undefined) {
        throw new Error('Report missing itemIndex');
      }

      if (!jobData.items || !Array.isArray(jobData.items)) {
        throw new Error('Job data missing items array');
      }

      if (jobData.items.length <= report.itemIndex) {
        throw new Error(`Item index ${report.itemIndex} out of bounds`);
      }

      const selectedItem = jobData.items[report.itemIndex];
      this.metadata.set(selectedItem);
    } catch (error) {
      this.notificationService.error('Read Error', 'Failed to read report: ' + (error as Error).message);
      this.metadata.set(null);
    } finally {
      this.isLoading.set(false);
    }
  }

  async showInFolder(report: MetadataReport) {
    try {
      const pathToShow = report.txtFilePath || report.txtFolder || report.path;
      await this.electron.showInFolder(pathToShow);
    } catch (error) {
      this.notificationService.error('Show Error', 'Failed to show in folder: ' + (error as Error).message);
    }
  }

  formatDate(date: Date): string {
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  copyToClipboard(text: string, itemKey?: string) {
    navigator.clipboard.writeText(text).then(() => {
      // Visual feedback - briefly highlight the copied item
      if (itemKey) {
        this.copiedItemKey.set(itemKey);
        setTimeout(() => {
          if (this.copiedItemKey() === itemKey) {
            this.copiedItemKey.set(null);
          }
        }, 1500);
      }
      this.notificationService.success('Copied', 'Text copied to clipboard', false);
    }).catch(err => {
      this.notificationService.error('Copy Failed', 'Failed to copy to clipboard: ' + err.message);
    });
  }

  copyChaptersToClipboard() {
    const meta = this.metadata();
    if (!meta || !meta.chapters) return;

    const chaptersText = meta.chapters
      .map((chapter: any) => `${this.getChapterTimestamp(chapter)} ${this.getChapterTitle(chapter)}`)
      .join('\n');

    this.copyToClipboard(chaptersText, 'chapters-all');
  }

  getDescriptionWithHashtags(): string {
    const meta = this.metadata();
    if (!meta) return '';

    let result = '';

    if (meta.chapters && meta.chapters.length > 0) {
      const chaptersText = meta.chapters
        .map((chapter: any) => `${this.getChapterTimestamp(chapter)} ${this.getChapterTitle(chapter)}`)
        .join('\n');
      result = chaptersText + '\n\n';
    }

    result += this.getDescriptionText(meta.description);

    if (meta.hashtags && result.includes(meta.hashtags)) {
      return result;
    }

    const linksMarkers = ['Support the Channel', 'Become a YouTube Member'];
    let insertPosition = -1;

    for (const marker of linksMarkers) {
      const pos = result.indexOf(marker);
      if (pos !== -1) {
        insertPosition = pos;
        break;
      }
    }

    if (insertPosition !== -1 && meta.hashtags) {
      const beforeLinks = result.substring(0, insertPosition).trimEnd();
      const linksSection = result.substring(insertPosition);
      result = beforeLinks + '\n\n' + meta.hashtags + '\n\n' + linksSection;
    } else if (meta.hashtags) {
      result = result.trimEnd() + '\n\n' + meta.hashtags;
    }

    return result;
  }

  getTagsArray(): string[] {
    const meta = this.metadata();
    if (!meta || !meta.tags) return [];

    if (Array.isArray(meta.tags)) return meta.tags;
    if (typeof meta.tags === 'string') {
      return meta.tags.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0);
    }
    return [];
  }

  getTagsString(): string {
    return this.getTagsArray().join(', ');
  }

  getTitleText(title: any): string {
    if (typeof title === 'string') return title;
    if (title && typeof title === 'object' && title.text) return title.text;
    return String(title);
  }

  getDescriptionText(description: any): string {
    if (typeof description === 'string') return description;
    if (description && typeof description === 'object') {
      if (description.text) return description.text;
      if (description.content) return description.content;
      if (description.description) return description.description;
    }
    return String(description || '');
  }

  getThumbnailText(thumbnail: any): string {
    if (typeof thumbnail === 'string') return thumbnail;
    if (thumbnail && typeof thumbnail === 'object' && thumbnail.text) return thumbnail.text;
    return String(thumbnail);
  }

  getChapterTimestamp(chapter: any): string {
    if (typeof chapter === 'string') {
      const match = chapter.match(/^(\d+:\d+)/);
      return match ? match[1] : '0:00';
    }
    if (chapter && typeof chapter === 'object') {
      if (chapter.timestamp) return String(chapter.timestamp);
      if (chapter.time) return String(chapter.time);
    }
    return '0:00';
  }

  getChapterTitle(chapter: any): string {
    if (typeof chapter === 'string') {
      const match = chapter.match(/^\d+:\d+\s*[-–]\s*(.+)$/);
      return match ? match[1] : chapter;
    }
    if (chapter && typeof chapter === 'object') {
      if (chapter.title) return String(chapter.title);
      if (chapter.text) return String(chapter.text);
      if (chapter.name) return String(chapter.name);
    }
    return String(chapter || 'Untitled');
  }

  private getUserHome(): string {
    return '/Users/telltale';
  }

  hasSelectedReports(): boolean {
    return this.selectedCascadeIds().size > 0;
  }

  getSelectedReports(): MetadataReport[] {
    const compositeIds = this.selectedCascadeIds();
    // Extract actual item IDs from composite IDs (format: "groupLabel|itemId")
    const itemIds = new Set(
      Array.from(compositeIds).map(id => {
        const parts = id.split('|');
        return parts.length > 1 ? parts.slice(1).join('|') : id;
      })
    );
    return this.reports().filter(r => itemIds.has(r.name));
  }

  async exportSelectedAsTxt() {
    const selected = this.getSelectedReports();

    if (selected.length === 0) {
      this.notificationService.warning('No Selection', 'Please select at least one report to export');
      return;
    }

    try {
      const result = await this.electron.selectOutputDirectory();
      if (!result.success || !result.directory) return;

      const exportDir = result.directory;
      let successCount = 0;
      let errorCount = 0;

      for (const report of selected) {
        try {
          const content = await this.electron.readFile(report.path);
          if (!content) {
            errorCount++;
            continue;
          }

          const jobData = JSON.parse(content);

          if (report.itemIndex === undefined || !jobData.items || jobData.items.length <= report.itemIndex) {
            errorCount++;
            continue;
          }

          const metadata: ParsedMetadata = jobData.items[report.itemIndex];
          const txtContent = this.formatMetadataAsTxt(metadata, report);

          const safeName = (report.displayTitle || report.name)
            .replace(/[^a-zA-Z0-9-_]/g, '_')
            .substring(0, 100);
          const fileName = `${safeName}_metadata.txt`;

          await this.electron.writeTextFile(`${exportDir}/${fileName}`, txtContent);
          successCount++;
        } catch (error) {
          errorCount++;
        }
      }

      if (successCount > 0) {
        this.notificationService.success('Export Complete', `Exported ${successCount} file(s)`);
      }

      if (errorCount > 0) {
        this.notificationService.warning('Export Partial', `${errorCount} file(s) failed`);
      }
    } catch (error) {
      this.notificationService.error('Export Failed', 'Failed to export files');
    }
  }

  private formatMetadataAsTxt(metadata: ParsedMetadata, report: MetadataReport): string {
    let output = '';

    output += '='.repeat(80) + '\n';
    output += `METADATA EXPORT\n`;
    output += `Title: ${metadata._title || report.displayTitle || report.name}\n`;
    output += `Prompt Set: ${metadata._prompt_set || report.promptSet || 'N/A'}\n`;
    output += `Generated: ${report.date.toLocaleString()}\n`;
    output += '='.repeat(80) + '\n\n';

    if (metadata.titles && metadata.titles.length > 0) {
      output += '--- TITLES ---\n\n';
      metadata.titles.forEach((title, i) => {
        output += `${i + 1}. ${title}\n`;
      });
      output += '\n';
    }

    if (metadata.thumbnail_text && metadata.thumbnail_text.length > 0) {
      output += '--- THUMBNAIL TEXT ---\n\n';
      metadata.thumbnail_text.forEach((text, i) => {
        output += `${i + 1}. ${text}\n`;
      });
      output += '\n';
    }

    if (metadata.pinned_comment && metadata.pinned_comment.length > 0) {
      output += '--- PINNED COMMENT ---\n\n';
      metadata.pinned_comment.forEach((comment, i) => {
        output += `${i + 1}. ${comment}\n`;
      });
      output += '\n';
    }

    if (metadata.description) {
      output += '--- DESCRIPTION ---\n\n';
      const descText = this.getDescriptionText(metadata.description);
      output += descText + '\n\n';

      if (metadata.hashtags && !descText.includes(metadata.hashtags)) {
        output += metadata.hashtags + '\n\n';
      }
    }

    if (metadata.tags) {
      output += '--- TAGS ---\n\n';
      if (Array.isArray(metadata.tags)) {
        output += metadata.tags.join(', ') + '\n\n';
      } else {
        output += metadata.tags + '\n\n';
      }
    }

    output += '='.repeat(80) + '\n';
    output += 'End of metadata export\n';

    return output;
  }
}
