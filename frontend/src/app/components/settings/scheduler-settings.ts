import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { ElectronService } from '../../services/electron';
import type { SchedulerStatus, SchedulerTestResult } from '../../features/scheduler/scheduler.types';

/**
 * Settings › Visibility scheduler (VISIBILITY-SCHEDULER-PLAN.md, "ContentStudio").
 *
 * The address (read-only: it is the one place the service runs) and the device key, made
 * on the setup page behind Owen's Google login and pasted in once. The key box is ALWAYS
 * EMPTY on load: the stored key is never sent to this window, only whether one exists.
 * Its own Save, like the Spreaker card: the key lives in its own 0600 file
 * (scheduler.json), not in update-settings.
 *
 * "Test" calls /health and /channels and shows what came back, or the scheduler's own words.
 */
@Component({
  selector: 'app-scheduler-settings',
  imports: [FormsModule, MatButtonModule, MatCardModule, MatFormFieldModule, MatIconModule, MatInputModule],
  templateUrl: './scheduler-settings.html',
  styleUrl: './scheduler-settings.scss',
})
export class SchedulerSettings implements OnInit {
  private readonly electron = inject(ElectronService);

  readonly setupUrl = 'https://contentstudio.owenmorgan.com/scheduler/';
  readonly status = signal<SchedulerStatus | null>(null);
  readonly statusError = signal<string | null>(null);
  readonly key = signal('');
  readonly saving = signal(false);
  readonly saveError = signal<string | null>(null);
  readonly saved = signal(false);
  readonly testing = signal(false);
  readonly test = signal<SchedulerTestResult | null>(null);
  readonly testError = signal<string | null>(null);
  readonly openError = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    await this.loadStatus();
  }

  private async loadStatus(): Promise<void> {
    const res = await this.electron.schedulerGetStatus();
    if (!res.success || !res.data) {
      this.statusError.set(res.error ?? 'Could not read the scheduler settings on this machine.');
      return;
    }
    this.statusError.set(null);
    this.status.set(res.data);
  }

  async save(): Promise<void> {
    this.saving.set(true);
    this.saveError.set(null);
    this.saved.set(false);
    try {
      const res = await this.electron.schedulerSaveKey(this.key().trim());
      if (!res.success || !res.data) {
        this.saveError.set(res.error ?? 'The key was not saved, and no reason was given.');
        return;
      }
      this.status.set(res.data);
      this.key.set('');
      this.saved.set(true);
      this.test.set(null);
      this.testError.set(null);
    } finally {
      this.saving.set(false);
    }
  }

  async runTest(): Promise<void> {
    this.testing.set(true);
    this.test.set(null);
    this.testError.set(null);
    try {
      const res = await this.electron.schedulerTest();
      if (!res.success || !res.data) {
        this.testError.set(res.error ?? 'The test failed, and no reason was given.');
        return;
      }
      this.test.set(res.data);
    } finally {
      this.testing.set(false);
    }
  }

  async openSetupPage(): Promise<void> {
    this.openError.set(null);
    const res = await this.electron.openExternal(this.setupUrl);
    if (!res.success) this.openError.set(`The browser could not be opened on ${this.setupUrl}: ${res.error ?? 'no reason was given.'}`);
  }
}
