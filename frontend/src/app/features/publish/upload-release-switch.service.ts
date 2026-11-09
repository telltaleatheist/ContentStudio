// src/app/features/publish/upload-release-switch.service.ts
//
// The calendar's upload release switch, as the renderer sees it (Owen, 2026-11-09): ONE
// answer, for every video, to how the next uploads go public. "Private until its date —
// YouTube's schedule" or "Unlisted now, public at its date". The upload stamps it onto the
// item in the main process (upload-release-switch.ts, youtube-upload.ts) and the item keeps
// it, so a flip changes the next uploads and never an uploaded one.
//
// Root-scoped so the calendar's toolbar, its confirm panel and the reports page's
// "Goes public" row all read the same value. The main process holds the truth; this is a
// copy refreshed on load and after every flip. A refusal (a bad switch file) is kept as
// `error` and shown, and `mode` stays null: nothing here pretends the switch is set.

import { Injectable, inject, signal } from '@angular/core';
import { ElectronService } from '../../services/electron';
import type { ReleaseMode, UploadReleaseSwitchState } from './publish.types';

@Injectable({ providedIn: 'root' })
export class UploadReleaseSwitchService {
  private readonly electron = inject(ElectronService);

  private readonly _state = signal<UploadReleaseSwitchState | null>(null);
  private readonly _error = signal<string | null>(null);
  private readonly _saving = signal(false);

  /** The switch, or null until it has been read (or when it could not be). */
  readonly state = this._state.asReadonly();
  /** Why the switch could not be read or flipped, verbatim from the main process. */
  readonly error = this._error.asReadonly();
  readonly saving = this._saving.asReadonly();

  /** The current mode, or null when unread or unreadable. */
  mode(): ReleaseMode | null {
    return this._state()?.mode ?? null;
  }

  async load(): Promise<void> {
    const res = await this.electron.publishGetUploadReleaseSwitch();
    if (!res.success || !res.data) {
      this._state.set(null);
      this._error.set(res.error ?? 'The upload switch could not be read and the main process gave no reason.');
      return;
    }
    this._state.set(res.data);
    this._error.set(null);
  }

  async set(mode: ReleaseMode): Promise<void> {
    this._saving.set(true);
    try {
      const res = await this.electron.publishSetUploadReleaseSwitch(mode);
      if (!res.success || !res.data) {
        const refusal = res.error ?? 'The upload switch was not flipped and the main process gave no reason.';
        // Show what is on disk now, not what was asked for, and then the refusal.
        await this.load();
        this._error.set(refusal);
        return;
      }
      this._state.set(res.data);
      this._error.set(null);
    } finally {
      this._saving.set(false);
    }
  }
}
