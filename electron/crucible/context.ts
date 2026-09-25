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
 * Nothing in here touches the network. `start()` begins the two background
 * loops (auto-connect and readiness), both fire-and-forget; `stop()` ends them
 * on quit. Neither is ever awaited by `app.whenReady`.
 */
import type { Runner } from '@crucible/bootstrap';
import { CrucibleAutoConnect } from './auto-connect';
import { CrucibleClientFactory } from './client-factory';
import { CrucibleConnect, type ClipboardWriter } from './connect';
import { discoveredRow } from './discovery';
import { processLocalControls } from './engine-presence';
import { loadBootstrap, processInstallHost, type CrucibleReleaseSources, type InstallHost } from './install';
import { CrucibleLocalEngine, type LocalEngineDeps } from './local-engine';
import { processPairingFileHost, type PairingFileHost } from './pairing-file';
import { CrucibleProbes } from './probe';
import { CrucibleReadiness } from './readiness';
import { CrucibleServers } from './servers';
import { CrucibleSettingsBridge, type LegacyClaudeKey } from './settings-bridge';
import type { CrucibleInstallProgress, CrucibleReadinessView, CrucibleServersChangedPayload } from './wire';

export interface CrucibleContextDeps {
  /** Where crucible-servers.json, crucible-routing.json and crucible-install-state.json live. */
  stateDir: string;
  /** Where the pairing file is read from. Default: this process's platform, env and home. */
  pairingHost?: PairingFileHost;
  clipboard: ClipboardWriter;
  /** The app's own Claude key, for "copy my key to <server>". Never handed to the renderer. */
  legacyClaudeKey: LegacyClaudeKey;
  /** Pushes to every renderer window. Default: nothing (a keeper). */
  push?: {
    serversChanged?: (change: CrucibleServersChangedPayload) => void;
    readiness?: (view: CrucibleReadinessView) => void;
    installProgress?: (event: CrucibleInstallProgress) => void;
  };
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
  pairingHost: PairingFileHost;
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
  const settings = new CrucibleSettingsBridge(factory, servers, deps.legacyClaudeKey);

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

  return {
    servers,
    factory,
    probes,
    connect,
    autoConnect,
    settings,
    local,
    readiness,
    pairingHost,
    start() {
      autoConnect.start();
      readiness.start();
    },
    stop() {
      autoConnect.stop();
      readiness.stop();
    },
  };
}
