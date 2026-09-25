/**
 * A WINDOW ONTO ONE SERVER'S OWN SETTINGS: upstream keys, and the one-time
 * "copy my key to <server>".
 *
 * Ported from Briefcase's settings-bridge.service.ts and the key-copy half of
 * its crucible-ai.service.ts. Keys and upstreams live on whichever Crucible
 * serves the call, configured through that server's settings (LEDGER #194:
 * keys live in Crucible, not the app). This proxies `GET /v1/settings`,
 * `PUT /v1/settings` and `POST /v1/settings/upstreams/:name/test` for the
 * pane, and nothing more.
 *
 * NO BODY IS EVER LOGGED: a PUT carries a key on its way in. What comes back
 * carries only `keyHint`, which is the server's own `…abcd`.
 *
 * THE KEY COPY. Until P2 migrates api-keys.json into the local server's
 * settings and deletes it, the app still holds its own Claude key for the
 * cloud calls it makes itself. "Copy my key to <server>" writes that key to
 * the named server, confirms it by the server's read-back hint, and leaves
 * the file alone: deleting it is the migration's job (plan section 6.6), and
 * a key is never pushed to a remote server without this explicit press
 * (LEDGER #194, plan section 0 #20). A differing key already on the server is
 * left as it is and said so, never overwritten.
 */
import * as log from 'electron-log';
import type { SettingsDocument, SettingsPatch } from '@crucible/client';
import type { CrucibleClientFactory } from './client-factory';
import { CrucibleSettingsError } from './errors';
import type { CrucibleServers } from './servers';
import type { CrucibleSettingsPatch, CrucibleSettingsView, KeyCopyOutcome, UpstreamName, UpstreamTestAnswer } from './wire';

export const UPSTREAM_NAMES: readonly UpstreamName[] = ['anthropic', 'openai', 'ollama'];

export function isUpstreamName(value: string): value is UpstreamName {
  return (UPSTREAM_NAMES as readonly string[]).includes(value);
}

/** Does the server's `…abcd` hint name this key? The hint is the server's own tail, compared as it renders it. */
export function hintMatches(hint: string | null | undefined, key: string): boolean {
  if (typeof hint !== 'string' || hint === '') return false;
  const tail = hint.replace(/^[^A-Za-z0-9]+/, '');
  return tail !== '' && key.endsWith(tail);
}

function viewOf(doc: SettingsDocument): CrucibleSettingsView {
  const routes: CrucibleSettingsView['routes'] = {};
  for (const [name, setting] of Object.entries(doc.routes)) routes[name] = { route: setting.route, model: setting.model };
  const { anthropic, openai, ollama } = doc.upstreams;
  return {
    routes,
    // A null card is an upstream this server does not offer: carried as null for the pane to leave out.
    upstreams: {
      anthropic: anthropic === null ? null : { configured: anthropic.configured, keyHint: anthropic.keyHint ?? null },
      openai: openai === null ? null : { configured: openai.configured, keyHint: openai.keyHint ?? null },
      ollama: ollama === null ? null : { configured: ollama.configured, url: ollama.url ?? null },
    },
    localModels: doc.localModels === null ? null : { ...doc.localModels },
    backendKind: doc.backendKind,
  };
}

/** The patch the pane may send, checked for shape. Unknown keys are refused, not dropped. */
export function patchOf(body: unknown): SettingsPatch {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new CrucibleSettingsError('invalid_settings', 'A settings change is an object.');
  }
  const input = body as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (key !== 'upstreams') throw new CrucibleSettingsError('invalid_settings', `"${key}" is not a setting ContentStudio changes.`);
  }
  const patch: { upstreams?: Record<string, { key?: string; url?: string } | null> } = {};
  if (input['upstreams'] !== undefined) {
    const ups = input['upstreams'] as Record<string, unknown>;
    if (typeof ups !== 'object' || ups === null) throw new CrucibleSettingsError('invalid_settings', '"upstreams" is an object.');
    patch.upstreams = {};
    for (const [name, value] of Object.entries(ups)) {
      if (!isUpstreamName(name)) throw new CrucibleSettingsError('invalid_settings', `"${name}" is not an upstream (anthropic, openai, ollama).`);
      if (value === null) { patch.upstreams[name] = null; continue; }
      const v = value as Record<string, unknown>;
      const entry: { key?: string; url?: string } = {};
      if (typeof v['key'] === 'string') entry.key = v['key'];
      if (typeof v['url'] === 'string') entry.url = v['url'];
      patch.upstreams[name] = entry;
    }
  }
  return patch as SettingsPatch;
}

/** The app's own Claude key, read fresh each time; undefined when there is none. Never handed to the renderer. */
export type LegacyClaudeKey = () => string | undefined;

export class CrucibleSettingsBridge {
  constructor(
    private readonly factory: CrucibleClientFactory,
    private readonly servers: CrucibleServers,
    private readonly legacyClaudeKey: LegacyClaudeKey,
  ) {}

  async get(server: string): Promise<CrucibleSettingsView> {
    const client = await this.factory.clientFor(server);
    return viewOf(await client.settings());
  }

  async put(server: string, body: CrucibleSettingsPatch): Promise<CrucibleSettingsView> {
    const patch = patchOf(body);
    const client = await this.factory.clientFor(server);
    return viewOf(await client.putSettings(patch));
  }

  async testUpstream(server: string, upstream: string, body: unknown): Promise<UpstreamTestAnswer> {
    if (!isUpstreamName(upstream)) throw new CrucibleSettingsError('invalid_settings', `"${upstream}" is not an upstream (anthropic, openai, ollama).`);
    const input = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const probe: { key?: string; url?: string } = {};
    if (typeof input['key'] === 'string' && input['key'] !== '') probe.key = input['key'];
    if (typeof input['url'] === 'string' && input['url'] !== '') probe.url = input['url'];
    const client = await this.factory.clientFor(server);
    const result = await client.testUpstream(upstream, Object.keys(probe).length === 0 ? undefined : probe);
    return result.ok ? { ok: true, models: [...result.models] } : { ok: false, code: result.code, message: result.message };
  }

  /** Copy the app's own Claude key onto the named server. Explicit, one server, never the file's deletion (P2's). */
  async copyClaudeKeyTo(server: string): Promise<KeyCopyOutcome> {
    if (!this.servers.names().includes(server)) {
      throw new CrucibleSettingsError('unknown_server', `"${server}" is not one of this computer's Crucible servers.`);
    }
    const key = this.legacyClaudeKey();
    if (key === undefined || key.trim() === '') {
      throw new CrucibleSettingsError('nothing_to_copy', 'ContentStudio has no Claude key of its own to copy. Paste one on the server instead.');
    }
    const before = await this.get(server);
    const current = before.upstreams.anthropic;
    if (current === null) {
      return { server, copied: false, alreadyThere: false, skipped: `"${server}" does not offer Claude via Crucible, so the key was not copied there.` };
    }
    if (current.configured && hintMatches(current.keyHint, key)) {
      return { server, copied: false, alreadyThere: true, skipped: null };
    }
    if (current.configured) {
      return {
        server,
        copied: false,
        alreadyThere: false,
        skipped: `"${server}" already has a different Claude key (${current.keyHint ?? 'set'}), so it was left as it is. Remove it there first if you want this one.`,
      };
    }
    // NEVER LOGGED: the patch carries the key.
    await this.put(server, { upstreams: { anthropic: { key } } });
    // Read back: the key counts as copied only when the server shows its hint.
    const after = await this.get(server);
    const card = after.upstreams.anthropic;
    const confirmed = card !== null && card.configured && hintMatches(card.keyHint, key);
    log.info(`[crucible] Claude key copy to "${server}": ${confirmed ? 'confirmed by the server' : 'NOT confirmed by the server'}`);
    return confirmed
      ? { server, copied: true, alreadyThere: false, skipped: null }
      : { server, copied: false, alreadyThere: false, skipped: `"${server}" did not confirm the Claude key after saving it.` };
  }
}
