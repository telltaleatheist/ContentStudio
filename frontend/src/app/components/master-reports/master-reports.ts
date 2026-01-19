import { Component, OnInit, signal } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatChipsModule } from '@angular/material/chips';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Router } from '@angular/router';
import { ElectronService } from '../../services/electron';
import { NotificationService } from '../../services/notification';
import { InputsStateService, InputItem } from '../../services/inputs-state';

interface MasterSection {
  startTimestamp: string;
  endTimestamp: string;
  startSeconds: number;
  endSeconds: number;
  title: string;
  description: string;
  startPhrase: string;
  selected?: boolean;
}

interface MasterReport {
  masterVideoPath: string;
  masterVideoName: string;
  totalDuration: string;
  totalDurationSeconds: number;
  analyzedAt: string;
  sectionCount: number;
  sections: MasterSection[];
}

interface ReportItem {
  path: string;
  report: MasterReport;
}

@Component({
  selector: 'app-master-reports',
  standalone: true,
  imports: [
    MatCardModule,
    MatIconModule,
    MatButtonModule,
    MatCheckboxModule,
    MatChipsModule,
    MatProgressSpinnerModule,
    MatTooltipModule
  ],
  templateUrl: './master-reports.html',
  styleUrl: './master-reports.scss'
})
export class MasterReports implements OnInit {
  reports = signal<ReportItem[]>([]);
  selectedReport = signal<ReportItem | null>(null);
  isLoading = signal(false);

  constructor(
    private electron: ElectronService,
    private notificationService: NotificationService,
    private inputsState: InputsStateService,
    private router: Router
  ) {}

  async ngOnInit() {
    await this.loadReports();
  }

  async loadReports() {
    try {
      this.isLoading.set(true);
      const result = await this.electron.listMasterReports();

      if (result.success && result.reports) {
        this.reports.set(result.reports);
      } else {
        this.reports.set([]);
      }
    } catch (error) {
      this.notificationService.error('Load Error', 'Failed to load master reports: ' + (error as Error).message);
    } finally {
      this.isLoading.set(false);
    }
  }

  selectReport(report: ReportItem) {
    // Toggle report selection
    const currentSelected = this.selectedReport();
    if (currentSelected?.path === report.path) {
      this.selectedReport.set(null);
    } else {
      // Initialize section selection state
      report.report.sections.forEach(s => s.selected = false);
      this.selectedReport.set(report);
    }
  }

  toggleSectionSelection(section: MasterSection) {
    section.selected = !section.selected;
    // Trigger change detection by updating the signal
    this.selectedReport.update(r => r ? { ...r } : null);
  }

  toggleSelectAllSections() {
    const report = this.selectedReport();
    if (!report) return;

    const allSelected = this.allSectionsSelected();
    report.report.sections.forEach(s => s.selected = !allSelected);
    this.selectedReport.update(r => r ? { ...r } : null);
  }

  get selectedSections(): MasterSection[] {
    const report = this.selectedReport();
    if (!report) return [];
    return report.report.sections.filter(s => s.selected);
  }

  hasSelectedSections(): boolean {
    return this.selectedSections.length > 0;
  }

  allSectionsSelected(): boolean {
    const report = this.selectedReport();
    if (!report || report.report.sections.length === 0) return false;
    return report.report.sections.every(s => s.selected);
  }

  someSectionsSelected(): boolean {
    const report = this.selectedReport();
    if (!report) return false;
    const selected = report.report.sections.filter(s => s.selected);
    return selected.length > 0 && selected.length < report.report.sections.length;
  }

  addSelectedToInputs() {
    const selected = this.selectedSections;
    if (selected.length === 0) return;

    const report = this.selectedReport();
    if (!report) return;

    // Create input items from selected sections
    // Include title in textContent so the AI knows who/what the subject is
    const inputItems: InputItem[] = selected.map(section => ({
      path: `text-subject-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      displayName: section.title,
      type: 'text-subject',
      icon: 'subject',
      promptSet: this.inputsState.masterPromptSet(),
      selected: false,
      textContent: `${section.title}: ${section.description}`
    }));

    // Add to inputs state
    this.inputsState.inputItems.update(items => [...items, ...inputItems]);

    this.notificationService.success(
      'Added to Inputs',
      `Added ${selected.length} section(s) as text subjects`
    );

    // Navigate to inputs page
    this.router.navigate(['/inputs']);
  }

  async deleteReport(report: ReportItem, event: Event) {
    event.stopPropagation();

    try {
      const result = await this.electron.deleteMasterReport(report.path);
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

  formatDate(dateString: string): string {
    const date = new Date(dateString);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m ${secs}s`;
  }

  getSectionDuration(section: MasterSection): string {
    const duration = section.endSeconds - section.startSeconds;
    return this.formatDuration(duration);
  }
}
