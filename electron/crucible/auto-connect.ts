/**
 * ADOPT THE CRUCIBLE ON THIS COMPUTER into the ordinary registry, at boot,
 * without anyone typing anything.
 *
 * Ported from Briefcase's backend/src/crucible/auto-connect.service.ts
 * (BookForge's electron/crucible/auto-connect.ts before it). The rule, from
 * crucible docs/INTEGRATING-AN-APP.md §5.1 and plan section 4:
 *
 *  - adopt the pairing file ONLY when no registry exists yet. An existing but
 *    empty registry may be a user who removed the server on purpose;
 *  - and only after `/v1/info` answers with the pairing's own name and API
 *    version 1 (a bad token or a non-Crucible never gets a row);
 *  - after an install, adopt unconditionally.
 *
 * The row is named what the server calls itself (`crucible@owens-mac-studio`),
 * like any other server: a server on this computer is not a different kind of
 * server.
 *
 * BOOT TOLERANCE. This is never awaited by `app.whenReady`. It is started after
 * the window is up, as a fire-and-forget promise that logs its result, so a
 * missing, stopped or asleep Crucible cannot block or slow startup (plan
 * section 0a: everything non-AI boots with no server at all). When nothing
 * answered, it asks again a few times (a login item can start ContentStudio
 * before the Crucible service is up), and only while no registry exists.
 */
import * as log from 'electron-log';
import type { Pairing } from '@crucible/client';
import type { CrucibleClientFactory } from './client-factory';
import { readCruciblePairingFile, type PairingFileHost } from './pairing-file';
import { originKey } from './registry';
import type { CrucibleServers } from './servers';
import { PROBE_TIMEOUT_MS, failureOutcome } from './probe';

export interface AutoConnectDeps {
  registryExists(): boolean;
  pairing(): Pairing | null;
  list(): Array<{ name: string; url: string }>;
  /** Throws, by name, unless the pairing's server answers `info` as itself on API 1. */
  verify(pairing: Pairing): Promise<void>;
  add(pairing: Pairing): { name: string };
}

export class AutoConnectMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutoConnectMismatch';
  }
}

/**
 * The registry name the local pairing is filed under, or null when there is
 * nothing to adopt (or a registry already exists and this is not after an install).
 */
export async function autoConnectLocal(afterInstall: boolean, deps: AutoConnectDeps): Promise<string | null> {
  if (!afterInstall && deps.registryExists()) return null;
  const pairing = deps.pairing();
  if (pairing === null) {
    if (afterInstall) {
      throw new Error('Crucible installed but did not publish how to reach it. In Settings › Crucible Servers, press Re-check.');
    }
    return null;
  }
  const sameAddress = deps.list().find((row) => originKey(row.url) === originKey(pairing.url));
  if (sameAddress) return sameAddress.name;
  await deps.verify(pairing);
  // Re-read after verification: another connection may have landed meanwhile.
  const existing = deps.list().find((row) => originKey(row.url) === originKey(pairing.url));
  if (existing) return existing.name;
  return deps.add(pairing).name;
}

/** Delays between boot attempts while nothing answers and no registry exists. */
export const AUTO_CONNECT_RETRY_MS = [15_000, 60_000, 300_000];

export class CrucibleAutoConnect {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private idleWaiters: Array<() => void> = [];
  /** Replaceable by a keeper. */
  retryDelaysMs: readonly number[] = AUTO_CONNECT_RETRY_MS;

  constructor(
    private readonly servers: CrucibleServers,
    private readonly factory: CrucibleClientFactory,
    private readonly pairingHost: PairingFileHost,
  ) {}

  /** Begin the boot-time attempts. Never awaited: startup must not wait on a Crucible that may not be there. */
  start(): void {
    this.schedule(0, 0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.notifyIfIdle();
  }

  /**
   * Resolves once the boot-time attempts are over: nothing running and no
   * retry scheduled, whatever they concluded. For callers (and keepers) that
   * must see the outcome, instead of guessing how long it takes.
   */
  whenIdle(): Promise<void> {
    if (!this.running && this.timer === null) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private notifyIfIdle(): void {
    if (this.running || this.timer !== null) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private schedule(delayMs: number, attempt: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.running = true;
      void this.attempt(attempt).finally(() => {
        this.running = false;
        this.notifyIfIdle();
      });
    }, delayMs);
    this.timer.unref?.();
  }

  private async attempt(attempt: number): Promise<void> {
    try {
      const name = await this.run(false);
      if (name !== null) log.info(`[crucible] The Crucible on this computer is connected as "${name}"`);
    } catch (err) {
      const unreachable = failureOutcome(err, 'the Crucible on this computer').outcome === 'unreachable';
      log.info(`[crucible] Did not connect the Crucible on this computer: ${(err as Error).message}`);
      const next = this.retryDelaysMs[attempt];
      if (unreachable && next !== undefined && !this.servers.exists()) this.schedule(next, attempt + 1);
    }
  }

  /** One pass. Resolves to the registry name, or null when there was nothing to do. */
  run(afterInstall = false): Promise<string | null> {
    return autoConnectLocal(afterInstall, this.deps());
  }

  deps(): AutoConnectDeps {
    return {
      registryExists: () => this.servers.exists(),
      pairing: () => readCruciblePairingFile(this.pairingHost)?.pairing ?? null,
      list: () => this.servers.list(),
      verify: async (pairing) => {
        const info = await this.factory
          .clientForCredentials(pairing.url, pairing.token, { timeoutMs: PROBE_TIMEOUT_MS })
          .info({ timeoutMs: PROBE_TIMEOUT_MS });
        if (info.server.name !== pairing.name || info.server.apiVersion !== 1) {
          throw new AutoConnectMismatch(
            `The Crucible answering at ${pairing.url} is "${info.server.name}" on API ${info.server.apiVersion}, `
              + `not the "${pairing.name}" its pairing file names. Add it by hand in Settings › Crucible Servers.`,
          );
        }
      },
      add: (pairing) => this.servers.add({ name: pairing.name, url: pairing.url, token: pairing.token }),
    };
  }
}
