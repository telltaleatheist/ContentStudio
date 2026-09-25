/**
 * IS CRUCIBLE THERE FOR AI WORK: the one readiness signal.
 *
 * Ported from Briefcase's readiness.service.ts (plan section 0a: "one
 * readiness service, pushed to the renderer. Every AI control is disabled with
 * that one reason and one door. Browsing, downloads, the editor's non-AI
 * features and export never touch it"). Owen's Briefcase rulings apply here:
 * "if crucible is down, briefcase is down... the user just cant take any
 * actions that would require crucible". This answers, in one place, whether
 * an AI action can run and what repairs it when it cannot, derived from the
 * registry, the probe and the local engine's presence, and pushed on
 * `crucible:readiness` whenever the answer changes.
 *
 *   ready           the selected server answers (a busy card is still ready: the
 *                   work queues and parks until the holder is done).
 *   starting        the app is starting (or installing) the local Crucible.
 *   unreachable     the selected server, or the one installed here, doesn't answer.
 *   not-installed   nothing registered or installed, and this computer can host one.
 *   not-configured  nothing registered and this computer cannot host one, or
 *                   no registered server is selected.
 *
 * BRINGING IT UP. An explicit Start (the door) starts the local engine once;
 * nothing here starts it on its own. The user can decline ("Not now"):
 * remembered for the process's life, after which nothing prompts on its own;
 * an explicit Start still works. (Briefcase's automatic start when AI work is
 * parked belongs with the queue, P3.)
 *
 * GATING. `assertReadyNow` refuses an immediate AI call unless a server
 * answers; `assertCanQueue` refuses queueing AI work that could never run as
 * things stand (nothing to connect to), and accepts work for a registered
 * server that is merely down, which parks. P2 and P3 wire the callers.
 *
 * BOOT. Nothing is awaited at boot: the first derivation is a timer started by
 * `start()`. Until it lands, `current()` answers from the registry alone,
 * reading no network.
 */
import * as log from 'electron-log';
import type { CrucibleLocalEngine } from './local-engine';
import type { CrucibleProbes } from './probe';
import type { CrucibleServers } from './servers';
import { CrucibleRegistryError, CrucibleRoutingError } from './errors';
import type { CrucibleEnginePresence, CrucibleInstallPlan, CrucibleReadinessView, RoutingView } from './wire';

/** How often the answer is derived again on its own: often while AI can't run, rarely while it can. */
export const READINESS_REFRESH_MS = { notReady: 10_000, ready: 30_000 } as const;
/** The install plan (host facts: nvidia-smi on Linux) is read at most this often. */
const PLAN_CACHE_MS = 5 * 60_000;
/** The local engine's own status (a CLI call) is read at most this often. */
const PRESENCE_CACHE_MS = 15_000;

/** An action that needs Crucible, refused because Crucible is not there. Carries the view, so the caller shows the one door. */
export class CrucibleRequiredError extends Error {
  readonly code = 'crucible_required';
  constructor(what: string, readonly readiness: CrucibleReadinessView) {
    super(`${what} needs Crucible. ${readiness.reason}`);
    this.name = 'CrucibleRequiredError';
  }
}

function sameView(a: CrucibleReadinessView, b: CrucibleReadinessView): boolean {
  const { at: _a, ...x } = a;
  const { at: _b, ...y } = b;
  return JSON.stringify(x) === JSON.stringify(y);
}

export class CrucibleReadiness {
  private view: CrucibleReadinessView;
  private declined = false;
  private startingLine: string | null = null;
  /** Why the last start this process tried did not bring it up, said until the next derivation that finds it up. */
  private startFailure: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private deriving: Promise<CrucibleReadinessView> | null = null;
  private deriveAgain = false;
  private planCache: { at: number; plan: CrucibleInstallPlan } | null = null;
  private presenceCache: { at: number; presence: CrucibleEnginePresence } | null = null;
  private stopped = false;
  private offRegistry: (() => void) | null = null;
  private readonly listeners = new Set<(view: CrucibleReadinessView) => void>();

  /** Replaceable by a keeper. */
  now: () => number = Date.now;
  refreshMs: { notReady: number; ready: number } = { ...READINESS_REFRESH_MS };

  constructor(
    private readonly servers: CrucibleServers,
    private readonly probes: CrucibleProbes,
    private readonly local: CrucibleLocalEngine,
    private readonly pushToRenderer: (view: CrucibleReadinessView) => void = () => {},
  ) {
    this.view = this.provisional();
  }

  /** Begin deriving. Never awaited: boot does not wait on Crucible. */
  start(): void {
    this.offRegistry = this.servers.onChange(() => this.refreshSoon());
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.offRegistry?.();
    this.offRegistry = null;
  }

  // ── reads ──────────────────────────────────────────────────────────────

  /** The latest answer, synchronously (no network). */
  current(): CrucibleReadinessView {
    return this.view;
  }

  /** Every change of the answer, in process (the queue listens). Returns the unsubscribe. */
  onChange(listener: (view: CrucibleReadinessView) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Derive the answer again now (a Test button, the renderer's refresh). */
  async refresh(): Promise<CrucibleReadinessView> {
    if (this.deriving) {
      this.deriveAgain = true;
      return this.deriving;
    }
    this.deriving = (async () => {
      let view: CrucibleReadinessView;
      do {
        this.deriveAgain = false;
        view = await this.derive().catch((err: unknown) => this.answer('unreachable', `Crucible's state could not be read (${(err as Error)?.message ?? err}).`, 'connect'));
      } while (this.deriveAgain);
      this.publish(view);
      return view;
    })().finally(() => {
      this.deriving = null;
      this.schedule(this.view.state === 'ready' ? this.refreshMs.ready : this.refreshMs.notReady);
    });
    return this.deriving;
  }

  // ── gating ─────────────────────────────────────────────────────────────

  /**
   * Refuse queueing AI work that could never run as things stand: nothing to
   * connect to (not installed, not configured), or the user declined bringing
   * Crucible up. A registered server that is down, or one being started, is
   * not a refusal: the work parks until it is back.
   */
  assertCanQueue(what: string): void {
    const view = this.view;
    if (view.state === 'ready' || view.state === 'starting') return;
    if (view.state === 'unreachable' && !view.declined) return;
    throw new CrucibleRequiredError(what, view);
  }

  /** Refuse an immediate AI call (no queue to park in) unless a server answers now. */
  assertReadyNow(what: string): void {
    if (this.view.state !== 'ready') throw new CrucibleRequiredError(what, this.view);
  }

  // ── bringing it up ─────────────────────────────────────────────────────

  /** The user said "Not now": nothing prompts on its own again this session. */
  decline(): CrucibleReadinessView {
    if (!this.declined) log.info('[crucible] Bringing Crucible up was declined for this session');
    this.declined = true;
    this.publish({ ...this.view, declined: true, at: new Date(this.now()).toISOString() });
    return this.view;
  }

  /**
   * Start the Crucible on this computer (the local engine's startLocal, which
   * adopts it into the registry when nothing is registered). Answers at once
   * with `starting`; the outcome follows on `crucible:readiness`. Never stops
   * anything.
   */
  startLocal(): Promise<CrucibleReadinessView> {
    if (this.startingLine !== null) return Promise.resolve(this.view);
    this.startingLine = 'Starting Crucible on this computer...';
    this.startFailure = null;
    this.publish(this.answer('starting', 'Crucible is starting on this computer.', null));
    void (async () => {
      try {
        const outcome = await this.local.startLocal();
        if (!outcome.started) {
          this.startFailure = `Crucible could not be started on this computer${outcome.detail ? ` (${outcome.detail})` : ''}.`;
          log.warn(`[crucible] ${this.startFailure}`);
        } else {
          log.info(`[crucible] Crucible started on this computer${outcome.connectedAs ? `, connected as "${outcome.connectedAs}"` : ''}`);
        }
        this.presenceCache = null;
        // Fresh probes, so the pane's rows stop showing the pre-start answer.
        // A probe never rejects (every failure is an outcome), so nothing is lost here.
        for (const name of this.servers.names()) void this.probes.test(name);
      } catch (err) {
        this.startFailure = `Crucible could not be started on this computer (${(err as Error)?.message ?? err}).`;
        log.warn(`[crucible] ${this.startFailure}`);
      } finally {
        this.startingLine = null;
        await this.refresh();
      }
    })();
    return Promise.resolve(this.view);
  }

  // ── derivation ─────────────────────────────────────────────────────────

  /**
   * The choice, or the named refusal of a corrupt record. Briefcase read a
   * corrupt record as "no servers", which would tell a person to INSTALL a
   * Crucible they already have; the refusal is the answer instead (Law 1).
   */
  private routing(): RoutingView | CrucibleRoutingError | CrucibleRegistryError {
    try {
      return this.servers.routingView();
    } catch (err) {
      if (err instanceof CrucibleRoutingError || err instanceof CrucibleRegistryError) return err;
      throw err;
    }
  }

  private answer(
    state: CrucibleReadinessView['state'],
    reason: string,
    action: CrucibleReadinessView['action'],
    extra: Partial<Pick<CrucibleReadinessView, 'server' | 'busy'>> = {},
  ): CrucibleReadinessView {
    return {
      state,
      reason,
      action,
      server: extra.server ?? null,
      busy: extra.busy ?? null,
      progress: state === 'starting' ? this.startingLine ?? this.installLine() : null,
      declined: this.declined,
      at: new Date(this.now()).toISOString(),
    };
  }

  /** Before the first derivation: the registry alone, no network. */
  private provisional(): CrucibleReadinessView {
    const routing = this.routing();
    if (!('servers' in routing)) return this.answer('not-configured', routing.message, 'connect');
    if (routing.selected !== null) return this.answer('unreachable', `Checking Crucible on ${routing.selected}...`, null);
    return this.answer('not-configured', 'Checking for Crucible...', null);
  }

  private installLine(): string | null {
    const status = this.local.status();
    if (!status.running) return null;
    const last = [...status.events].reverse().find((e) => e.kind === 'step');
    return last && last.kind === 'step' ? `Installing Crucible: ${last.step}` : 'Installing Crucible...';
  }

  private plan(): CrucibleInstallPlan {
    const now = this.now();
    if (this.planCache === null || now - this.planCache.at > PLAN_CACHE_MS) this.planCache = { at: now, plan: this.local.plan() };
    return this.planCache.plan;
  }

  private async presence(): Promise<CrucibleEnginePresence | null> {
    const now = this.now();
    if (this.presenceCache !== null && now - this.presenceCache.at < PRESENCE_CACHE_MS) return this.presenceCache.presence;
    try {
      const presence = await this.local.presence();
      this.presenceCache = { at: now, presence };
      return presence;
    } catch {
      return null;
    }
  }

  private async derive(): Promise<CrucibleReadinessView> {
    if (this.startingLine !== null || this.local.status().running) {
      return this.answer('starting', this.startingLine !== null ? 'Crucible is starting on this computer.' : 'Crucible is being installed on this computer.', null);
    }
    const routing = this.routing();
    if (!('servers' in routing)) return this.answer('not-configured', routing.message, 'connect');
    const selected = routing.selected;
    // Paused is the user's own hold (plan section 14): the server is not
    // probed, work waits for it, and nothing goes anywhere else (LEDGER #205).
    // Not `ready`, because an immediate AI call must not run on a paused server.
    if (selected !== null && routing.servers.some((row) => row.name === selected && row.paused)) {
      return this.answer('unreachable', `Crucible on ${selected} is paused. AI work waits until it is set to Running in Settings › Crucible Servers.`, 'connect');
    }
    let silent: string | null = null;
    if (selected !== null) {
      const answer = await this.probes.reach(selected);
      if (answer.reach === 'ready' || answer.reach === 'busy') {
        this.startFailure = null;
        const busy = answer.reach === 'busy' && answer.probe.outcome === 'ok' ? answer.probe.facts.busyLine : null;
        return this.answer('ready', `Crucible on ${selected} is ready${busy ? ` (${busy}; AI work waits its turn)` : ''}.`, null, { server: selected, busy });
      }
      silent = answer.probe.outcome === 'ok' ? `Crucible on ${selected} isn't answering` : answer.probe.message.replace(/[.\s]+$/, '');
    }

    const plan = this.plan();
    const here = plan.discovered;
    const failed = this.startFailure !== null ? ` ${this.startFailure}` : '';

    if (routing.servers.length > 0) {
      if (selected === null) {
        const why = routing.missing !== null
          ? `The selected Crucible server "${routing.missing}" isn't connected any more.`
          : 'No Crucible server is selected.';
        return this.answer('not-configured', `${why} Select one in Settings › Crucible Servers.`, 'connect');
      }
      const localName = here.present ? here.registeredAs : null;
      if (localName !== null && selected === localName) {
        const presence = await this.presence();
        if (presence?.offerStart) {
          return this.answer('unreachable', `${presence.message ?? 'Crucible is stopped on this computer.'}${failed}`, 'start');
        }
      }
      return this.answer('unreachable', `${silent}.${failed}`, 'connect');
    }

    if (here.present) {
      return this.answer('unreachable', `Crucible is installed on this computer but not connected to ContentStudio.${failed}`, 'start');
    }
    if (plan.hostable === 'no') {
      return this.answer('not-configured', `${plan.hostableWhy.replace(/[.\s]+$/, '')}. Connect to a Crucible on another computer in Settings › Crucible Servers.`, 'connect');
    }
    return this.answer('not-installed', 'Crucible is not installed. Transcription and every model call run on it: install it, or connect to a Crucible on another computer.', 'install');
  }

  // ── publishing ─────────────────────────────────────────────────────────

  private publish(view: CrucibleReadinessView): void {
    const changed = !sameView(view, this.view);
    this.view = view;
    if (!changed) return;
    log.info(`[crucible] ${view.state}: ${view.reason}`);
    this.pushToRenderer(view);
    for (const listener of this.listeners) {
      try {
        listener(view);
      } catch (err) {
        log.warn(`[crucible] A readiness listener failed: ${(err as Error).message}`);
      }
    }
  }

  private refreshSoon(): void {
    this.schedule(250);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, ms);
    this.timer.unref?.();
  }
}
