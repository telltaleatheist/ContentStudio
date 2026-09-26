/**
 * THE 16,384 ASSERTION (P4; CRUCIBLE-MIGRATION-PLAN.md 16, P4's "done when": "On the PC, every
 * call of a 60-minute video fits under 16,384 (a log assertion)").
 *
 * The PC's 27B serves 16,384 when a load states nothing (its cuda-linux `context_default`) and at
 * most 32,768 when one does; the Mac's serves up to 131,072. So whether an item's local calls all
 * fit 16,384 is the fact that says whether that item could have run on the PC at its default
 * load, and it is the number the low-context redesign (LEDGER #196, #209) aims every call at.
 *
 * WHAT THIS IS. A statement about an item that already ran, read off its own `_prompt_trace`
 * (every local call records its prompt size, its answer budget and the load context it asked
 * for: transport.ts). It is LOGGED and written onto the item as `_context_stats`, and it NEVER
 * blocks anything (Law 3): a call over the line is named, with its size, and the item ships.
 *
 * WHAT COUNTS. Local Crucible calls only: an `anthropic/` upstream and `claude -p` carry their
 * own windows, and a call recorded without a budget (a trace written before P4) is counted as
 * unmeasured rather than guessed.
 *
 * PURE, so the keepers assert it without a model.
 */
import { DECIDE_QUESTION_TOKENS, estimateTokens, loadContextFor } from '../../crucible/context-check';
import { isUpstreamModelId } from '../../crucible/acts';

/** The line: the PC 27B's default load (cuda-linux `context_default`). */
export const PC_DEFAULT_CONTEXT = 16384;

/** The trace fields this reads (transport.ts PromptTraceRecord and the claude -p entries). */
export interface AssertedCall {
  what: string;
  model: string;
  chars: number;
  /** Absent on the re-roll gate's own entries (it records after the call, reroll.service.ts). */
  server?: string;
  /** Absent on a claude -p entry and on any trace written before P4. */
  maxTokens?: number;
  act?: string;
}

export interface ContextStats {
  /** The line every local call is measured against. */
  line: number;
  localCalls: number;
  /** Local calls recorded with no budget (a trace from before P4): not measured, not guessed. */
  unmeasured: number;
  /** The largest local call: its label, its estimated need (prompt + budget) and its load step. */
  largest: { what: string; need: number; step: number } | null;
  /** Every local call whose load step is over the line, in the order they ran. */
  over: Array<{ what: string; need: number; step: number }>;
  fits: boolean;
}

export function contextAssertion(trace: readonly AssertedCall[]): { stats: ContextStats; line: string } {
  const local = trace.filter(
    (t) => t.server !== 'claude -p' && !String(t.model).startsWith('claude-cli:') && !isUpstreamModelId(t.model)
  );
  const measured = local.filter((t) => typeof t.maxTokens === 'number');
  const sized = measured.map((t) => {
    const answer = t.act === 'decide' ? DECIDE_QUESTION_TOKENS : (t.maxTokens as number);
    return { what: t.what, need: estimateTokens(t.chars) + answer, step: loadContextFor(t.chars, answer) };
  });
  const largest = sized.reduce<ContextStats['largest']>((a, b) => (a === null || b.need > a.need ? b : a), null);
  const over = sized.filter((c) => c.step > PC_DEFAULT_CONTEXT);
  const stats: ContextStats = {
    line: PC_DEFAULT_CONTEXT,
    localCalls: local.length,
    unmeasured: local.length - measured.length,
    largest,
    over,
    fits: over.length === 0 && measured.length === local.length,
  };
  const unmeasured = stats.unmeasured > 0 ? `; ${stats.unmeasured} recorded no budget and are not measured` : '';
  let line: string;
  if (local.length === 0) {
    line = `context assertion (${PC_DEFAULT_CONTEXT}): no local call ran for this item`;
  } else if (over.length === 0) {
    line =
      `context assertion (${PC_DEFAULT_CONTEXT}): all ${measured.length} measured local call(s) fit` +
      (largest ? `; the largest is ${largest.what} at ~${largest.need} tokens (loads at ${largest.step})` : '') +
      unmeasured;
  } else {
    line =
      `context assertion (${PC_DEFAULT_CONTEXT}): ${over.length} of ${measured.length} measured local call(s) ` +
      `need more than ${PC_DEFAULT_CONTEXT}: ` +
      over.map((c) => `${c.what} ~${c.need} (loads at ${c.step})`).join('; ') +
      unmeasured +
      `. Stated, not enforced: the item shipped as written`;
  }
  return { stats, line };
}
