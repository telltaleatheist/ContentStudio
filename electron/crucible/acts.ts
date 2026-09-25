/**
 * THE ACTS CONTENTSTUDIO SENDS, AND THE ONE RULE ABOUT MODEL IDS.
 *
 * Ported from BookForge's electron/crucible/text-acts.ts (the vocabulary half;
 * its Foundry endpoint-header half has no ContentStudio caller, since this app
 * speaks to Crucible's chat door itself and never spawns an engine that would).
 *
 * ── The acts ────────────────────────────────────────────────────────────────
 *
 * Every chat and decision names what it IS in `X-Crucible-Act`, and Crucible
 * refuses a name it does not know (`400 unknown_act`, crucible/inflight.py), so
 * a typo here is a refused run rather than a bench that is confidently wrong
 * about what is on the card. The names are spelled exactly as crucible's
 * `capability.py` spells its capability classes, and
 * tools/test-crucible-acts.js reads that file at the pinned release and asserts
 * every one of them is there, rather than trusting this list.
 *
 *   generate   every generation call: titles, description, tags, thumbnail
 *              text, pinned comment, chapter titles and summaries, the insights
 *              distiller, more titles, scrub and Soften, the compilation package
 *              (LEDGER #193: Owen ruled ONE class, not write/rewrite).
 *   analysis   what a server older than 1.0.24 takes instead of `generate`
 *              (plan 6.4). Chosen per server from its capability record, never
 *              by version, and logged once per server per session (Law 8).
 *   decide     snap: `POST /v1/decide` (plan 10, LEDGER #199).
 */

/** Every act this app may put on the wire, in capability.py's order. */
export const CONTENTSTUDIO_ACTS = ['analysis', 'generate', 'decide'] as const;

export type ContentStudioAct = (typeof CONTENTSTUDIO_ACTS)[number];

/** The act a CALLER names. `analysis` is never chosen by a caller: it is the door's per-server substitute. */
export type CallerAct = 'generate' | 'decide';

/**
 * IS THIS MODEL ID ONE THE ENGINE FORWARDS, rather than one it holds?
 *
 * crucible docs/PHASE15-HOST.md section 1: an upstream model id is
 * `<upstream>/<model>` (`anthropic/claude-sonnet-5`), and "the slash is what
 * tells a chat request apart from a local model id; a local model id never
 * contains `/`" (the server checks it at manifest load,
 * `manifest_model_id_slash`). BookForge's rule, copied: an upstream model is
 * never leased (`lease_not_needed`), never loaded, and takes no GPU lane.
 */
export function isUpstreamModelId(model: string): boolean {
  return model.includes('/');
}

/** The upstream an `<upstream>/<model>` id names, or null for a local model. */
export function upstreamOf(model: string): string | null {
  const slash = model.indexOf('/');
  return slash <= 0 ? null : model.slice(0, slash);
}
