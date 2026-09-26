/**
 * A WINDOW ONTO ONE SERVER'S OWN SETTINGS: upstream keys.
 *
 * Ported from Briefcase's settings-bridge.service.ts. Keys and upstreams live
 * on whichever Crucible serves the call, configured through that server's
 * settings (LEDGER #194: keys live in Crucible, not the app). This proxies
 * `GET /v1/settings`, `PUT /v1/settings` and
 * `POST /v1/settings/upstreams/:name/test` for the pane's per-server key entry
 * (Test, then Save), and nothing more. It is BookForge's engine-settings.ts
 * projection in Briefcase's shape: the renderer sees `keyHint`, never a key.
 *
 * NO BODY IS EVER LOGGED: a PUT carries a key on its way in. What comes back
 * carries only `keyHint`, which is the server's own `…abcd`.
 *
 * THE APP HOLDS NO KEY ANY MORE (P2). P1's "copy my key to <server>" copied the
 * app's own key out of api-keys.json; P2 moves that file into the Crucible on
 * this computer once (key-migration.ts) and deletes it, and a server never
 * hands a key back (only its hint), so there is nothing left to copy. A key for
 * another server is typed into that server's row (P1's open question 2).
 */
import type { SettingsDocument, SettingsPatch } from '@crucible/client';
import type { CrucibleClientFactory } from './client-factory';
import { CrucibleSettingsError } from './errors';
import type { CrucibleSettingsPatch, CrucibleSettingsView, UpstreamName, UpstreamTestAnswer } from './wire';

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

export class CrucibleSettingsBridge {
  constructor(private readonly factory: CrucibleClientFactory) {}

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
}
