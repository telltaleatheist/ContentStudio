import { Injectable, NgZone } from '@angular/core';
import type {
  AddServerRequest,
  ConnectCodeReading,
  CopiedConnectCode,
  CrucibleEnginePresence,
  CrucibleInstallProgress,
  CrucibleIpcResult,
  CrucibleLanesView,
  CruciblePairingDecision,
  CruciblePairingPrompt,
  CrucibleProbeAnswer,
  CrucibleReadinessView,
  CrucibleReleaseCheck,
  CrucibleServerRow,
  CrucibleServersChangedPayload,
  CrucibleServersView,
  CrucibleSettingsView,
  CrucibleSetupView,
  KeyMigrationOutcome,
  LocalConnectCodes,
  QueuePlan,
  QueuePlanCandidate,
  RoutingView,
  UpstreamName,
  UpstreamTestAnswer,
} from '../features/crucible/crucible.types';

/**
 * A refusal from the main process's Crucible layer: its code (the registry's, the SDK's, or
 * a probe outcome) and a sentence that carries the fix. The pane acts on the code and shows
 * the sentence; it never parses the sentence (LEDGER Law 10).
 */
export class CrucibleRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CrucibleRefusal';
  }
}

/**
 * The renderer's one door to the Crucible IPC block (electron/crucible/crucible-ipc.ts).
 *
 * Every `crucible:*` channel answers a `{success, data} | {success, code, error}` envelope;
 * this unwraps it, so a caller gets the data or a {@link CrucibleRefusal} and never a
 * `success: false` it could forget to look at. Nothing here holds a token: none crosses.
 *
 * Outside Electron (the Angular dev server in a plain browser) there is no main process and
 * so no Crucible: every call refuses `no_bridge` by name rather than pretending an empty list.
 * The three pushes are re-entered into Angular's zone, because contextBridge callbacks arrive
 * outside it and a signal set there would wait for the next unrelated event to be drawn.
 */
@Injectable({ providedIn: 'root' })
export class CrucibleService {
  constructor(private readonly zone: NgZone) {}

  private get bridge(): Window['launchpad'] {
    if (typeof window === 'undefined' || !window.launchpad) {
      throw new CrucibleRefusal('no_bridge', 'Crucible is reached through the ContentStudio app, which this window is not running in.');
    }
    return window.launchpad;
  }

  private async unwrap<T>(call: () => Promise<CrucibleIpcResult<T>>): Promise<T> {
    const answer = await call();
    if (answer.success) return answer.data;
    // Spelled out: the renderer's tsconfig does not narrow a union on a boolean literal.
    const refused = answer as Extract<CrucibleIpcResult<T>, { success: false }>;
    throw new CrucibleRefusal(refused.code, refused.error);
  }

  // ── the list and the choice ────────────────────────────────────────────

  servers(): Promise<CrucibleServersView> {
    return this.unwrap(() => this.bridge.crucibleServers());
  }

  /** A probe at most 15 s old. */
  probe(name: string): Promise<CrucibleProbeAnswer> {
    return this.unwrap(() => this.bridge.crucibleProbe(name));
  }

  /** A probe taken now (the Test button). */
  test(name: string): Promise<CrucibleProbeAnswer> {
    return this.unwrap(() => this.bridge.crucibleTest(name));
  }

  add(request: AddServerRequest): Promise<CrucibleServerRow> {
    return this.unwrap(() => this.bridge.crucibleAdd(request));
  }

  remove(name: string): Promise<CrucibleServerRow> {
    return this.unwrap(() => this.bridge.crucibleRemove(name));
  }

  select(name: string): Promise<RoutingView> {
    return this.unwrap(() => this.bridge.crucibleSelect(name));
  }

  setFast(name: string | null): Promise<RoutingView> {
    return this.unwrap(() => this.bridge.crucibleSetFast(name));
  }

  setPaused(name: string, paused: boolean): Promise<RoutingView> {
    return this.unwrap(() => this.bridge.crucibleSetPaused(name, paused));
  }

  // ── adding a server ────────────────────────────────────────────────────

  startPairing(address: string, name?: string): Promise<CruciblePairingPrompt> {
    return this.unwrap(() => this.bridge.cruciblePairStart(address, name));
  }

  pollPairing(requestId: string): Promise<CruciblePairingDecision> {
    return this.unwrap(() => this.bridge.cruciblePairPoll(requestId));
  }

  cancelPairing(requestId: string): Promise<{ cancelled: true }> {
    return this.unwrap(() => this.bridge.cruciblePairCancel(requestId));
  }

  readConnectCode(line: string): Promise<ConnectCodeReading> {
    return this.unwrap(() => this.bridge.crucibleConnectCodeRead(line));
  }

  copyConnectCode(name: string): Promise<CopiedConnectCode> {
    return this.unwrap(() => this.bridge.crucibleConnectCodeCopy(name));
  }

  localConnectCodes(): Promise<LocalConnectCodes> {
    return this.unwrap(() => this.bridge.crucibleConnectCodesLocal());
  }

  copyLocalConnectCode(url: string): Promise<CopiedConnectCode> {
    return this.unwrap(() => this.bridge.crucibleConnectCodeCopyLocal(url));
  }

  // ── one server's keys ──────────────────────────────────────────────────

  settings(name: string): Promise<CrucibleSettingsView> {
    return this.unwrap(() => this.bridge.crucibleSettingsGet(name));
  }

  saveUpstreamKey(name: string, upstream: UpstreamName, key: string): Promise<CrucibleSettingsView> {
    return this.unwrap(() => this.bridge.crucibleSettingsPut(name, { upstreams: { [upstream]: { key } } }));
  }

  removeUpstream(name: string, upstream: UpstreamName): Promise<CrucibleSettingsView> {
    return this.unwrap(() => this.bridge.crucibleSettingsPut(name, { upstreams: { [upstream]: null } }));
  }

  testUpstream(name: string, upstream: UpstreamName, probe: { key?: string; url?: string }): Promise<UpstreamTestAnswer> {
    return this.unwrap(() => this.bridge.crucibleUpstreamTest(name, upstream, probe));
  }

  /** What the api-keys.json move into this computer's Crucible last said (null: it has not run yet). */
  keyMigration(): Promise<KeyMigrationOutcome | null> {
    return this.unwrap(() => this.bridge.crucibleKeyMigration());
  }

  /** The answer when the move found a different key on the server (plan 6.6). */
  resolveKeyMigration(choice: 'replace' | 'keep'): Promise<KeyMigrationOutcome> {
    return this.unwrap(() => this.bridge.crucibleKeyMigrationResolve(choice));
  }

  // ── this computer: the doors ───────────────────────────────────────────

  setup(): Promise<CrucibleSetupView> {
    return this.unwrap(() => this.bridge.crucibleSetup());
  }

  startInstall(): Promise<{ started: true; release: string }> {
    return this.unwrap(() => this.bridge.crucibleInstallStart());
  }

  checkRelease(): Promise<CrucibleReleaseCheck> {
    return this.unwrap(() => this.bridge.crucibleReleaseCheck());
  }

  localPresence(): Promise<CrucibleEnginePresence> {
    return this.unwrap(() => this.bridge.crucibleLocalPresence());
  }

  // ── readiness ──────────────────────────────────────────────────────────

  readiness(): Promise<CrucibleReadinessView> {
    return this.unwrap(() => this.bridge.crucibleReadiness());
  }

  refreshReadiness(): Promise<CrucibleReadinessView> {
    return this.unwrap(() => this.bridge.crucibleReadinessRefresh());
  }

  declineReadiness(): Promise<CrucibleReadinessView> {
    return this.unwrap(() => this.bridge.crucibleReadinessDecline());
  }

  /** The Start door: starts the Crucible on this computer; the outcome follows on `onReadiness`. */
  startLocal(): Promise<CrucibleReadinessView> {
    return this.unwrap(() => this.bridge.crucibleReadinessStart());
  }

  // ── the queue's lanes (P3) ─────────────────────────────────────────────

  /** The lanes strip: one chip per server. */
  lanes(): Promise<CrucibleLanesView> {
    return this.unwrap(() => this.bridge.crucibleLanes());
  }

  /** Which of these rows start now (one per server at most), which wait and why. Main decides. */
  queuePlan(candidates: QueuePlanCandidate[]): Promise<QueuePlan> {
    return this.unwrap(() => this.bridge.crucibleQueuePlan(candidates));
  }

  // ── pushes ─────────────────────────────────────────────────────────────

  onServersChanged(callback: (change: CrucibleServersChangedPayload) => void): () => void {
    if (typeof window === 'undefined' || !window.launchpad) return () => {};
    return window.launchpad.onCrucibleServersChanged((change) => this.zone.run(() => callback(change)));
  }

  onReadiness(callback: (view: CrucibleReadinessView) => void): () => void {
    if (typeof window === 'undefined' || !window.launchpad) return () => {};
    return window.launchpad.onCrucibleReadiness((view) => this.zone.run(() => callback(view)));
  }

  onInstallProgress(callback: (event: CrucibleInstallProgress) => void): () => void {
    if (typeof window === 'undefined' || !window.launchpad) return () => {};
    return window.launchpad.onCrucibleInstallProgress((event) => this.zone.run(() => callback(event)));
  }

  onLanes(callback: (view: CrucibleLanesView) => void): () => void {
    if (typeof window === 'undefined' || !window.launchpad) return () => {};
    return window.launchpad.onCrucibleLanes((view) => this.zone.run(() => callback(view)));
  }
}
