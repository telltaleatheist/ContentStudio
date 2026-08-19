// src/app/components/editor/environment-modal/environment-modal.component.ts
//
// File ▸ Environment…: what the editor's backend is made of, and whether it is on this machine.
//
// The editor does not carry its toolchain in the bundle. FFmpeg/FFprobe, the Python runtime and
// the Whisper speech model are downloaded once into the shared OwenMorgan location and reused by
// every app there; voice isolation is a fourth, optional component that only gates the Denoise
// toggle. On a machine that has none of them, the editor can SEE what is missing and, without
// this dialog, could do nothing about it — the binary resolver would simply throw the moment a
// project was opened, naming a path that had never been downloaded.
//
// So this is the one place an install is started, and it is always on screen while one runs:
//
//   - Nothing installs silently. A multi-gigabyte download that the user did not ask for and
//     cannot see is indistinguishable from the app being broken.
//   - Every failure is the host's own words, inline. No alert(), no paraphrase — the reason an
//     install failed (a 404 on an unpublished artifact, a checksum mismatch, a full disk) is
//     the only thing that tells the user what to do next.
//   - The install surface is an OPTIONAL group on the port. A host that has no installer gets
//     told so in the dialog rather than a dead Install button.

import {
  ChangeDetectorRef, Component, EventEmitter, Inject, Input, OnDestroy, OnInit, Output
} from '@angular/core';
import {
  AssetComponentStatus, AssetInstallProgress, EDITOR_HOST, EditorHost
} from '../editor-host';

@Component({
  selector: 'app-editor-environment-modal',
  templateUrl: './environment-modal.component.html',
  styleUrls: ['./environment-modal.component.scss'],
  standalone: false
})
export class EnvironmentModalComponent implements OnInit, OnDestroy {
  /**
   * Why the dialog opened, when it opened itself. Set by the editor when a REQUIRED component
   * is missing at startup; null when the user opened it from the File menu, which needs no
   * explanation.
   */
  @Input() banner: string | null = null;

  /**
   * Start installing the required components as soon as the list is on screen. Set with
   * `banner` for the startup case: the editor decided the install has to happen, so it starts
   * visibly here instead of in the background.
   */
  @Input() autoEnsure = false;

  /** Dismissed — the host clears the field it renders this component behind. */
  @Output() closed = new EventEmitter<void>();

  /** The component list, exactly as the host reported it. */
  rows: AssetComponentStatus[] = [];

  /** True until the first listAssets settles, so an empty list never flashes as "nothing here". */
  loading = true;

  /** True while ensure-required is running; the whole list is busy, not one row. */
  ensuring = false;

  /** The last failure, in the host's own words. Cleared when the user acts again. */
  error: string | null = null;

  /** Neutral outcomes — a cancel the user asked for is not an error. */
  status: string | null = null;

  /**
   * Whether this host can install anything at all. The install/cancel/ensure/progress members
   * are an optional GROUP on the port (see editor-host.ts); a host that implements none of them
   * still lists its components, and this dialog says so instead of offering buttons that would
   * throw.
   */
  supported = false;

  /** The latest tick per component id. Presence means "installing", absence means idle. */
  progress: Record<string, AssetInstallProgress> = {};

  /** Ids the user cancelled, so the abort the host reports back is not shown as a failure. */
  private canceled = new Set<string>();

  /**
   * Set once this component is gone. An install keeps running in the main process after the
   * dialog is closed (it belongs to the app, not to this DOM — the same rule the setup modal
   * follows), so its promise can still settle here afterwards; nothing that settles late may
   * touch a destroyed view. Reopening the dialog picks the run back up: the host reports the
   * component as `installing` and the progress listener is re-attached.
   */
  private destroyed = false;

  constructor(
    @Inject(EDITOR_HOST) private host: EditorHost,
    private cdr: ChangeDetectorRef
  ) {}

  async ngOnInit(): Promise<void> {
    this.supported = typeof this.host.installAsset === 'function'
      && typeof this.host.cancelAsset === 'function'
      && typeof this.host.ensureRequiredAssets === 'function'
      && typeof this.host.onAssetProgress === 'function';

    if (this.supported) this.host.onAssetProgress!((p) => this.onProgress(p));

    await this.load();

    // The startup case: the editor already established that something required is missing, so
    // the download starts here, in front of the user, rather than anywhere else.
    if (this.autoEnsure) await this.ensureRequired();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.supported) this.host.removeAssetProgressListener?.();
  }

  // ── The list ────────────────────────────────────────────────────────────────

  /** Re-read the component list. Every action ends here, so the rows are never guessed at. */
  async load(): Promise<void> {
    if (this.destroyed) return;
    this.loading = true;
    try {
      const res = await this.host.listAssets();
      if (res.success) {
        this.rows = res.components || [];
      } else {
        // An empty list and an unreadable one look identical on screen, and they need opposite
        // responses from the user — so the list is emptied and the reason is printed.
        this.rows = [];
        this.error = `Could not read the environment: ${res.error || 'the host gave no reason'}`;
      }
    } catch (err: any) {
      this.rows = [];
      this.error = `Could not read the environment: ${err?.message || String(err)}`;
    } finally {
      this.loading = false;
      this.cdr.detectChanges();
    }
  }

  // ── Installing ──────────────────────────────────────────────────────────────

  /** Install ONE component, from its row's button. */
  async install(row: AssetComponentStatus): Promise<void> {
    if (!this.host.installAsset) {
      this.error = `This window's host cannot install ${row.name}: it does not implement installAsset.`;
      return;
    }
    this.error = null;
    this.status = null;
    this.canceled.delete(row.id);
    this.progress[row.id] = { id: row.id, phase: 'resolve', pct: 0, message: 'Preparing…' };
    this.cdr.detectChanges();

    try {
      const res = await this.host.installAsset(row.id);
      if (!res.ok) {
        const reason = res.error || 'the host gave no reason';
        if (this.canceled.has(row.id)) this.status = `${row.name} was not installed: ${reason}`;
        else this.error = `Could not install ${row.name}: ${reason}`;
      }
    } catch (err: any) {
      this.error = `Could not install ${row.name}: ${err?.message || String(err)}`;
    } finally {
      delete this.progress[row.id];
      this.canceled.delete(row.id);
      await this.load();
    }
  }

  /** Install every required component that is missing, in the host's order. */
  async ensureRequired(): Promise<void> {
    if (!this.host.ensureRequiredAssets) {
      this.error = `This window's host cannot install the required components: `
        + `it does not implement ensureRequiredAssets.`;
      return;
    }
    this.ensuring = true;
    this.error = null;
    this.status = null;
    this.cdr.detectChanges();

    try {
      const res = await this.host.ensureRequiredAssets();
      if (!res.success) {
        this.error = `Could not install the required components: ${res.error || 'the host gave no reason'}`;
      } else if (res.failed && res.failed.length > 0) {
        // ensureRequired reports WHICH ones failed and nothing about why — the per-component
        // reason went to the main process log. Naming them is what lets the user retry one.
        this.error = `These required components did not install: ${res.failed.join(', ')}. `
          + `Install one on its own to see the reason it failed.`;
      } else {
        this.status = 'Every required component is installed.';
      }
    } catch (err: any) {
      this.error = `Could not install the required components: ${err?.message || String(err)}`;
    } finally {
      this.ensuring = false;
      this.progress = {};
      await this.load();
    }
  }

  /** Stop an install in flight. The install call itself reports the abort when it settles. */
  async cancel(row: AssetComponentStatus): Promise<void> {
    if (!this.host.cancelAsset) {
      this.error = `This window's host cannot stop the install of ${row.name}: `
        + `it does not implement cancelAsset.`;
      return;
    }
    this.canceled.add(row.id);
    try {
      await this.host.cancelAsset(row.id);
    } catch (err: any) {
      this.error = `Could not stop the install of ${row.name}: ${err?.message || String(err)}`;
    }
  }

  private onProgress(p: AssetInstallProgress): void {
    if (this.destroyed || !p?.id) return;
    this.progress[p.id] = p;
    // A finished component's bar is dropped by the load() that follows the install call; a tick
    // that arrives after it would otherwise leave a dead bar on an installed row.
    if (p.phase === 'done') delete this.progress[p.id];
    this.cdr.detectChanges();
  }

  // ── What a row is doing ─────────────────────────────────────────────────────

  /** Installing = a live progress entry, or the host itself saying so. */
  isInstalling(row: AssetComponentStatus): boolean {
    return !!this.progress[row.id] || row.state === 'installing';
  }

  isInstalled(row: AssetComponentStatus): boolean {
    return row.state === 'installed';
  }

  /** The one-word state, for the row's right-hand column. */
  stateLabel(row: AssetComponentStatus): string {
    if (this.isInstalling(row)) return this.phaseLabel(this.progress[row.id]?.phase);
    if (row.state === 'installed') return 'Installed';
    if (row.state === 'error') return 'Error';
    if (!row.installable) return 'Not available for this Mac';
    return 'Not installed';
  }

  phaseLabel(phase: string | undefined): string {
    switch (phase) {
      case 'download': return 'Downloading…';
      case 'verify': return 'Verifying…';
      case 'extract': return 'Extracting…';
      case 'postinstall': return 'Finalizing…';
      case 'done': return 'Ready';
      case 'error': return 'Error';
      default: return 'Preparing…';
    }
  }

  /** Bytes as MB, one decimal. The installs are hundreds of MB to a few GB. */
  mb(bytes: number | undefined): string {
    return ((bytes || 0) / 1e6).toFixed(1);
  }

  /** "412.0 / 1180.4 MB" while a download is running, '' before the size is known. */
  bytesLabel(row: AssetComponentStatus): string {
    const p = this.progress[row.id];
    if (!p || p.receivedBytes === undefined) return '';
    if (!p.totalBytes) return `${this.mb(p.receivedBytes)} MB`;
    return `${this.mb(p.receivedBytes)} / ${this.mb(p.totalBytes)} MB`;
  }

  /** Download size from the catalog, for a row that is not installed yet. */
  sizeLabel(row: AssetComponentStatus): string {
    return row.sizeBytes > 0 ? `${this.mb(row.sizeBytes)} MB` : '';
  }

  get missingRequired(): AssetComponentStatus[] {
    return this.rows.filter(r => r.required && r.state !== 'installed');
  }

  // ── Chrome ──────────────────────────────────────────────────────────────────

  onClose(): void {
    this.closed.emit();
  }

  /** A click on the dim area outside the card dismisses, matching the editor's other modals. */
  onBackdropClick(): void {
    this.onClose();
  }
}
