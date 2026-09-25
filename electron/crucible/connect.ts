/**
 * ADDING A CRUCIBLE SERVER: device-code pairing, a pasted connect code, or the
 * Crucible on this computer. Every path ends the same way: a probe that must
 * answer `ok`, then one registry write.
 *
 * Ported from Briefcase's backend/src/crucible/connect.service.ts (BookForge's
 * connect.ts and connect-code.ts before it).
 *
 * DEVICE-CODE PAIRING (crucible docs/INTEGRATING-AN-APP.md §5.1). The user
 * types an address; `startPairing` returns a short user code; `pollPairing`
 * answers `approved` with a token. On a server with `open_pairing` (the
 * default) the first poll approves. The device code and the token stay here:
 * the renderer holds only a request id and the user code.
 *
 * CONNECT CODES: `crucible://<name>@host:port/#<token>`, parsed by the SDK's
 * `parsePairing`, the one parser of that format. Copying a registered
 * server's code writes it to the clipboard FROM HERE, so the token never
 * crosses into the renderer; the answer carries the line with its token elided.
 */
import * as log from 'electron-log';
import { randomUUID } from 'crypto';
import {
  CruciblePairingError,
  parsePairing,
  pollPairing,
  startPairing,
  type CrucibleClient,
  type Pairing,
  type PairingRequest,
} from '@crucible/client';
import type { CrucibleClientFactory } from './client-factory';
import { connectCodeFor, elideConnectCode } from './connect-code';
import { CrucibleConnectError } from './errors';
import { maskToken } from './registry';
import type { CrucibleServers } from './servers';
import { failureOutcome, type CrucibleProbes } from './probe';
import { readCruciblePairingFile, type PairingFileHost } from './pairing-file';
import type {
  ConnectCodeReading,
  CopiedConnectCode,
  CruciblePairingDecision,
  LocalConnectCodes,
  CruciblePairingPrompt,
  CrucibleServerRow,
} from './wire';

/** How this app names itself on a pairing request, as the server's approval list shows it. */
export const PAIRING_CLIENT_NAME = 'ContentStudio';

/** Writes text to the system clipboard. Electron's in the app; a recorder in a keeper. */
export type ClipboardWriter = (text: string) => void | Promise<void>;

interface Pending {
  controller: AbortController;
  request: PairingRequest;
  expiresAt: number;
  /** The name the user asked this server to be filed under, if any. */
  name?: string;
  polling?: Promise<CruciblePairingDecision>;
}

/** The clock on the local server's `/v1/setup` read: it is loopback, so anything slower is a server not answering. */
const LOCAL_SETUP_TIMEOUT_MS = 5_000;

export class CrucibleConnect {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly factory: CrucibleClientFactory,
    private readonly servers: CrucibleServers,
    private readonly probes: CrucibleProbes,
    private readonly pairingHost: PairingFileHost,
    private readonly clipboard: ClipboardWriter,
  ) {}

  // ── device-code pairing ────────────────────────────────────────────────

  async startPairing(address: string, name?: string): Promise<CruciblePairingPrompt> {
    const requestId = randomUUID();
    const controller = new AbortController();
    const request = await startPairing(address, PAIRING_CLIENT_NAME, { signal: controller.signal });
    const pending: Pending = {
      controller,
      request,
      expiresAt: Date.now() + request.expiresIn * 1000,
      ...(name !== undefined && name.trim() !== '' ? { name: name.trim() } : {}),
    };
    this.pending.set(requestId, pending);
    return {
      requestId,
      name: request.name,
      url: request.url,
      userCode: request.userCode,
      expiresIn: request.expiresIn,
      interval: request.interval,
      approvalRequired: request.approvalRequired,
    };
  }

  /**
   * Ask once. `approved` means the server was probed and registered, and the
   * answer carries the registry name. Concurrent polls of one request share one
   * round trip.
   */
  async pollPairing(requestId: string): Promise<CruciblePairingDecision> {
    const pending = this.pending.get(requestId);
    if (pending === undefined) {
      throw new CrucibleConnectError('pairing_not_active', 'This connection request is no longer active. Enter the address to try again.');
    }
    if (Date.now() >= pending.expiresAt) {
      this.cancelPairing(requestId);
      return { status: 'expired' };
    }
    if (pending.polling) return pending.polling;
    pending.polling = (async (): Promise<CruciblePairingDecision> => {
      const result = await pollPairing(pending.request, { signal: pending.controller.signal });
      if (this.pending.get(requestId) !== pending) {
        throw new CrucibleConnectError('pairing_not_active', 'The connection request was cancelled.');
      }
      if (result.status === 'pending') return result;
      this.cancelPairing(requestId);
      if (result.status !== 'approved') return result;
      const row = await this.probeThenAdd(result.pairing, pending.name);
      return { status: 'approved', name: row.name };
    })();
    try {
      return await pending.polling;
    } finally {
      pending.polling = undefined;
    }
  }

  cancelPairing(requestId: string): void {
    this.pending.get(requestId)?.controller.abort();
    this.pending.delete(requestId);
  }

  // ── connect codes ───────────────────────────────────────────────────────

  /** A pasted line read back with the token masked, for the add form's preview. */
  readConnectCode(line: string): ConnectCodeReading {
    try {
      const pairing = parsePairing(line);
      return { ok: true, name: pairing.name, url: pairing.url, tokenMasked: maskToken(pairing.token) };
    } catch (err) {
      if (err instanceof CruciblePairingError) return { ok: false, code: 'invalid_pairing', message: err.message };
      throw err;
    }
  }

  async addFromConnectCode(line: string, name?: string): Promise<CrucibleServerRow> {
    let pairing: Pairing;
    try {
      pairing = parsePairing(line);
    } catch (err) {
      if (err instanceof CruciblePairingError) throw new CrucibleConnectError('invalid_pairing', err.message);
      throw err;
    }
    return this.probeThenAdd(pairing, name);
  }

  /** Adopt the Crucible on this computer, from its pairing file. */
  async addDiscovered(name?: string): Promise<CrucibleServerRow> {
    const found = readCruciblePairingFile(this.pairingHost);
    if (found === null) {
      throw new CrucibleConnectError('nothing_discovered', 'There is no Crucible on this computer to add.');
    }
    return this.probeThenAdd(found.pairing, name);
  }

  /** Put a registered server's connect code on the clipboard. The token never leaves main. */
  async copyConnectCode(serverName: string): Promise<CopiedConnectCode> {
    const entry = this.servers.getWithToken(serverName);
    return this.copy(connectCodeFor(entry.name, entry.url, entry.token));
  }

  /**
   * THIS computer's Crucible as another machine would reach it: one line per
   * address, token elided.
   *
   * NOT the pairing file's line. That names `127.0.0.1`, which is right for an
   * app on this machine and useless on any other (the Mac binds 0.0.0.0, and
   * its pairing file still says loopback). The server's own `GET /v1/setup`
   * lists the addresses it is dialable on, one per non-loopback interface plus
   * any it advertises (crucible pairing.py `reachable_urls`), so on the Mac a
   * LAN line and a tailnet line: the person picks the one the other machine
   * can reach. The server is asked, never guessed at: a loopback bind has no
   * other address, and that is refused by name.
   */
  async localConnectCodes(): Promise<LocalConnectCodes> {
    const setup = await this.localSetup();
    return {
      server: setup.name,
      lines: setup.urls.map((url, index) => ({ url, elided: elideConnectCode(setup.pairing[index]!) })),
    };
  }

  /** Put the local server's connect code for `url` (one of {@link localConnectCodes}) on the clipboard. */
  async copyLocalConnectCode(url: string): Promise<CopiedConnectCode> {
    const setup = await this.localSetup();
    const index = setup.urls.indexOf(url);
    if (index < 0) {
      throw new CrucibleConnectError(
        'unknown_address',
        `The Crucible on this computer is not reachable at ${url}; it lists ${setup.urls.join(', ')}.`,
      );
    }
    return this.copy(setup.pairing[index]!);
  }

  /** The local server's `/v1/setup`, read with the pairing file's own credentials. */
  private async localSetup(): Promise<{ name: string; urls: readonly string[]; pairing: readonly string[] }> {
    const found = readCruciblePairingFile(this.pairingHost);
    if (found === null) {
      throw new CrucibleConnectError('nothing_discovered', 'There is no Crucible on this computer, so there is no connect code to copy.');
    }
    let setup: Awaited<ReturnType<CrucibleClient['setup']>>;
    try {
      setup = await this.factory
        .clientForCredentials(found.pairing.url, found.pairing.token, { timeoutMs: LOCAL_SETUP_TIMEOUT_MS })
        .setup();
    } catch (err) {
      // Named for what it is, the Crucible on this computer at its pairing address, rather
      // than the IPC block's generic "that server".
      const failure = failureOutcome(err, `the Crucible on this computer (${found.pairing.url})`, LOCAL_SETUP_TIMEOUT_MS);
      throw new CrucibleConnectError(failure.outcome, failure.message);
    }
    if (setup.urls.length === 0 || setup.urls.length !== setup.pairing.length) {
      throw new CrucibleConnectError(
        'not_reachable_elsewhere',
        setup.urls.length === 0
          ? `The Crucible on this computer is bound to ${setup.bind ?? 'an address it did not state'}, so no other computer can reach it. Bind it to 0.0.0.0 (or advertise an address) in its config first.`
          : `The Crucible on this computer listed ${setup.urls.length} address(es) but ${setup.pairing.length} connect code(s), so which code goes with which address is unknown.`,
      );
    }
    return setup;
  }

  private async copy(line: string): Promise<CopiedConnectCode> {
    try {
      await this.clipboard(line);
    } catch (err) {
      throw new CrucibleConnectError('clipboard_unavailable', `The connect code could not be copied: ${(err as Error).message}`);
    }
    return { copied: elideConnectCode(line) };
  }

  /** Probe, and write the registry only when the server answers `ok`. */
  private async probeThenAdd(pairing: Pairing, name?: string): Promise<CrucibleServerRow> {
    const result = await this.probes.probeCredentials(pairing.url, pairing.token, pairing.url);
    if (result.outcome !== 'ok') {
      throw new CrucibleConnectError('probe_failed', result.message);
    }
    const chosen = name !== undefined && name.trim() !== '' ? name : pairing.name;
    const row = this.servers.add({ name: chosen, url: pairing.url, token: pairing.token });
    log.info(`[crucible] Connected "${row.name}" (${result.facts.version ?? 'version unknown'}, ${result.facts.backend ?? 'backend unknown'})`);
    return row;
  }
}
