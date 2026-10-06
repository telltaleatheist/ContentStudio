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
 * Nothing in here touches the network. `start()` begins auto-connect and
 * readiness's first derivation, fire-and-forget; readiness's timer and the
 * lanes' event streams then run only while work is queued (readiness.ts
 * `needsPolling`, LEDGER #234). `stop()` ends them on quit. None is ever
 * awaited by `app.whenReady`.
 *
 * P3 adds the queue's layer over the same state directory: the in-flight
 * ledger (`<userData>/crucible-in-flight.json`), the queue sessions this install
 * holds (session.ts, LEDGER #255: one per server, joined, never doubled), the
 * lanes, and the two sweeps. `sweepAtStartup()` gives back what a kill left
 * behind and GATES GPU admission until it settles (plan section 13.4); `quit()`
 * aborts the running jobs, lets them unwind, closes the sessions still open,
 * then sweeps under the quit deadline.
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
import { crucibleAsrVenue } from './asr-venue';
import type { AsrVenue } from './asr';
import { ServerSessions, type CardTimings } from './session';
import type { QueuePosition } from '@crucible/client';
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
  /** Only a keeper passes this: a short `idle_s` and short clocks for the load stream's reconnect. */
  sessionTimings?: Partial<CardTimings> & { idleS?: number };
  /** Pushes to every renderer window. Default: nothing (a keeper). */
  push?: {
    serversChanged?: (change: CrucibleServersChangedPayload) => void;
    readiness?: (view: CrucibleReadinessView) => void;
    installProgress?: (event: CrucibleInstallProgress) => void;
    lanes?: (view: CrucibleLanesView) => void;
    /** A queue job's session moved in its server's line (`position`), or opened (null): its row says so. */
    inLine?: (jobId: string, server: string, position: QueuePosition | null) => void;
    /** A batch member's waiting line at a stage gate (batch.ts), or null once its turn came. */
    batchWait?: (jobId: string, line: string | null) => void;
  };
  /**
   * A CLI's `--server`: this process sends its work to that registered server instead of the
   * selected one, and the routing record is never written. Refused by name when unregistered.
   */
  serverOverride?: string;
  /**
   * The server the model routing names (`metadataRouting.server`, LEDGER #222), judged against
   * this registry, or null when it names none. Given the registry's names so the reader can drop
   * a forgotten one with its line. Required, so no process can leave it out by accident: main.ts
   * reads the store; a CLI and a keeper that route nothing say `() => null` (a CLI's own choice
   * of server arrives as `serverOverride`, computed by the same rule, venue-decision.ts).
   */
  routingServer: (registered: readonly string[]) => string | null;
  /** The ledger's file name under `stateDir`. Default `crucible-in-flight.json`; a CLI names its own. */
  ledgerFile?: string;
  /** The lanes' clocks, replaceable by a keeper. */
  lanes?: { now?: () => number; stallMs?: number; watchRetryMs?: number; touchEveryMs?: number };
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
  /** Where transcription runs (P5's `setAsrVenueResolver`): the job's venue or the selected server. */
  asrVenue: () => AsrVenue;
  /** The api-keys.json move (plan 6.6): run it, answer its question, read what it last said. */
  keys: {
    migrate(resolve?: 'replace' | 'keep'): Promise<KeyMigrationOutcome>;
    last(): KeyMigrationOutcome | null;
  };
  pairingHost: PairingFileHost;
  ledger: InFlightLedger;
  /** Every queue session this install holds, one per server (session.ts). */
  sessions: ServerSessions;
  lanes: CrucibleLanes;
  /** The model routing's server as the lanes read it (LEDGER #222), for the Settings pane's view. */
  routingServer(): string | null;
  /**
   * Give back every hold the ledger lists (what a kill left behind), under the
   * startup deadline. GPU admission waits for it; call it once, at boot.
   */
  sweepAtStartup(): Promise<SweepReport>;
  /** Quit: abort the running jobs, let them unwind ~2 s, close the sessions still open, sweep the ledger; 30 s in all. Never throws. */
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
  let readinessRef: CrucibleReadiness | null = null;
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
  // THE ROUTING'S SERVER IS EVERY ACTION'S SERVER (Owen 2026-09-29: "whatever crucible server i
  // have selected in model routing is the one that should be used for every action"; his
  // thumbnails had waited on a busy Mac while the routing named WSL). Without a CLI override,
  // "the selected server" every door reads (lanes, transport, ASR) is the routing's server when
  // it names one, else the registry's selection.
  const routingServer = (): string | null => deps.routingServer(servers.names());
  const choice = {
    names: () => servers.names(),
    routingView: () => servers.routingView(),
    fastServer: () => servers.fastServer(),
    onChange: (listener: Parameters<CrucibleServers['onChange']>[0]) => servers.onChange(listener),
    selected: (): string => {
      if (override === undefined) return routingServer() ?? servers.selected();
      if (!servers.names().includes(override)) {
        throw new CrucibleRoutingError('unknown_server', `"${override}" is not a registered Crucible server (registered: ${servers.names().join(', ') || 'none'}).`);
      }
      return override;
    },
  };
  const transport = new CrucibleTransport({ servers: choice, factory, probes } satisfies TransportHost);

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
    (event) => {
      push.installProgress?.(event);
      // An install under way keeps readiness checking until it ends (LEDGER #234).
      readinessRef?.installEvent(event.kind);
    },
  );
  const readiness = new CrucibleReadiness(servers, probes, local, push.readiness);
  readinessRef = readiness;
  const ledger = InFlightLedger.inDir(deps.stateDir, (line) => log.warn(`[crucible] ${line}`), deps.ledgerFile);
  const { idleS, ...cardTimings } = deps.sessionTimings ?? {};
  const sessions = new ServerSessions({
    client: (name) => factory.clientFor(name),
    ledger,
    timings: cardTimings,
    ...(idleS === undefined ? {} : { idleS }),
  });
  const lanes = new CrucibleLanes({
    servers: choice,
    routingServer,
    clientFor: (name, options) => factory.clientFor(name, options),
    reach: async (name, maxAgeMs) => {
      const answer = await probes.reach(name, maxAgeMs);
      return { reach: answer.reach, message: answer.probe.outcome === 'ok' ? answer.probe.facts.busyLine : answer.probe.message };
    },
    ledger,
    sessions,
    push: push.lanes,
    ...(push.inLine === undefined ? {} : { onInLine: push.inLine }),
    ...(push.batchWait === undefined ? {} : { onBatchWait: push.batchWait }),
    // THE POLLING RULE's wiring (readiness.ts `needsPolling`, LEDGER #234): the lanes' work
    // feeds it, and it switches the lanes' event streams. Admission asks readiness for a fresh answer.
    onWorkChange: () => readiness.pollingMayHaveChanged(),
    beforeAdmit: () => readiness.freshCheck(),
    ...deps.lanes,
  });
  readiness.setLaneWork(() => lanes.workCount());
  readiness.onPolling((on) => lanes.setPolling(on));
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
    asrVenue: crucibleAsrVenue({ servers: choice, factory, ledger, sessions: lanes }),
    keys: { migrate: migrateKeys, last: () => lastKeys },
    pairingHost,
    ledger,
    sessions,
    lanes,
    routingServer,
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
