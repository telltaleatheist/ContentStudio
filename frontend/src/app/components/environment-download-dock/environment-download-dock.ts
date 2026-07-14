import { Component, computed } from '@angular/core';
import { EnvironmentSetupService } from '../../services/environment-setup';

@Component({
  selector: 'environment-download-dock',
  standalone: true,
  templateUrl: './environment-download-dock.html',
  styleUrl: './environment-download-dock.scss',
})
export class EnvironmentDownloadDock {
  items = computed(() => this.setup.downloadItems());
  visible = computed(() => !this.setup.dockDismissed() && this.items().length > 0);
  running = computed(() => this.items().some((item) => item.state === 'queued' || item.state === 'downloading'));
  failed = computed(() => this.items().filter((item) => item.state === 'failed').length);
  requiredRunning = computed(() => this.items().some((item) => item.required && (item.state === 'queued' || item.state === 'downloading')));
  aggregateProgress = computed(() => {
    const items = this.items();
    return items.length ? Math.round(items.reduce((sum, item) => sum + (item.state === 'done' ? 100 : item.pct), 0) / items.length) : 0;
  });
  title = computed(() => {
    if (this.requiredRunning()) return 'Setting up environment';
    if (this.running()) return 'Downloading components';
    return this.failed() ? 'Setup needs attention' : 'Setup complete';
  });

  constructor(public setup: EnvironmentSetupService) {}
}
