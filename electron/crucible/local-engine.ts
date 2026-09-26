/**
 * THE LOCAL-MACHINE DOOR THE PANE TALKS TO: the plan, the one-at-a-time driven
 * install and its progress, the local engine's presence and Start, and the
 * setup face the doors draw.
 *
 * Ported from Briefcase's install/install.service.ts without the Nest
 * wrapping and without the Windows host door: ContentStudio does not install
 * on the PC, it pairs to it (plan section 5), and on Owen's Mac the face is
 * ADOPT.
 *
 * ONE INSTALL AT A TIME. A second press while one runs is refused
 * `host_install_running`, the Windows host door's own word for the same fact.
 *
 * SURVIVING A QUIT MID-INSTALL. An install is a child of the main process, so
 * a quit takes it along. `crucible-install-state.json` records the step it
 * reached; on the next launch the status says `interrupted`, the setup face is
 * drawn from what is actually on disk (a pairing file or not), and Install
 * runs again: the package's steps are sha256-checked and re-entrant.
 *
 * NOTHING HERE STOPS OR UNINSTALLS CRUCIBLE. It is shared with BookForge,
 * Foundry and Briefcase, and another app may be mid-run.
 */
import * as fs from 'fs';
import * as log from 'electron-log';
import * as path from 'path';
import type { Runner } from '@crucible/bootstrap';
import type { CrucibleAutoConnect } from './auto-connect';
import type { CrucibleServers } from './servers';
import { presenceOf, type LocalControls } from './engine-presence';
import {
  CrucibleInstallError,
  checkRelease,
  contentStudioInstallOptions,
  crucibleInstallPlan,
  driveCrucibleInstall,
  installRefusalOf,
  type BootstrapSurface,
  type CrucibleReleaseSources,
  type InstallHost,
} from './install';
import type {
  CrucibleEnginePresence,
  CrucibleEngineStartOutcome,
  CrucibleHostability,
  CrucibleInstallPlan,
  CrucibleInstallProgress,
  CrucibleInstallStatus,
  CrucibleReleaseCheck,
  CrucibleSetupFace,
  CrucibleSetupView,
  DiscoveredCrucibleRow,
} from './wire';

/** Everything the install touches outside this process, injectable. */
export interface LocalEngineDeps {
  /** Machine reads for the plan and hostability. */
  host: InstallHost;
  /** The never-older gate's two facts. */
  sources: CrucibleReleaseSources;
  /** `@crucible/bootstrap`'s install() and startLocal(), loaded on first use. */
  bootstrap(): Promise<BootstrapSurface>;
  /** The runner the package spawns and reads through. */
  runner(): Runner;
  /** `localStatus()` / `startLocal()`. */
  localControls(): Promise<LocalControls>;
  /** `CRUCIBLE_HOME` for the install and the local controls; undefined means the platform default. */
  home?: string;
}

export const INSTALL_STATE_FILE = 'crucible-install-state.json';

/** How many progress events a pane opened late can replay. */
const EVENT_BUFFER = 400;

interface InstallRecord {
  state: 'running' | 'done' | 'failed';
  release: string | null;
  step: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/**
 * THE ONE FACE (INTEGRATING-AN-APP.md §4.5). Pure, so each branch is a check.
 *
 *   a registered server              → connected
 *   a Crucible here, not registered  → adopt
 *   nothing here, hostable           → install  (`unknown` draws install too)
 *   nothing here, not hostable       → connect-only
 */
export function setupFace(registered: number, discovered: DiscoveredCrucibleRow, hostable: CrucibleHostability): CrucibleSetupFace {
  if (registered > 0) return 'connected';
  if (discovered.present) return 'adopt';
  return hostable === 'no' ? 'connect-only' : 'install';
}

export class CrucibleLocalEngine {
  private readonly stateFile: string;
  private running: Promise<void> | null = null;
  private release: string | null = null;
  private events: CrucibleInstallProgress[] = [];

  constructor(
    stateDir: string,
    private readonly servers: CrucibleServers,
    private readonly autoConnect: CrucibleAutoConnect,
    private readonly deps: LocalEngineDeps,
    private readonly pushProgress: (event: CrucibleInstallProgress) => void = () => {},
  ) {
    this.stateFile = path.join(stateDir, INSTALL_STATE_FILE);
  }

  // ── reads ────────────────────────────────────────────────────────────

  plan(): CrucibleInstallPlan {
    return crucibleInstallPlan(this.deps.host);
  }

  status(): CrucibleInstallStatus {
    const last = this.readRecord();
    const running = this.running !== null;
    return { running, release: running ? this.release : last?.release ?? null, interrupted: !running && last?.state === 'running', events: [...this.events] };
  }

  /** Everything the doors draw, in one read. */
  setup(): CrucibleSetupView {
    const plan = this.plan();
    const servers = this.servers.names();
    return {
      face: setupFace(servers.length, plan.discovered, plan.hostable),
      servers,
      plan,
      install: this.status(),
    };
  }

  /** The never-older gate's answer, asked without installing anything. */
  checkRelease(): Promise<CrucibleReleaseCheck> {
    return checkRelease(this.deps.sources);
  }

  async presence(): Promise<CrucibleEnginePresence> {
    const controls = await this.deps.localControls();
    return presenceOf(await controls.status());
  }

  /**
   * Start the local engine, because a person pressed Start. Never stops one.
   * When it comes up and nothing is registered yet, it is adopted as a row,
   * as after an install.
   */
  async startLocal(): Promise<CrucibleEngineStartOutcome> {
    let started: boolean;
    let detail: string;
    try {
      const controls = await this.deps.localControls();
      const status = await controls.start();
      started = status.state === 'running';
      detail = status.detail;
    } catch (err) {
      return { started: false, detail: (err as Error).message, connectedAs: null };
    }
    let connectedAs: string | null = null;
    if (started && this.servers.names().length === 0) {
      try {
        connectedAs = await this.autoConnect.run(true);
      } catch (err) {
        detail = `${detail} ${(err as Error).message}`.trim();
      }
    }
    return { started, detail, connectedAs };
  }

  // ── the driven install ───────────────────────────────────────────────

  /**
   * Start an install. Resolves once the never-older gate has chosen a release
   * (or throws its refusal, and nothing was spawned); the install itself runs
   * on, reporting on `crucible:install-progress`, and ends in `done` (the
   * engine is up and adopted) or `failed`.
   */
  async start(): Promise<{ started: true; release: string }> {
    if (this.running !== null) {
      throw new CrucibleInstallError(
        'host_install_running',
        'an install is already running on this computer. There is one install per computer; follow its progress instead of starting a second.',
      );
    }
    const plan = this.plan();
    if (plan.hostable === 'no') {
      throw new CrucibleInstallError('not_hostable', plan.hostableWhy);
    }

    this.events = [];
    this.release = null;
    const startedAt = new Date().toISOString();
    let releaseChosen: (release: string) => void = () => undefined;
    const gate = new Promise<string>((resolve) => { releaseChosen = resolve; });
    let step: string | null = null;

    const send = (progress: CrucibleInstallProgress): void => {
      this.events.push(progress);
      if (this.events.length > EVENT_BUFFER) this.events.splice(0, this.events.length - EVENT_BUFFER);
      this.pushProgress(progress);
    };
    const record = (state: InstallRecord['state']): void => {
      this.writeRecord({ state, release: this.release, step, startedAt, finishedAt: state === 'running' ? null : new Date().toISOString() });
    };

    const options = contentStudioInstallOptions(
      (text, stream, stepName) => send({ kind: 'line', step: stepName, stream, text }),
      {
        home: this.deps.home,
        onStep: (installStep) => {
          step = installStep.name;
          record('running');
          send({ kind: 'step', step: installStep.name, index: null, total: null, status: installStep.status, detail: installStep.detail });
        },
        // The host's events are forwarded whole: `state` is a fact about the
        // machine and `progress` is where the bytes are.
        onHostEvent: (event) => {
          if (event.event === 'state') {
            send({ kind: 'state', code: event.data.code, sentence: event.data.sentence, action: event.data.action });
          } else if (event.event === 'progress') {
            send({ kind: 'progress', file: event.data.file, done: event.data.bytes_done, total: event.data.bytes_total });
          } else if (event.event === 'step') {
            step = event.data.name;
            send({ kind: 'step', step: event.data.name, index: event.data.index, total: event.data.total, status: 'running', detail: '' });
          }
        },
      },
    );

    const run = (async () => {
      try {
        const bootstrap = await this.deps.bootstrap();
        const result = await driveCrucibleInstall(options, {
          bootstrap,
          runner: this.deps.runner(),
          sources: this.deps.sources,
          onRelease: (chosen) => {
            this.release = chosen;
            record('running');
            releaseChosen(chosen);
          },
        });
        // The ending is recorded before anything is done with it.
        record('done');
        log.info(`[crucible] Installed Crucible ${result.release} (${result.backend}) as "${result.server.name}"`);
        let connectedAs: string | null = null;
        try {
          connectedAs = await this.autoConnect.run(true);
        } catch (err) {
          log.warn(`[crucible] Installed Crucible, but could not connect it: ${(err as Error).message}`);
        }
        send({ kind: 'done', server: { name: result.server.name, url: result.server.url }, release: result.release, backend: result.backend, connectedAs });
      } catch (err) {
        const refusal = installRefusalOf(err);
        log.warn(`[crucible] Install stopped: ${refusal.message}`);
        // Refused before a release was chosen (the gate, the channel): nothing
        // was spawned, so there is no install to record. The caller gets the
        // refusal as the answer to its press.
        if (this.release !== null) {
          record('failed');
          send({ kind: 'failed', refusal });
        }
        throw err;
      }
    })();
    this.running = run.then(() => undefined, () => undefined).finally(() => { this.running = null; });

    // Answer once the gate has spoken: a refusal before any release was chosen
    // is the gate's (or the channel's), and nothing was spawned.
    return Promise.race([
      gate.then((chosen) => ({ started: true as const, release: chosen })),
      run.then(
        () => ({ started: true as const, release: this.release ?? '' }),
        (err: unknown) => {
          if (this.release === null) throw err;
          return { started: true as const, release: this.release };
        },
      ),
    ]);
  }

  /** Resolves when the running install (if any) has ended. For keepers and a graceful quit. */
  async settled(): Promise<void> {
    await this.running;
  }

  // ── the record on disk ───────────────────────────────────────────────

  private readRecord(): InstallRecord | null {
    let text: string;
    try {
      text = fs.readFileSync(this.stateFile, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      log.warn(`[crucible] ${this.stateFile} could not be read: ${(err as Error).message}`);
      return null;
    }
    try {
      return JSON.parse(text) as InstallRecord;
    } catch {
      log.warn(`[crucible] ${this.stateFile} is not JSON; ignoring it`);
      return null;
    }
  }

  private writeRecord(record: InstallRecord): void {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const temp = `${this.stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`);
      fs.renameSync(temp, this.stateFile);
    } catch (err) {
      log.warn(`[crucible] Could not record the install's progress: ${(err as Error).message}`);
    }
  }
}
