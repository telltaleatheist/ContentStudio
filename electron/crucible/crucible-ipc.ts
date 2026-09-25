/**
 * Crucible IPC
 *
 * The channels the Settings › Crucible Servers pane talks to, registered in one
 * call the way setupPublishIpc and setupSpreakerIpc are. Namespaced `crucible:*`.
 *
 * NO ANSWER HERE CARRIES A TOKEN. Rows carry `tokenMasked`, connect codes come
 * back elided, and settings carry the server's `keyHint`. The registry's
 * token-bearing read is used only by the client factory, which this block
 * never hands anything but a name (wire.ts, first paragraph).
 *
 * Every refusal comes back as `{success: false, code, error}` (the
 * CrucibleIpcResult envelope): the code says which refusal it is, and the
 * sentence always carries the fix. Nothing is thrown across the boundary,
 * because Electron would flatten it to a string the renderer would have to
 * parse (Law 10).
 *
 * Pushes, to every window: `crucible:servers-changed`, `crucible:readiness`
 * and `crucible:install-progress`. They are wired in main.ts through the
 * context's `push` deps; this block only registers the request channels.
 */
import { ipcMain } from 'electron';
import * as log from 'electron-log';
import { CrucibleConnectionError, CrucibleError } from '@crucible/client';
import type { CrucibleContext } from './context';
import { discoveredRow } from './discovery';
import { CrucibleConnectError, CrucibleRegistryError, CrucibleRoutingError, CrucibleSettingsError } from './errors';
import { CrucibleInstallError, installRefusalOf } from './install';
import { failureOutcome } from './probe';
import type { AddServerRequest, CrucibleIpcResult, CrucibleSettingsPatch } from './wire';

function ok<T>(data: T): CrucibleIpcResult<T> {
  return { success: true, data };
}
function refusal(code: string, error: string): CrucibleIpcResult<never> {
  return { success: false, code, error };
}

/** Turn any failure into a named refusal. Never lets a raw SDK error (or its URL) through unshaped. */
async function guard<T>(what: string, work: () => Promise<T> | T): Promise<CrucibleIpcResult<T>> {
  try {
    return ok(await work());
  } catch (err) {
    if (err instanceof CrucibleRegistryError || err instanceof CrucibleRoutingError || err instanceof CrucibleConnectError
      || err instanceof CrucibleSettingsError || err instanceof CrucibleInstallError) {
      return refusal(err.code, err.message);
    }
    if (err instanceof CrucibleConnectionError) return refusal(err.code, err.message);
    if (err instanceof CrucibleError || err instanceof Error) {
      // An install refusal from the bootstrap package crosses in its own words.
      const carried = err as { code?: unknown };
      if (typeof carried.code === 'string' && /^(host_|install_|crucible_already|release_|not_hostable)/.test(carried.code)) {
        const shaped = installRefusalOf(err);
        return refusal(shaped.code, shaped.message);
      }
      const failure = failureOutcome(err, 'That Crucible server');
      log.warn(`[crucible] ${what} refused: ${failure.outcome}: ${failure.message}`);
      return refusal(failure.outcome, failure.message);
    }
    return refusal('refused', String(err));
  }
}

function requireName(name: unknown): string {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new CrucibleRegistryError('invalid_name', 'A server name is required.');
  }
  return name;
}

export function setupCrucibleIpc(context: CrucibleContext): void {
  if (!context || typeof context.servers?.list !== 'function') {
    throw new Error('setupCrucibleIpc requires a CrucibleContext.');
  }
  const { servers, probes, connect, settings, local, readiness, pairingHost } = context;

  // ── the list ────────────────────────────────────────────────────────────

  ipcMain.handle('crucible:servers', () => guard('list', () => {
    const rows = servers.list();
    return { servers: rows, routing: servers.routingView(), discovered: discoveredRow(rows, pairingHost) };
  }));

  /** A probe at most 15 s old (the pane's first paint). */
  ipcMain.handle('crucible:probe', (_event, name: unknown) => guard('probe', () => probes.reach(requireName(name))));

  /** A probe taken now: the Test button. Drops the cached orchestrator hop too. */
  ipcMain.handle('crucible:test', (_event, name: unknown) => guard('test', () => probes.test(requireName(name))));

  ipcMain.handle('crucible:add', (_event, body: unknown) => guard('add', async () => {
    const request = body as Partial<AddServerRequest & { connectCode: string; discovered: boolean; name?: string }> | null;
    if (request === null || typeof request !== 'object') {
      throw new CrucibleConnectError('invalid_pairing', 'Say what to add: a connect code, or the Crucible on this computer.');
    }
    const name = typeof request.name === 'string' && request.name.trim() !== '' ? request.name : undefined;
    if (typeof request.connectCode === 'string') return connect.addFromConnectCode(request.connectCode, name);
    if (request.discovered === true) return connect.addDiscovered(name);
    throw new CrucibleConnectError('invalid_pairing', 'Say what to add: a connect code, or the Crucible on this computer.');
  }));

  ipcMain.handle('crucible:remove', (_event, name: unknown) => guard('remove', () => servers.remove(requireName(name))));

  /** Switch servers: all work not yet started goes to this one. */
  ipcMain.handle('crucible:select', (_event, name: unknown) => guard('select', () => servers.select(requireName(name))));

  /** Pin (or unpin, with null) the fast server. */
  ipcMain.handle('crucible:set-fast', (_event, name: unknown) => guard('set-fast', () => servers.setFast(name === null ? null : requireName(name))));

  /** The Running/Paused switch. A paused server's work waits; it never moves to another server. */
  ipcMain.handle('crucible:set-paused', (_event, name: unknown, paused: unknown) => guard('set-paused', () => {
    if (typeof paused !== 'boolean') throw new CrucibleRoutingError('invalid_choice', 'Say whether the server is paused (true) or running (false).');
    return servers.setPaused(requireName(name), paused);
  }));

  // ── adding a server ─────────────────────────────────────────────────────

  ipcMain.handle('crucible:pair-start', (_event, body: unknown) => guard('pair-start', () => {
    const request = body as { address?: unknown; name?: unknown } | null;
    if (typeof request?.address !== 'string' || request.address.trim() === '') {
      throw new CrucibleConnectError('invalid_address', 'Type the other computer\'s name or address.');
    }
    return connect.startPairing(request.address.trim(), typeof request.name === 'string' ? request.name : undefined);
  }));

  ipcMain.handle('crucible:pair-poll', (_event, requestId: unknown) => guard('pair-poll', () => {
    if (typeof requestId !== 'string') throw new CrucibleConnectError('pairing_not_active', 'This connection request is no longer active.');
    return connect.pollPairing(requestId);
  }));

  ipcMain.handle('crucible:pair-cancel', (_event, requestId: unknown) => guard('pair-cancel', () => {
    if (typeof requestId === 'string') connect.cancelPairing(requestId);
    return { cancelled: true as const };
  }));

  /** A pasted line read back with the token masked, for the add form's preview. */
  ipcMain.handle('crucible:connect-code-read', (_event, line: unknown) => guard('connect-code-read', () =>
    connect.readConnectCode(typeof line === 'string' ? line : '')));

  /** Copy a registered server's connect code to the clipboard (the token never enters the renderer). */
  ipcMain.handle('crucible:connect-code-copy', (_event, name: unknown) => guard('connect-code-copy', () => connect.copyConnectCode(requireName(name))));

  /** Copy THIS computer's Crucible connect code, for pasting into ContentStudio on another machine. */
  ipcMain.handle('crucible:connect-codes-local', () => guard('connect-codes-local', () => connect.localConnectCodes()));
  ipcMain.handle('crucible:connect-code-copy-local', (_event, url: unknown) => guard('connect-code-copy-local', () => {
    if (typeof url !== 'string' || url === '') throw new CrucibleConnectError('unknown_address', 'Say which of this computer\'s addresses to copy the code for.');
    return connect.copyLocalConnectCode(url);
  }));

  // ── one server's own settings: keys ─────────────────────────────────────

  ipcMain.handle('crucible:settings-get', (_event, name: unknown) => guard('settings-get', () => settings.get(requireName(name))));

  ipcMain.handle('crucible:settings-put', (_event, name: unknown, patch: unknown) => guard('settings-put', () =>
    settings.put(requireName(name), patch as CrucibleSettingsPatch)));

  ipcMain.handle('crucible:upstream-test', (_event, name: unknown, upstream: unknown, probe: unknown) => guard('upstream-test', () =>
    settings.testUpstream(requireName(name), typeof upstream === 'string' ? upstream : '', probe)));

  /**
   * The api-keys.json move (plan 6.6): what it last said, and the pane's answer
   * when the server already held a different key ("stop and ask"). The key never
   * crosses; only the server's hint does.
   */
  ipcMain.handle('crucible:key-migration', () => guard('key-migration', () => context.keys.last()));
  ipcMain.handle('crucible:key-migration-resolve', (_event, choice: unknown) => guard('key-migration-resolve', () => {
    if (choice !== 'replace' && choice !== 'keep') {
      throw new CrucibleSettingsError('invalid_settings', 'Say whether to replace the server\'s Claude key with ContentStudio\'s ("replace") or keep the server\'s ("keep").');
    }
    return context.keys.migrate(choice);
  }));

  // ── the local engine and the doors ──────────────────────────────────────

  ipcMain.handle('crucible:setup', () => guard('setup', () => local.setup()));
  ipcMain.handle('crucible:install-status', () => guard('install-status', () => local.status()));
  ipcMain.handle('crucible:install-start', () => guard('install-start', () => local.start()));
  ipcMain.handle('crucible:release-check', () => guard('release-check', () => local.checkRelease()));
  ipcMain.handle('crucible:local-presence', () => guard('local-presence', () => local.presence()));

  // ── readiness ───────────────────────────────────────────────────────────

  ipcMain.handle('crucible:readiness', () => guard('readiness', () => readiness.current()));
  ipcMain.handle('crucible:readiness-refresh', () => guard('readiness-refresh', () => readiness.refresh()));
  ipcMain.handle('crucible:readiness-decline', () => guard('readiness-decline', () => readiness.decline()));
  /** The Start door: the ONE way the app starts the Crucible on this computer, so readiness says `starting` while it does. */
  ipcMain.handle('crucible:readiness-start', () => guard('readiness-start', () => readiness.startLocal()));

  log.info('[crucible] IPC handlers registered');
}
