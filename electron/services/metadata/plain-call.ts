/**
 * The parsers that read plain-text answers, and the one strip every answer gets
 *
 * WHY THIS FILE EXISTS (operator's ruling, 2026-08-24): "no more JSON for these calls unless
 * absolutely necessary." Every generation call in the metadata pipeline asks for ONE thing —
 * ten titles, one tag line, one description, one chapter's name and summary — and wrapping
 * those answers in JSON string literals is where an entire failure class lived: the
 * close-quote runaway, the `"..."`-as-whole-body bail-out, the repair ladder, the truncation
 * recovery. A paragraph asked for as a paragraph has none of those places to fail.
 *
 * THE TRANSPORT THAT LIVED HERE IS GONE (P2). `askOllamaPlain` posted to Ollama's
 * /api/generate and /api/chat; every model call now goes through the one Crucible door
 * (electron/crucible/transport.ts), which states `thinking` on every call, refuses a
 * truncated answer (`finish_reason: length`, LEDGER #112) and checks the prompt against the
 * loaded context before sending. What stays here is what reads the answer.
 *
 * THE PARSERS live here so the formats have one home. Each one reads exactly the shape its
 * prompt asks for and THROWS naming what it got when the answer is not that shape — never a
 * silent repair (deliver-and-curate governs what happens next, and it is the caller's call).
 */

/**
 * Inline reasoning, removed. `<think>...</think>` blocks are the one thing a plain answer can
 * carry that is not the answer; an unterminated block (the model hit its budget mid-thought)
 * takes everything from `<think>` on with it, because half a thought is not an answer either.
 */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/, '').trim();
}

// ---------------------------------------------------------------------------
// The parsers — one per output shape the prompts ask for
// ---------------------------------------------------------------------------

/**
 * A leading list marker, tolerated as NORMALIZATION rather than demanded: the prompts ask for
 * bare lines, and a model that numbers them anyway has still answered — "1. " or "- " in front
 * of a title is decoration, not content. Anything beyond these two shapes is the line's text.
 */
const LIST_MARKER = /^\s*(?:[-*•]\s+|\d{1,3}[.)]\s+)/;

/**
 * One answer per line.
 *
 * Blank lines separate nothing and are dropped; list markers are stripped. An answer with no
 * lines at all throws — there is nothing for the caller's count checks to even count.
 */
export function parseLines(text: string, what: string): string[] {
  const lines = text
    .split('\n')
    .map((line) => line.replace(LIST_MARKER, '').trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    throw new Error(`The answer to ${what} contains no lines at all (got: "${text.slice(0, 120)}")`);
  }
  return lines;
}

/**
 * A description: ONE paragraph whose first sentence is the hook.
 *
 * The shape the description prompt asks for since 2026-08-30 evening (operator: descriptions
 * run thinking-off; ship it). The old hook / blank line / body shape needed the model to emit
 * a structural blank line, which thinking-off never reliably did (0-2 of 6 across six contract
 * wordings) — while a single paragraph opening with the snippet sentence is what it produced
 * in EVERY measured run. So the contract now asks for exactly that, and the hook is measured
 * off the answer rather than demanded as layout: the first sentence, which the rules already
 * define as the standalone search snippet.
 *
 * The split point is the first sentence-ending period followed by whitespace (or end) after a
 * minimum believable hook length. No boundary inside the first `maxHookChars` is NOT repaired
 * by cutting mid-clause — it throws naming what came back, exactly like every other parser
 * here, and the caller's declared policy owns it.
 */
export function parseLeadBody(
  text: string,
  what: string,
  maxHookChars: number
): { hook: string; body: string } {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) {
    throw new Error(`The answer to ${what} is empty`);
  }
  const sentenceEnd = /[.!?]["'”’)]?(?=\s|$)/g;
  sentenceEnd.lastIndex = 30; // a hook shorter than this is not a sentence, whatever the dot is
  const m = sentenceEnd.exec(normalized);
  if (!m || m.index + m[0].length > maxHookChars) {
    throw new Error(
      `The answer to ${what} has no sentence boundary inside its first ${maxHookChars} characters, so ` +
        `there is no opening line to measure off it (got: "${normalized.slice(0, 120)}")`
    );
  }
  const cut = m.index + m[0].length;
  const hook = normalized.slice(0, cut).trim();
  const body = normalized.slice(cut).trim();
  if (body.length === 0) {
    throw new Error(`The answer to ${what} is a single sentence — it has a hook and no body`);
  }
  return { hook, body };
}

/**
 * A chapter: its title on the first line, its detail on the lines after it.
 *
 * The detail lines are joined into one paragraph — the prompt asks for 2-3 sentences, and a
 * model that wraps them across lines has still written one detail. A missing detail is NOT an
 * error here: the caller's declared policy for a chapter that could not be described is a
 * warning and an empty detail, so the empty string is an answer this parser must be able to
 * hand back.
 */
export function parseTitleDetail(text: string, what: string): { title: string; detail: string } {
  const lines = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(LIST_MARKER, '').trim());
  const firstAt = lines.findIndex((line) => line.length > 0);
  if (firstAt === -1) {
    throw new Error(`The answer to ${what} contains no title line at all (got: "${text.slice(0, 120)}")`);
  }
  const title = lines[firstAt];
  const detail = lines
    .slice(firstAt + 1)
    .filter((line) => line.length > 0)
    .join(' ')
    .trim();
  return { title, detail };
}
