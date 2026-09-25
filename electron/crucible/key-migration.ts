/**
 * api-keys.json -> THE CRUCIBLE ON THIS COMPUTER, ONCE (plan 6.6, LEDGER #194:
 * keys live in Crucible, not the app).
 *
 * Ported from Briefcase's llm/legacy-api-keys.ts (read the old file for one
 * thing only, never rewrite it, delete it once the server has confirmed the
 * key) and P1's settings-bridge key copy (confirm by the server's read-back
 * hint; a differing key already on the server is never overwritten), with the
 * plan's order:
 *
 *   1. Only the LOCAL server: the registered row the pairing file on this
 *      computer names (discovery.ts). A key is never pushed to a remote server
 *      automatically (#194, plan 0 #20).
 *   2. `GET /v1/settings`. A configured Anthropic key whose hint differs from
 *      ours: STOP AND ASK in the Servers pane. The server is shared with
 *      BookForge, Foundry and Briefcase, and theirs may be the one in use.
 *      The same key already there: nothing to write.
 *   3. `testUpstream('anthropic', {key})`, then `putSettings`.
 *   4. `GET` again; the key counts as moved only when the server shows its hint.
 *   5. Only then is api-keys.json deleted and `keysMigratedTo` recorded.
 *
 * On any failure the file stays and the attempt repeats at the next boot. The
 * OpenAI key is not migrated (`openai:` is removed, #194); the outcome says it
 * was dropped, so the pane can say so.
 *
 * NO KEY IS EVER LOGGED OR RETURNED. Outcomes carry the server's `keyHint` only.
 */
import * as fs from 'fs';
import * as log from 'electron-log';
import type { CrucibleClientFactory } from './client-factory';
import { hintMatches } from './settings-bridge';
import type { KeyMigrationOutcome } from './wire';

export interface KeyMigrationDeps {
  factory: Pick<CrucibleClientFactory, 'clientFor'>;
  /** `<userData>/api-keys.json`. */
  file: string;
  /** The registered name of the Crucible on THIS computer, or null when none is registered. */
  localServer: () => string | null;
  /** Where `keysMigratedTo` is read and written (the app's store; a keeper's object). */
  record: { get(): string | null; set(server: string): void };
}

interface LegacyKeys {
  claude: string | null;
  openai: string | null;
}

/** The two keys the old file held, read fresh. A file that is not JSON is refused by name; it is never rewritten. */
export function readLegacyKeys(file: string): LegacyKeys | null {
  if (!fs.existsSync(file)) return null;
  let parsed: { claudeApiKey?: unknown; openaiApiKey?: unknown };
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    throw new Error(`${file} is not readable JSON (${(err as Error).message}); it was left exactly as it is.`);
  }
  const key = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);
  return { claude: key(parsed.claudeApiKey), openai: key(parsed.openaiApiKey) };
}

/**
 * Run the migration once. `resolve` is the pane's answer to a differing key:
 * `replace` writes ours over it, `keep` leaves the server's and retires the
 * file. Without it a differing key stops the migration and says so.
 */
export async function migrateLegacyKeys(deps: KeyMigrationDeps, resolve?: 'replace' | 'keep'): Promise<KeyMigrationOutcome> {
  const keys = readLegacyKeys(deps.file);
  if (keys === null) return { status: 'nothing', server: null, keyHint: null, openaiDropped: false, message: 'There is no api-keys.json to move.' };
  const openaiDropped = keys.openai !== null;
  const server = deps.localServer();
  if (server === null) {
    return {
      status: 'waiting', server: null, keyHint: null, openaiDropped,
      message: 'api-keys.json is kept until the Crucible on this computer is added; keys are never sent to another computer on their own.',
    };
  }
  const retire = (why: string): void => {
    fs.rmSync(deps.file, { force: true });
    deps.record.set(server);
    log.info(`[crucible] api-keys.json retired after ${why}; keysMigratedTo = "${server}"${openaiDropped ? ' (the OpenAI key was dropped: openai: is removed)' : ''}`);
  };
  try {
    const client = await deps.factory.clientFor(server);
    if (keys.claude === null) {
      retire('it held no Claude key');
      return { status: 'migrated', server, keyHint: null, openaiDropped, message: `api-keys.json held no Claude key${openaiDropped ? '; its OpenAI key was dropped (OpenAI is no longer a provider)' : ''}. The file is gone.` };
    }
    const before = (await client.settings()).upstreams.anthropic;
    if (before === null) {
      return { status: 'failed', server, keyHint: null, openaiDropped, message: `"${server}" does not offer Claude, so the key was kept in api-keys.json.` };
    }
    if (before.configured && hintMatches(before.keyHint, keys.claude)) {
      retire('the server already held the same key');
      return { status: 'migrated', server, keyHint: before.keyHint ?? null, openaiDropped, message: `"${server}" already had this Claude key (${before.keyHint}). api-keys.json is gone.` };
    }
    if (before.configured && resolve === undefined) {
      return {
        status: 'differing_key', server, keyHint: before.keyHint ?? null, openaiDropped,
        message: `"${server}" already has a different Claude key (${before.keyHint ?? 'set'}), shared with the other apps on it. ` +
          'Keep the server\'s, or replace it with the one ContentStudio had.',
      };
    }
    if (before.configured && resolve === 'keep') {
      retire('the operator kept the server\'s own key');
      return { status: 'migrated', server, keyHint: before.keyHint ?? null, openaiDropped, message: `Kept "${server}"'s own Claude key (${before.keyHint}). api-keys.json is gone.` };
    }
    // NEVER LOGGED: the probe and the patch carry the key.
    const tested = await client.testUpstream('anthropic', { key: keys.claude });
    if (!tested.ok) {
      return { status: 'failed', server, keyHint: null, openaiDropped, message: `"${server}" refused the Claude key (${tested.code}: ${tested.message}); api-keys.json is kept.` };
    }
    await client.putSettings({ upstreams: { anthropic: { key: keys.claude } } });
    const after = (await client.settings()).upstreams.anthropic;
    if (after === null || !after.configured || !hintMatches(after.keyHint, keys.claude)) {
      return { status: 'failed', server, keyHint: after?.keyHint ?? null, openaiDropped, message: `"${server}" did not confirm the Claude key after saving it; api-keys.json is kept and the move is tried again at the next start.` };
    }
    retire('the server confirmed the key');
    return { status: 'migrated', server, keyHint: after.keyHint ?? null, openaiDropped, message: `The Claude key moved to "${server}" (${after.keyHint}). api-keys.json is gone.` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`[crucible] moving api-keys.json to "${server}" failed; the file is kept: ${message}`);
    return { status: 'failed', server, keyHint: null, openaiDropped, message: `Moving the Claude key to "${server}" failed (${message}); api-keys.json is kept and the move is tried again at the next start.` };
  }
}
