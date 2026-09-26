/**
 * How a local call's LOAD CONTEXT is sized, for the metadata callers: a re-export of the one rule.
 *
 * WHAT THIS REPLACED. This was ollama-json.ts, then (through P2) `bucketLoadContext`: every run
 * bucketed ONE load context per model to 4096 from the largest prompt it would send, with a
 * floor that could only raise it (a Settings value, a window an earlier stage left resident),
 * because on Ollama a num_ctx change was a full reload (LEDGER #111).
 *
 * P4 (LEDGER #209, Owen: "we should only be using as much context (8k vs 16k) as necessary")
 * replaced it with the rule in crucible/context-check.ts: every local call asks for the smallest
 * 8,192 step that holds ITS OWN prompt, its own answer budget and a 512-token margin, by the
 * estimate the door checks it with. Reloads are still real, and still bounded, by the lease
 * rather than by a floor: a later call that needs more grows the load once, and one that needs
 * less runs on the larger window already loaded (lease.ts "growth is legitimate, shrinkage
 * never is"). The server refuses a size above its own ceiling by name, so there is no app-side
 * maximum here any more.
 *
 * `TOKENS_PER_WORD` stays: the whole-transcript chapter engine sizes its stage-1 windows in words.
 */

import { estimateTokens, loadContextFor, LOAD_CONTEXT_MARGIN, LOAD_CONTEXT_STEP } from '../../crucible/context-check';

export { estimateTokens, loadContextFor, LOAD_CONTEXT_MARGIN, LOAD_CONTEXT_STEP };

/** Tokens per transcript word, the estimate this codebase uses. */
export const TOKENS_PER_WORD = 1.4;
