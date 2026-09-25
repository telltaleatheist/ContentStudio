/**
 * THE COMPOSITION ROOT for everything under electron/crucible/: one place
 * that builds the registry, the probe, the connect flows, the local engine
 * and readiness over one state directory, wired the way the app wires them.
 *
 * Briefcase has Nest's module for this; ContentStudio has this function.
 * main.ts calls it with userData and Electron's clipboard and windows; a
 * keeper calls it with a temp directory, a scripted pairing host and
 * recorders, so the same wiring is under test (plan section 0a: the "no
 * Crucible" suite boots the real services with no server at all).
 *
 * Nothing in here touches the network. `start()` begins the three background
 * loops (auto-connect, readiness and the lanes' 15 s preflight), all
 * fire-and-forget; `stop()` ends them on quit. None is ever awaited by
 * `app.whenReady`.
 *
 * P3 adds the queue's layer over the same state directory: the in-flight
 * ledger (`<userData>/crucible-in-flight.json`), the lanes, and the two sweeps.
 * `sweepAtStartup()` gives back what a kill left behind and GATES GPU
 * admission until it settles (plan section 13.4); `quit()` aborts the running
 * jobs, lets them unwind, then sweeps under the quit deadline.
 */
import type { Runner } from '@crucible/bootstrap';
import * as log from 'electron-log';
import { CrucibleAutoConnect } from './auto-connect';
import { CrucibleClientFactory } from './client-factory';
import { CrucibleConnect, type ClipboardWriter } from './connect';
import { InFlightLedger } from './in-flight-ledger';
import { STARTUP_SWEEP_DEADLINE_MS, sweepCrucibleInFlight, type SweepReport } from './in-flight-sweep';
import { CrucibleLanes } from './lanes';
import { discoveredRow } from './discovery';
import { processLocalControls } from './engine-presence';
import { loadBootstrap, processInstallHost, type CrucibleReleaseSources, type InstallHost } from './install';
import { CrucibleLocalEngine, type LocalEngineDeps } from './local-engine';
import { processPairingFileHost, type PairingFileHost } from './pairing-file';
import { CrucibleProbes } from './probe';
import { CrucibleReadiness } from './readiness';
import { CrucibleServers } from './servers';
import { CrucibleSettingsBridge } from './settings-bridge';
import { CrucibleRoutingError } from './errors';
import { migrateLegacyKeys } from './key-migration';
import { CrucibleTransport, type TransportHost } from './transport';
import type { LeaseTimings } from './lease';
import type { CrucibleInstallProgress, CrucibleLanesView, CrucibleReadinessView, CrucibleServersChangedPayload, KeyMigrationOutcome } from './wire';

export interface CrucibleContextDeps {
  /** Where crucible-servers.json, crucible-routing.json and crucible-install-state.json live. */
  stateDir: string;
  /** Where the pairing file is read from. Default: this process's platform, env and home. */
  pairingHost?: PairingFileHost;
  clipboard: ClipboardWriter;
  /**
   * The old `<userData>/api-keys.json`, moved once into the Crucible on this
   * computer and then deleted (plan 6.6), and where `keysMigratedTo` is kept.
   * Absent: no migration runs (a keeper that is not about keys).
   */
  legacyKeys?: { file: string; record: { get(): string | null; set(server: string): void } };
  /** Only a keeper passes this: short clocks for the lease heartbeat and the load stream. */
  leaseTimings?: Partial<LeaseTimings>;
  /** Pushes to every renderer window. Default: nothing (a keeper). */
  push?: {
    serversChanged?: (change: CrucibleServersChangedPayload) => void;
    readiness?: (view: CrucibleReadinessView) => void;
    installProgress?: (event: CrucibleInstallProgress) => void;
    lanes?: (view: CrucibleLanesView) => void;
  };
  /**
   * A CLI's `--server`: this process sends its work to that registered server instead of the
   * selected one, and the routing record is never written. Refused by name when unregistered.
   */
  serverOverride?: string;
  /** The ledger's file name under `stateDir`. Default `crucible-in-flight.json`; a CLI names its own. */
  ledgerFile?: string;
  /** The lanes' clocks, replaceable by a keeper. */
  lanes?: { now?: () => number; stallMs?: number; preflightEveryMs?: number };
  /** The install seam, injectable so a keeper never installs, spawns or reads GitHub. Default: the real machine. */
  local?: Partial<LocalEngineDeps>;
}

export interface CrucibleContext {
  servers: CrucibleServers;
  factory: CrucibleClientFactory;
  probes: CrucibleProbes;
  connect: CrucibleConnect;
  autoConnect: CrucibleAutoConnect;
  settings: CrucibleSettingsBridge;
  local: CrucibleLocalEngine;
  readiness: CrucibleReadiness;
  /** The one door every model call takes (plan 6.1). main.ts installs it process-wide. */
  transport: CrucibleTransport;
  /** The api-keys.json move (plan 6.6): run it, answer its question, read what it last said. */
  keys: {
    migrate(resolve?: 'replace' | 'keep'): Promise<KeyMigrationOutcome>;
    last(): KeyMigrationOutcome | null;
  };
  pairingHost: PairingFileHost;
  ledger: InFlightLedger;
  lanes: CrucibleLanes;
  /**
   * Give back every hold the ledger lists (what a kill left behind), under the
   * startup deadline. GPU admission waits for it; call it once, at boot.
   */
  sweepAtStartup(): Promise<SweepReport>;
  /** Quit: abort the running jobs, let them unwind ~2 s, sweep the ledger; 30 s in all. Never throws. */
  quit(): Promise<SweepReport>;
  /** Begin the background loops. Never awaited. */
  start(): void;
  /** End them (quit). */
  stop(): void;
}

/** The real release-channel and local-engine facts, read through the bootstrap package. */
function processReleaseSources(local: () => Promise<{ status(): Promise<{ state: string; url: string; name: string }> }>, factoryInfo: (url: string) => Promise<string | null>): CrucibleReleaseSources {
  return {
    latest: async () => (await import('@crucible/bootstrap')).latestRelease(),
    running: async () => {
      const controls = await local();
      const status = await controls.status();
      if (status.state === 'absent') return null;
      if (status.state !== 'running') {
        throw new Error(`The Crucible installed on this computer is ${status.state}, so its version could not be read. Start it, or repair it, before installing.`);
      }
      return factoryInfo(status.url);
    },
    compare: (a, b) => {
      // The bootstrap's comparator, loaded on first use with the rest of the package.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return (require('@crucible/bootstrap') as typeof import('@crucible/bootstrap')).compareReleases(a, b);
    },
  };
}

export function createCrucibleContext(deps: CrucibleContextDeps): CrucibleContext {
  const pairingHost = deps.pairingHost ?? processPairingFileHost();
  const push = deps.push ?? {};
  const servers = new CrucibleServers(deps.stateDir, push.serversChanged);
  const factory = new CrucibleClientFactory(servers);
  const probes = new CrucibleProbes(factory, servers);
  const connect = new CrucibleConnect(factory, servers, probes, pairingHost, deps.clipboard);
  const autoConnect = new CrucibleAutoConnect(servers, factory, pairingHost);
  const settings = new CrucibleSettingsBridge(factory);
  // The choice the lanes and the door read: the registry's own, or a CLI's `--server` over it.
  const override = deps.serverOverride;
  const choice = override === undefined ? servers : {
    names: () => servers.names(),
    routingView: () => servers.routingView(),
    fastServer: () => servers.fastServer(),
    onChange: (listener: Parameters<CrucibleServers['onChange']>[0]) => servers.onChange(listener),
    selected: (): string => {
      if (!servers.names().includes(override)) {
        throw new CrucibleRoutingError('unknown_server', `"${override}" is not a registered Crucible server (registered: ${servers.names().join(', ') || 'none'}).`);
      }
      return override;
    },
  };
  const transport = new CrucibleTransport({ servers: choice, factory, probes } satisfies TransportHost, deps.leaseTimings ?? {});

  // THE KEY MOVE, once (plan 6.6). Only into the Crucible the pairing file on
  // THIS computer names, never a remote one; repeated at every start (and on
  // every registry change) until it has happened, so a failure keeps the file
  // and tries again rather than losing the key.
  let lastKeys: KeyMigrationOutcome | null = null;
  let keysRunning: Promise<KeyMigrationOutcome> | null = null;
  const migrateKeys = (resolve?: 'replace' | 'keep'): Promise<KeyMigrationOutcome> => {
    const legacy = deps.legacyKeys;
    if (legacy === undefined) {
      return Promise.resolve({ status: 'nothing', server: null, keyHint: null, openaiDropped: false, message: 'This process moves no keys.' });
    }
    if (keysRunning !== null) return keysRunning;
    keysRunning = migrateLegacyKeys({
      factory,
      file: legacy.file,
      localServer: () => {
        const row = discoveredRow(servers.list(), pairingHost);
        return row.present ? row.registeredAs : null;
      },
      record: legacy.record,
    }, resolve)
      .catch((err: unknown): KeyMigrationOutcome => ({
        status: 'failed', server: null, keyHint: null, openaiDropped: false,
        message: err instanceof Error ? err.message : String(err),
      }))
      .then((outcome) => {
        lastKeys = outcome;
        if (outcome.status !== 'nothing') log.info(`[crucible] api-keys.json: ${outcome.status}: ${outcome.message}`);
        return outcome;
      })
      .finally(() => { keysRunning = null; });
    return keysRunning;
  };
  servers.onChange((change) => {
    if (change.reason === 'added') void migrateKeys();
  });

  const runner = deps.local?.runner ?? ((): Runner => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('@crucible/bootstrap') as typeof import('@crucible/bootstrap')).processRunner();
  });
  const home = deps.local?.home;
  const localControls = deps.local?.localControls ?? (() => processLocalControls(runner, home));
  const host: InstallHost = deps.local?.host ?? processInstallHost(() => discoveredRow(servers.list(), pairingHost));
  const sources: CrucibleReleaseSources = deps.local?.sources ?? processReleaseSources(localControls, async (url) => {
    // The running engine's version, read from the pairing file's token: a
    // registered row may not exist yet (the install face). No token means the
    // version cannot be read, which the gate treats as an error, not as absent.
    const found = (await import('./pairing-file')).readCruciblePairingFile(pairingHost);
    if (found === null) throw new Error(`Crucible is installed at ${url} but left no pairing file, so its version could not be read.`);
    const info = await factory.clientForCredentials(found.pairing.url, found.pairing.token, { timeoutMs: 5_000 }).info({ timeoutMs: 5_000 });
    return info.server.version;
  });
  const local = new CrucibleLocalEngine(
    deps.stateDir,
    servers,
    autoConnect,
    { host, sources, bootstrap: deps.local?.bootstrap ?? loadBootstrap, runner, localControls, ...(home === undefined ? {} : { home }) },
    push.installProgress,
  );
  const readiness = new CrucibleReadiness(servers, probes, local, push.readiness);
  const ledger = InFlightLedger.inDir(deps.stateDir, (line) => log.warn(`[crucible] ${line}`), deps.ledgerFile);
  const lanes = new CrucibleLanes({
    servers: choice,
    clientFor: (name, options) => factory.clientFor(name, options),
    reach: async (name) => {
      const answer = await probes.reach(name);
      return { reach: answer.reach, message: answer.probe.outcome === 'ok' ? answer.probe.facts.busyLine : answer.probe.message };
    },
    ledger,
    push: push.lanes,
    ...deps.lanes,
  });
  const sweep = (reason: string, deadlineMs: number): Promise<SweepReport> =>
    sweepCrucibleInFlight({ ledger, clientFor: (name) => factory.clientFor(name) }, { reason, deadlineMs });

  return {
    servers,
    factory,
    probes,
    connect,
    autoConnect,
    settings,
    local,
    readiness,
    transport,
    keys: { migrate: migrateKeys, last: () => lastKeys },
    pairingHost,
    ledger,
    lanes,
    sweepAtStartup() {
      const swept = sweep('startup: what the last run left behind', STARTUP_SWEEP_DEADLINE_MS);
      lanes.setAdmissionGate(swept);
      return swept;
    },
    quit() {
      return lanes.quit((deadlineMs) => sweep('quit', deadlineMs));
    },
    start() {
      autoConnect.start();
      readiness.start();
      lanes.start();
      void migrateKeys();
    },
    stop() {
      autoConnect.stop();
      readiness.stop();
      lanes.stop();
    },
  };
}
