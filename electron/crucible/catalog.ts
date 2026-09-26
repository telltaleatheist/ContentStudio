/**
 * WHAT THE SELECTED SERVER OFFERS, for the routing dialog (plan 6.2, 0a).
 *
 * Ported from BookForge's electron/crucible/catalog.ts (`readCrucibleCatalog`:
 * the SDK's catalog rows projected, nothing cached, because "what is installed"
 * is a claim about somebody else's disk that changes without asking this app),
 * with Briefcase's picker rule over it: a model is listed when the server's
 * catalog has it (installed, or pullable), and Claude only when that server has
 * an Anthropic key configured. Owen, on seeing "(unavailable)" entries: "if
 * claude isnt available then it shouldnt be listed in the model list."
 *
 * It replaces `probeOllamaInventory`, which read Ollama's /api/tags.
 *
 * Three answers per model, each a different fix:
 *   installed   its weights are on that server: it runs;
 *   pullable    that server's backend can hold it and it is not downloaded yet;
 *   not-here    that server's catalog does not list it for its backend (the
 *               server's own reason is carried when `/v1/models` states one).
 */
import type { CatalogRow, ModelInfo, SettingsDocument } from '@crucible/client';
import type { CrucibleClientFactory } from './client-factory';
import { failureOutcome } from './probe';

export type ModelOffer = 'installed' | 'pullable' | 'not-here';

export interface ModelOfferView {
  offer: ModelOffer;
  /** The server's sentence for why a model is not here, or null. */
  reason: string | null;
}

export interface CatalogInventory {
  /** The server read, by name. Null when no server is selected. */
  server: string | null;
  reachable: boolean;
  /** Why the server could not be read. Present only when `reachable` is false. */
  error?: string;
  /** Crucible model id -> what the server offers for it. Only `llm` rows are read. */
  models: Record<string, ModelOfferView>;
  /** True when the server has an Anthropic key; null when its settings could not be read. */
  anthropicConfigured: boolean | null;
}

/**
 * PURE: the three documents in, the inventory out. A catalog row is the
 * backend's own list (BookForge: "every subject this server's backend can
 * hold"); `/v1/models` supplies the reason for a model it lists as not
 * supported, which the catalog leaves out.
 */
export function inventoryOf(
  server: string,
  catalog: readonly CatalogRow[],
  models: readonly ModelInfo[],
  settings: SettingsDocument | null,
): CatalogInventory {
  const offers: Record<string, ModelOfferView> = {};
  for (const row of catalog) {
    if (row.kind !== 'model' || row.jobType !== 'llm') continue;
    offers[row.id] = { offer: row.installed ? 'installed' : 'pullable', reason: null };
  }
  for (const row of models) {
    if (offers[row.id] !== undefined) continue;
    offers[row.id] = { offer: 'not-here', reason: row.reason };
  }
  const anthropic = settings?.upstreams.anthropic;
  return {
    server,
    reachable: true,
    models: offers,
    anthropicConfigured: settings === null ? null : anthropic !== null && anthropic !== undefined && anthropic.configured,
  };
}

/** What one model id is on this inventory, with the server's sentence when it is not here. */
export function offerFor(inventory: CatalogInventory, model: string): ModelOfferView {
  return inventory.models[model] ?? {
    offer: 'not-here',
    reason: inventory.server === null ? 'no Crucible server is selected' : `"${inventory.server}" does not list ${model}`,
  };
}

/**
 * Read the selected server's catalog, models and settings. A server that does
 * not answer comes back `reachable: false` WITH the reason, never as an empty
 * inventory: an empty one would say every model is "not here", which is a
 * different claim than "we could not ask" (probeOllamaInventory's rule, kept).
 */
export async function catalogInventory(factory: Pick<CrucibleClientFactory, 'clientFor'>, server: string | null): Promise<CatalogInventory> {
  if (server === null) {
    return { server: null, reachable: false, error: 'No Crucible server is selected. Pick one in Settings › Crucible Servers.', models: {}, anthropicConfigured: null };
  }
  try {
    const client = await factory.clientFor(server, { timeoutMs: 5_000 });
    const [catalog, models] = await Promise.all([client.catalog(), client.models()]);
    // Settings are read separately: a server that answers the catalog but not
    // its settings still has models to list, and Claude is then not listed
    // (null is "could not say", which the dialog treats as not configured).
    const settings = await client.settings().catch(() => null);
    return inventoryOf(server, catalog, models, settings);
  } catch (err) {
    return { server, reachable: false, error: failureOutcome(err, `"${server}"`).message, models: {}, anthropicConfigured: null };
  }
}
