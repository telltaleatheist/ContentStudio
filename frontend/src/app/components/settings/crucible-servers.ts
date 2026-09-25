import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { CrucibleRefusal, CrucibleService } from '../../services/crucible';
import { CrucibleServerKeys } from './crucible-server-keys';
import {
  capabilityLine,
  installHeadline,
  reachIsProblem,
  reachWord,
  readinessDoor,
  readinessHeadline,
  residentLine,
  serverFactsLine,
} from '../../features/crucible/crucible-words';
import type {
  CapabilityFact,
  ConnectCodeReading,
  CrucibleEnginePresence,
  CrucibleInstallProgress,
  CrucibleProbeAnswer,
  CrucibleReadinessView,
  CrucibleReleaseCheck,
  CruciblePairingPrompt,
  CrucibleServerRow,
  CrucibleServersView,
  CrucibleSetupView,
  LocalConnectCodes,
  ServerChoiceRow,
  ServerFacts,
  ServerReach,
} from '../../features/crucible/crucible.types';

type AddMode = 'pair' | 'code';

/** One row as the pane draws it: its place in the choice, and its registry entry. */
type PaneRow = ServerChoiceRow & { server: CrucibleServerRow | undefined };

/**
 * SETTINGS › CRUCIBLE SERVERS (CRUCIBLE-MIGRATION-PLAN.md section 14, P1).
 *
 * Modelled on Briefcase's crucible-pane (itself BookForge's crucible-servers-panel): ONE
 * list, one kind of row, whether the Crucible runs on this computer or across the tailnet.
 * Each row shows its version, backend, reach, what is on its GPU and its masked key, and
 * has Test, Select, Running/Paused, Keys, Copy code and Forget.
 *
 * THE CHOICE IS OWEN'S RULING, NOT BOOKFORGE'S RANK (LEDGER #205, plan section 21 Q14): all
 * work goes to the ONE selected server and waits for it while it is busy or paused; nothing
 * moves to another server on its own. "Fast server" is the one exception, and it is a pin a
 * person sets per queue item (LEDGER #195): the queue (P3) sends a fast-pinned item there
 * and nowhere else. Removing the selected server leaves NONE selected; the pane says so and
 * never picks another.
 *
 * Below the list: adding a server (by address, which pairs with a short code, or by pasting
 * a connect code), this computer's own Crucible (the doors: adopt it, start it, install it,
 * check for a newer one) and the connect codes that hand it to another computer.
 *
 * NOTHING ON THIS PAGE HOLDS A TOKEN. Rows carry a masked one, keys show the server's hint,
 * and every connect code is copied by the main process straight to the clipboard; the page
 * is told what was copied with the key elided.
 */
@Component({
  selector: 'app-crucible-servers',
  imports: [
    FormsModule,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatIconModule,
    MatSelectModule,
    MatSlideToggleModule,
    CrucibleServerKeys,
  ],
  templateUrl: './crucible-servers.html',
  styleUrl: './crucible-servers.scss',
})
export class CrucibleServers implements OnInit {
  private readonly crucible = inject(CrucibleService);
  private readonly destroyRef = inject(DestroyRef);

  // ── the list ───────────────────────────────────────────────────────────
  readonly view = signal<CrucibleServersView | null>(null);
  readonly loadError = signal<string | null>(null);
  readonly probes = signal<Record<string, CrucibleProbeAnswer>>({});
  readonly testing = signal<Record<string, boolean>>({});
  readonly rowError = signal<Record<string, string>>({});
  readonly confirmForget = signal<string | null>(null);
  readonly keysOpen = signal<string | null>(null);
  readonly note = signal<string | null>(null);

  readonly rows = computed<PaneRow[]>(() => {
    const view = this.view();
    if (view === null) return [];
    const byName = new Map(view.servers.map((s) => [s.name, s]));
    return view.routing.servers.map((row) => ({ ...row, server: byName.get(row.name) }));
  });
  /** A selected server the registry no longer has: said, never replaced by another. */
  readonly missing = computed(() => this.view()?.routing.missing ?? null);
  readonly noneSelected = computed(() => {
    const routing = this.view()?.routing;
    return routing !== undefined && routing.servers.length > 0 && routing.selected === null;
  });
  readonly fastServer = computed(() => this.view()?.routing.fastServer ?? null);
  /** The Crucible on this computer when it is here and not in the list yet: the adopt offer. */
  readonly offer = computed(() => {
    const discovered = this.view()?.discovered;
    return discovered?.present === true && discovered.registeredAs === null ? discovered : null;
  });

  // ── readiness ──────────────────────────────────────────────────────────
  readonly readiness = signal<CrucibleReadinessView | null>(null);

  // ── this computer ──────────────────────────────────────────────────────
  readonly setup = signal<CrucibleSetupView | null>(null);
  readonly presence = signal<CrucibleEnginePresence | null>(null);
  readonly installEvents = signal<CrucibleInstallProgress[]>([]);
  readonly installing = signal(false);
  readonly localBusy = signal<'adopt' | 'install' | 'release' | 'start' | null>(null);
  readonly localError = signal<string | null>(null);
  readonly release = signal<CrucibleReleaseCheck | null>(null);
  readonly localCodes = signal<LocalConnectCodes | null>(null);
  readonly localCodesError = signal<string | null>(null);
  readonly installLine = computed(() => installHeadline(this.installEvents()));

  // ── adding a server ────────────────────────────────────────────────────
  readonly addMode = signal<AddMode>('pair');
  pairAddress = '';
  pairName = '';
  readonly pairing = signal<CruciblePairingPrompt | null>(null);
  readonly pairError = signal<string | null>(null);
  readonly pairBusy = signal(false);
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private noteTimer: ReturnType<typeof setTimeout> | null = null;

  connectCode = '';
  codeName = '';
  readonly codePreview = signal<ConnectCodeReading | null>(null);
  readonly codeError = signal<string | null>(null);
  readonly codeBusy = signal(false);

  ngOnInit(): void {
    void this.reload();
    void this.loadSetup();
    void this.crucible.readiness().then((view) => this.readiness.set(view), () => undefined);
    const offServers = this.crucible.onServersChanged(() => {
      void this.reload(false);
      void this.loadSetup();
    });
    const offReadiness = this.crucible.onReadiness((view) => this.readiness.set(view));
    const offInstall = this.crucible.onInstallProgress((event) => {
      this.installEvents.update((all) => [...all, event].slice(-400));
      if (event.kind === 'done' || event.kind === 'failed') {
        this.installing.set(false);
        if (event.kind === 'failed') this.localError.set(event.refusal.message);
        void this.loadSetup();
      }
    });
    this.destroyRef.onDestroy(() => {
      offServers();
      offReadiness();
      offInstall();
      this.stopPolling();
      if (this.noteTimer !== null) clearTimeout(this.noteTimer);
      const pending = this.pairing();
      if (pending !== null) void this.crucible.cancelPairing(pending.requestId).catch(() => undefined);
    });
  }

  // ── words ──────────────────────────────────────────────────────────────

  reachWord(reach: ServerReach): string {
    return reachWord(reach);
  }

  reachIsProblem(reach: ServerReach): boolean {
    return reachIsProblem(reach);
  }

  factsLine(facts: ServerFacts): string {
    return serverFactsLine(facts);
  }

  residentLine(facts: ServerFacts): string {
    return residentLine(facts);
  }

  capabilityLine(fact: CapabilityFact): string {
    return capabilityLine(fact);
  }

  readinessHeadline(view: CrucibleReadinessView): string {
    return readinessHeadline(view);
  }

  readinessDoor(view: CrucibleReadinessView): string | null {
    return readinessDoor(view.action);
  }

  // ── the list ───────────────────────────────────────────────────────────

  /** Read the list, then probe each row (a probe is at most 15 s old; Test asks again). */
  async reload(probeAll = true): Promise<void> {
    try {
      const view = await this.crucible.servers();
      this.loadError.set(null);
      this.view.set(view);
      for (const server of view.servers) {
        if (probeAll || !this.probes()[server.name]) void this.probe(server.name);
      }
    } catch (err) {
      this.loadError.set(this.messageOf(err));
    }
  }

  private async probe(name: string): Promise<void> {
    try {
      const answer = await this.crucible.probe(name);
      this.probes.update((all) => ({ ...all, [name]: answer }));
    } catch (err) {
      this.setRowError(name, this.messageOf(err));
    }
  }

  async test(name: string): Promise<void> {
    this.testing.update((all) => ({ ...all, [name]: true }));
    this.setRowError(name, null);
    try {
      const answer = await this.crucible.test(name);
      this.probes.update((all) => ({ ...all, [name]: answer }));
      void this.crucible.refreshReadiness().then((view) => this.readiness.set(view), () => undefined);
    } catch (err) {
      this.setRowError(name, this.messageOf(err));
    } finally {
      this.testing.update((all) => ({ ...all, [name]: false }));
    }
  }

  async select(row: PaneRow): Promise<void> {
    if (row.selected) return;
    try {
      const routing = await this.crucible.select(row.name);
      this.view.update((view) => (view === null ? view : { ...view, routing }));
    } catch (err) {
      this.setRowError(row.name, this.messageOf(err));
    }
  }

  async setPaused(row: PaneRow, paused: boolean): Promise<void> {
    try {
      const routing = await this.crucible.setPaused(row.name, paused);
      this.view.update((view) => (view === null ? view : { ...view, routing }));
    } catch (err) {
      this.setRowError(row.name, this.messageOf(err));
    }
  }

  async setFast(name: string | null): Promise<void> {
    try {
      const routing = await this.crucible.setFast(name);
      this.view.update((view) => (view === null ? view : { ...view, routing }));
    } catch (err) {
      this.flash(this.messageOf(err));
    }
  }

  toggleKeys(name: string): void {
    this.keysOpen.set(this.keysOpen() === name ? null : name);
  }

  async copyCode(name: string): Promise<void> {
    try {
      const answer = await this.crucible.copyConnectCode(name);
      this.flash(`Copied ${answer.copied} to the clipboard. It carries this server's access key: share it only with your own computers.`);
    } catch (err) {
      this.setRowError(name, this.messageOf(err));
    }
  }

  async forget(name: string): Promise<void> {
    this.confirmForget.set(null);
    try {
      await this.crucible.remove(name);
      this.probes.update((all) => {
        const rest = { ...all };
        delete rest[name];
        return rest;
      });
      if (this.keysOpen() === name) this.keysOpen.set(null);
      await this.reload(false);
    } catch (err) {
      this.setRowError(name, this.messageOf(err));
    }
  }

  // ── readiness doors ────────────────────────────────────────────────────

  async readinessAct(view: CrucibleReadinessView): Promise<void> {
    if (view.action === 'start') await this.startLocal();
    else if (view.action === 'install') await this.install();
  }

  async declineReadiness(): Promise<void> {
    try {
      this.readiness.set(await this.crucible.declineReadiness());
    } catch (err) {
      this.flash(this.messageOf(err));
    }
  }

  async recheck(): Promise<void> {
    await this.reload();
    await this.loadSetup();
    try {
      this.readiness.set(await this.crucible.refreshReadiness());
    } catch (err) {
      this.flash(this.messageOf(err));
    }
  }

  // ── this computer ──────────────────────────────────────────────────────

  async loadSetup(): Promise<void> {
    try {
      const view = await this.crucible.setup();
      this.setup.set(view);
      this.installing.set(view.install.running);
      if (view.install.running || this.installEvents().length === 0) this.installEvents.set([...view.install.events]);
      // A Crucible here that is not in the list may just be stopped: its own control says.
      if (view.plan.discovered.present) {
        this.crucible.localPresence().then((p) => this.presence.set(p), () => this.presence.set(null));
        void this.loadLocalCodes();
      } else {
        this.presence.set(null);
        this.localCodes.set(null);
      }
    } catch (err) {
      this.localError.set(this.messageOf(err));
    }
  }

  private async loadLocalCodes(): Promise<void> {
    try {
      this.localCodes.set(await this.crucible.localConnectCodes());
      this.localCodesError.set(null);
    } catch (err) {
      this.localCodes.set(null);
      this.localCodesError.set(this.messageOf(err));
    }
  }

  async adopt(): Promise<void> {
    if (this.localBusy() !== null) return;
    this.localBusy.set('adopt');
    this.localError.set(null);
    try {
      const row = await this.crucible.add({ discovered: true });
      this.flash(`Connected ${row.name}.`);
      await this.reload();
    } catch (err) {
      this.localError.set(this.messageOf(err));
    } finally {
      this.localBusy.set(null);
    }
  }

  async startLocal(): Promise<void> {
    if (this.localBusy() !== null) return;
    this.localBusy.set('start');
    this.localError.set(null);
    try {
      // Answers `starting` at once; the outcome follows on the readiness push.
      this.readiness.set(await this.crucible.startLocal());
    } catch (err) {
      this.localError.set(this.messageOf(err));
    } finally {
      this.localBusy.set(null);
    }
  }

  async install(): Promise<void> {
    if (this.localBusy() !== null || this.installing()) return;
    this.localBusy.set('install');
    this.localError.set(null);
    this.installEvents.set([]);
    try {
      await this.crucible.startInstall();
      this.installing.set(true);
    } catch (err) {
      this.localError.set(this.messageOf(err));
      await this.loadSetup();
    } finally {
      this.localBusy.set(null);
    }
  }

  async checkRelease(): Promise<void> {
    this.localBusy.set('release');
    try {
      this.release.set(await this.crucible.checkRelease());
    } catch (err) {
      this.localError.set(this.messageOf(err));
    } finally {
      this.localBusy.set(null);
    }
  }

  async copyLocalCode(url: string): Promise<void> {
    try {
      const answer = await this.crucible.copyLocalConnectCode(url);
      this.flash(`Copied ${answer.copied}. Paste it into ContentStudio (or BookForge, or Briefcase) on the other computer. It carries this Crucible's access key: share it only with your own computers.`);
    } catch (err) {
      this.localCodesError.set(this.messageOf(err));
    }
  }

  // ── adding: pairing by address ─────────────────────────────────────────

  setAddMode(mode: AddMode): void {
    this.addMode.set(mode);
    this.pairError.set(null);
    this.codeError.set(null);
  }

  async startPairing(): Promise<void> {
    const address = this.pairAddress.trim();
    if (address === '' || this.pairBusy()) return;
    this.pairError.set(null);
    this.pairBusy.set(true);
    try {
      const prompt = await this.crucible.startPairing(address, this.pairName.trim() || undefined);
      this.pairing.set(prompt);
      this.schedulePoll(prompt, prompt.approvalRequired ? prompt.interval * 1000 : 0);
    } catch (err) {
      this.pairError.set(this.messageOf(err));
    } finally {
      this.pairBusy.set(false);
    }
  }

  private schedulePoll(prompt: CruciblePairingPrompt, delayMs: number): void {
    this.stopPolling();
    this.pollTimer = setTimeout(() => void this.poll(prompt), delayMs);
  }

  private async poll(prompt: CruciblePairingPrompt): Promise<void> {
    try {
      const decision = await this.crucible.pollPairing(prompt.requestId);
      if (this.pairing()?.requestId !== prompt.requestId) return;
      if (decision.status === 'pending') {
        this.schedulePoll(prompt, Math.max(1, prompt.interval) * 1000);
        return;
      }
      this.pairing.set(null);
      if (decision.status === 'approved') {
        this.pairAddress = '';
        this.pairName = '';
        this.flash(`Connected ${decision.name}.`);
        await this.reload();
      } else if (decision.status === 'denied') {
        this.pairError.set('That computer said no. Ask whoever is there to approve ContentStudio, then try again.');
      } else {
        this.pairError.set('The code expired before it was approved. Start again.');
      }
    } catch (err) {
      this.pairing.set(null);
      this.pairError.set(this.messageOf(err));
    }
  }

  cancelPairing(): void {
    const pending = this.pairing();
    this.stopPolling();
    this.pairing.set(null);
    if (pending !== null) void this.crucible.cancelPairing(pending.requestId).catch(() => undefined);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  // ── adding: a connect code ─────────────────────────────────────────────

  async onCodeChanged(): Promise<void> {
    this.codeError.set(null);
    const code = this.connectCode.trim();
    if (code === '') {
      this.codePreview.set(null);
      return;
    }
    try {
      this.codePreview.set(await this.crucible.readConnectCode(code));
    } catch (err) {
      this.codeError.set(this.messageOf(err));
    }
  }

  async addByCode(): Promise<void> {
    const code = this.connectCode.trim();
    if (code === '' || this.codeBusy()) return;
    this.codeBusy.set(true);
    this.codeError.set(null);
    try {
      const row = await this.crucible.add({ connectCode: code, ...(this.codeName.trim() ? { name: this.codeName.trim() } : {}) });
      this.connectCode = '';
      this.codeName = '';
      this.codePreview.set(null);
      this.flash(`Connected ${row.name}.`);
      await this.reload();
    } catch (err) {
      this.codeError.set(this.messageOf(err));
    } finally {
      this.codeBusy.set(false);
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private messageOf(err: unknown): string {
    return err instanceof CrucibleRefusal ? err.message : err instanceof Error ? err.message : String(err);
  }

  private setRowError(name: string, message: string | null): void {
    this.rowError.update((all) => {
      const rest = { ...all };
      delete rest[name];
      return message === null ? rest : { ...rest, [name]: message };
    });
  }

  private flash(message: string): void {
    this.note.set(message);
    if (this.noteTimer !== null) clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => this.note.set(null), 8000);
  }
}
