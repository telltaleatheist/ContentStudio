import { Component, signal, OnInit } from '@angular/core';
import { Router, RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatListModule } from '@angular/material/list';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { NotificationBellComponent } from './components/notification-bell/notification-bell';
import { YouTubeProfileComponent } from './components/youtube-profile/youtube-profile';
import { NotificationModalComponent } from './components/notification-modal/notification-modal';
import { ElectronService } from './services/electron';
import { EnvironmentSetupService } from './services/environment-setup';
import { EnvironmentSetupDialog } from './components/environment-setup-dialog/environment-setup-dialog';
import { EnvironmentDownloadDock } from './components/environment-download-dock/environment-download-dock';
import { ModelRoutingDialog, ModelRoutingDialogResult } from './components/model-routing-dialog/model-routing-dialog';
import { NotificationService } from './services/notification';
import { InputsStateService } from './services/inputs-state';
import type { TitleHandoff } from './components/editor/editor-host';

// Console log buffer
const consoleLogBuffer: Array<{ timestamp: string; level: string; message: string }> = [];
const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
  debug: console.debug
};

// Intercept console methods
(['log', 'info', 'warn', 'error', 'debug'] as const).forEach(level => {
  (console as any)[level] = (...args: any[]) => {
    const timestamp = new Date().toISOString();
    const message = args.map(arg =>
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');

    consoleLogBuffer.push({ timestamp, level, message });

    // Keep only last 1000 logs to avoid memory issues
    if (consoleLogBuffer.length > 1000) {
      consoleLogBuffer.shift();
    }

    // Call original console method
    (originalConsole as any)[level](...args);
  };
});

/**
 * How this window knows it is the EDITOR window rather than the main one.
 *
 * Two forms, because the editor window is loaded two different ways: dev loads
 * `http://localhost:4200/editor` (a path), and the packaged build loads the same index.html
 * as the main window with `?view=editor` appended (a query), since `loadFile` cannot express
 * a route. Both mean the same thing; neither can be inferred from the other.
 */
function detectEditorWindow(): boolean {
  return location.pathname.includes('/editor') || location.search.includes('view=editor');
}

@Component({
  selector: 'app-root',
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    MatToolbarModule,
    MatSidenavModule,
    MatListModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    MatDialogModule,
    NotificationBellComponent,
    YouTubeProfileComponent,
    NotificationModalComponent,
    EnvironmentSetupDialog,
    EnvironmentDownloadDock
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements OnInit {
  protected readonly title = signal('LaunchPad');
  protected readonly isDarkMode = signal(true);
  protected readonly sidenavOpened = signal(true);

  /**
   * True in the editor's BrowserWindow. That window renders a bare router-outlet: no toolbar,
   * no sidenav, no notification dock. EditorComponent is `position: fixed; inset: 0` and owns
   * the whole viewport, so any chrome behind it would only be an unreachable strip.
   */
  protected readonly isEditorWindow = signal(detectEditorWindow());

  constructor(
    private electron: ElectronService,
    private environmentSetup: EnvironmentSetupService,
    private dialog: MatDialog,
    private notificationService: NotificationService,
    private inputsState: InputsStateService,
    private router: Router
  ) {
    // Set dark theme as default on init
    document.body.setAttribute('data-theme', 'dark');
  }

  async ngOnInit() {
    if (this.isEditorWindow()) {
      // Packaged, the URL is index.html?view=editor and the router lands on '' → /inputs.
      // Push it to the editor route. In dev the path is already /editor and this is a no-op.
      if (!this.router.url.startsWith('/editor')) {
        await this.router.navigateByUrl('/editor');
      }
      // Nothing below belongs to this window: the readiness check drives the main window's
      // setup dialog, and the titles queue lives in the main window's Inputs tab.
      return;
    }

    try {
      await this.environmentSetup.initialize();
    } catch (error) {
      console.error('Startup readiness check failed:', error);
    }

    this.startTitlesIntake();
    this.reportWithheldPromptAssets();
  }

  /**
   * This build ships newer versions of some prompt sets, and the copies in userData have
   * local edits, so they were left alone. Nothing is merged and nothing is overwritten —
   * the only correct move is to tell the user which files are behind, because the failure
   * this replaces was exactly that: a new field shipped in the asset and never arrived.
   */
  private reportWithheldPromptAssets(): void {
    this.electron.takePendingPromptAssetNotice()
      .then((notice) => {
        if (!notice?.withheld?.length) return;

        this.notificationService.warning(
          'Prompt updates not applied',
          `This version of ContentStudio ships newer prompt sets, but your edited copies ` +
          `were left untouched: ${notice.withheld.join(', ')}. Reconcile them from the ` +
          `Prompts tab to pick up the shipped changes.`
        );
        console.warn('[App] Bundled prompt updates withheld over local edits:', notice.withheld);
      })
      .catch((error: any) => {
        this.notificationService.error(
          'Prompt updates',
          `Could not read the startup report on bundled prompt updates: ${error?.message || String(error)}`
        );
      });
  }

  /** Open (or focus) the editor's own window. The nav entry is a button, not a routerLink —
   *  the editor is a second window, not a tab in this one. */
  async openEditor() {
    try {
      const result = await this.electron.openEditor();
      if (!result.success) {
        this.notificationService.error('Editor', result.error || 'The editor window could not be opened.');
      }
    } catch (error: any) {
      this.notificationService.error('Editor', `The editor window could not be opened: ${error?.message || String(error)}`);
    }
  }

  // ── Titles handoff intake (main window only) ────────────────────────────────
  //
  // The editor pushes one handoff per picked story. Delivery is push+pull: whatever landed
  // while this window was not listening is parked in the main process and drained once here;
  // anything sent afterwards arrives on the subscription. Each handoff becomes exactly one
  // item in the Inputs queue.

  private startTitlesIntake(): void {
    // isElectron() is the port's own environment probe, not a fallback: outside Electron
    // there is no editor window to hand anything over, so there is nothing to drain.
    if (!this.electron.isElectron()) return;

    this.electron.onTitlesSubjects((handoffs) => this.ingestHandoffs(handoffs));

    this.electron.takePendingTitleSubjects()
      .then((handoffs) => this.ingestHandoffs(handoffs))
      .catch((error: any) => {
        this.notificationService.error(
          'Editor handoff',
          `Could not read the subjects the editor sent over: ${error?.message || String(error)}`
        );
      });
  }

  private ingestHandoffs(handoffs: TitleHandoff[]): void {
    if (!handoffs?.length) return;

    let added = 0;
    for (const handoff of handoffs) {
      if (this.ingestOneHandoff(handoff)) added++;
    }

    if (added) {
      this.notificationService.success(
        'Editor handoff',
        added === 1 ? 'One story added to the Inputs queue.' : `${added} stories added to the Inputs queue.`
      );
    }
  }

  /** @returns true when the handoff became a queue item. */
  private ingestOneHandoff(handoff: TitleHandoff): boolean {
    const source = handoff.source?.trim() || '';
    const label = source ? `“${source}”` : 'A story from the editor';

    // FAIL LOUDLY on livestream. ContentStudio's metadata pipeline has exactly one format and
    // hardcodes it (`format: normal` in electron/services/metadata/metadata-tasks.ts) because
    // nothing upstream distinguishes the two. Accepting a livestream handoff would generate it
    // against the normal-format prompt and there would be no symptom anywhere — so it is
    // refused by name instead. Wire a format flag through the pipeline to lift this.
    if (handoff.format === 'livestream') {
      this.notificationService.error(
        'Editor handoff rejected',
        `${label} was sent as a LIVESTREAM, and ContentStudio's metadata pipeline has no ` +
        `livestream format — every generation is run as 'normal'. Nothing was added to the ` +
        `queue rather than have it silently titled as a normal video.`
      );
      console.error('[App] Rejected livestream handoff — no livestream format exists in the metadata pipeline:', handoff);
      return false;
    }

    const subjects = (handoff.subjects || []).map(s => String(s ?? '').trim()).filter(s => s.length > 0);
    if (!subjects.length) {
      this.notificationService.error(
        'Editor handoff rejected',
        `${label} arrived with no subjects, so there is nothing to title.`
      );
      return false;
    }

    // The subject list IS the item's content, one subject per line — the same shape the
    // Add-text-subject dialog produces, and the only thing the titling model is shown.
    const content = subjects.join('\n');

    // Chapters ride along for a saved report. ContentStudio has no such slot: `notes` is
    // wired to the AI as "Additional context" (input-handler.service.ts), and
    // `masterReportData` is a fixed three-field shape nothing reads. Putting timestamps in
    // either would break the editor's own contract that the titling model never sees one, so
    // they are dropped — said out loud rather than dropped quietly.
    if (handoff.chapters?.length) {
      console.warn(
        `[App] Dropped ${handoff.chapters.length} chapter marker(s) from ${label}: ContentStudio ` +
        `has no saved-report slot on a queue item, and every field that IS carried reaches the ` +
        `model. Chapters are never model input.`
      );
    }

    const displayName = source || (content.length > 50 ? content.substring(0, 50) + '...' : content);

    this.inputsState.addItem({
      type: 'subject',
      path: content,
      displayName,
      icon: 'text_fields',
      selected: true,
      promptSet: this.inputsState.masterPromptSet(),
      textContent: content
    });
    return true;
  }

  toggleTheme() {
    this.isDarkMode.update(dark => !dark);
    document.body.setAttribute('data-theme', this.isDarkMode() ? 'dark' : 'light');
  }

  // Per-task model routing. The dialog loads fresh state on every open and persists
  // it itself; it closes with `true` only after setMetadataRouting resolved.
  openModelRouting() {
    const dialogRef = this.dialog.open(ModelRoutingDialog, {
      width: '640px',
      autoFocus: 'dialog'
    });

    dialogRef.afterClosed().subscribe((saved: ModelRoutingDialogResult) => {
      if (saved) {
        this.notificationService.success('Model routing', 'Model routing saved');
      }
    });
  }

  toggleSidenav() {
    this.sidenavOpened.update(opened => !opened);
  }

  async exportLogs() {
    try {
      // Format frontend logs
      const frontendLogs = consoleLogBuffer.map(entry =>
        `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}`
      ).join('\n');

      // Send to Electron to save
      const result = await this.electron.saveLogs(frontendLogs);

      if (result.success) {
        alert(`Logs saved successfully!\n\nFrontend: ${result.frontendPath}\nBackend: ${result.backendPath}`);
      } else {
        alert(`Failed to save logs: ${result.error}`);
      }
    } catch (error) {
      console.error('Error exporting logs:', error);
      alert('Failed to export logs');
    }
  }
}
