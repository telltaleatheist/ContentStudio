import { Component, signal } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatListModule } from '@angular/material/list';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { NotificationBellComponent } from './components/notification-bell/notification-bell';
import { NotificationModalComponent } from './components/notification-modal/notification-modal';
import { ElectronService } from './services/electron';

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
    NotificationBellComponent,
    NotificationModalComponent
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {
  protected readonly title = signal('LaunchPad');
  protected readonly isDarkMode = signal(true);
  protected readonly sidenavOpened = signal(true);

  constructor(private electron: ElectronService) {
    // Set dark theme as default on init
    document.body.setAttribute('data-theme', 'dark');
  }

  toggleTheme() {
    this.isDarkMode.update(dark => !dark);
    document.body.setAttribute('data-theme', this.isDarkMode() ? 'dark' : 'light');
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