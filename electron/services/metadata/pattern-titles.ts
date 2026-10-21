/**
 * The TESTED-PATTERN TITLES: five more titles per long-form item, each written in one pattern the
 * channel's own evidence shows winning, beside the ten the titles call writes.
 *
 * WHAT OWEN ASKED FOR (2026-10-21): "maybe we dont switch the way it generates titles, but we
 * create five additional titles that follow test patterns. so i still have the exact same prompt
 * for ten titles as usual, but there are five more that reflect the winning patterns, like the
 * claim in the title, or dry humor, etc". So:
 *
 *   - THE TEN ARE UNTOUCHED. The titles call, its prompt and its answer are exactly what they
 *     were (tools/pattern-titles-checks.js holds byte-for-byte copies of the assembled prompt from
 *     the commit before this one and compares). The five are a SECOND call, after it.
 *   - THE PATTERNS ARE DATA. Distilled from the same evidence the lessons are, by a second
 *     distiller call (analytics/insights-guidelines.ts, insights.yml `pattern_distiller`), cached
 *     beside the lessons. Nothing here names a shape: LEDGER #319 measured the shape Owen likes at
 *     4 won / 6 lost on Telltale and 5 / 12 on Fireside, so a hard-coded list would bake a loser in.
 *   - ONE CALL, on the TITLES row's model, reading the same video the titles call reads (the same
 *     shared prefix, so a local engine reuses its prefill), with titles.yml's
 *     `pattern_instructions` around the five patterns. That section shares the ten-title rules
 *     through the `{title_rules}` slot — one copy of the register, the length law and the
 *     claim-attribution rule for both calls. It does not carry the insights block: the patterns
 *     ARE this call's evidence, and the lessons beside them would be a second brief.
 *   - THE ANSWER IS STRICT. Exactly one line per pattern, paired by position. Any other count
 *     throws naming the call, the model and both counts: a sixth line cannot be paired with a
 *     pattern, and a missing one leaves Owen a pattern name over the wrong title. NO RE-ASK (Law 3:
 *     an unusable answer fails loudly; the scrub's lines calls are the precedent). A title naming
 *     something the inputs do not contain is WARNED, never re-asked or dropped.
 *   - STORED BESIDE `titles`, never in it: `pattern_titles: [{ pattern, how, title }]`. Every
 *     reader of `titles` (the ten more titles replay, the re-roll gate's ranking, the tag
 *     assembly's first title, the thumbnails' words, the extension's generated list) keeps reading
 *     exactly the ten. A pattern title becomes a pick the way every title does: the A/B picks and
 *     the pencil's edits are keyed by TEXT (publish chosenTitles, titleEdits), not by position.
 *
 * WHEN IT RUNS, stated as a condition (planMetadataUnits): the channel file says
 * `pattern_titles: true` (Telltale, Fireside, Unfiltered), the run writes titles, and the run
 * carries channel evidence (a prepared insights object, so the patterns resolved). Shorts, the
 * podcast, the song channel, compilations (their own branch, no units) and runs without insights
 * write none, each said in the log.
 */

import log from 'electron-log';

import { loadContextFor } from './context-sizing';
import { parseLines } from './plain-call';
import { ungroundedTitles, titleGroundingText, LOCAL_FIELD_NUM_PREDICT, LOCAL_FIELD_TIMEOUT_MS } from './metadata-tasks';
import type { ExpectedLoad, MetadataFieldId, MetadataRunContext, MetadataUnit } from './metadata-tasks';
import type { MetadataRoutingOption } from './metadata-routing';
import type { JobModelLifecycle } from './model-lifecycle';
// Type-only: the unit receives an instance and never constructs one (ai-manager imports
// metadata-tasks, which imports this module).
import type { AIManagerService } from './ai-manager.service';
import type { ResolvedTitlePatterns } from '../analytics/insights-guidelines';

/** How many tested patterns a channel's evidence is distilled into, and so how many titles the call writes. */
export const TITLE_PATTERN_COUNT = 5;

/** One distilled pattern: the name Owen reads beside the title, and the line the title call is given. */
export interface TitlePattern {
  name: string;
  how: string;
}

/** One stored tested-pattern title, as the item carries it. */
export interface PatternTitle {
  /** The pattern's name (2-5 words). */
  pattern: string;
  /** The pattern's one line of how, as the call was given it. */
  how: string;
  title: string;
}

/** How the call is named in `_prompt_trace`; deliberately NOT `the titles call for …`, which the ten-more replay looks for. */
export const PATTERN_TITLES_TRACE_PREFIX = 'the tested-pattern titles call for ';

/** The patterns as the section's `{patterns}` slot shows them: one numbered line each, under the instruction. */
export function renderPatternList(resolved: ResolvedTitlePatterns): string {
  if (resolved.kind === 'placeholder') return `  ${resolved.text}`;
  return resolved.patterns.map((p, i) => `  ${i + 1}. ${p.name}: ${p.how}`).join('\n');
}

/**
 * The call's answer, paired with its patterns by position. Numbering and bullets are tolerated
 * (the shared line reader); any count other than one line per pattern throws.
 */
export function readPatternTitles(text: string, patterns: TitlePattern[], model: string, sourceLabel: string): PatternTitle[] {
  const what = `the tested-pattern titles call for ${sourceLabel}`;
  const lines = parseLines(text, what);
  if (lines.length !== patterns.length) {
    throw new Error(
      `The tested-pattern titles call on ${model} for ${sourceLabel} returned ${lines.length} line(s) for ` +
        `${patterns.length} patterns, so no line can be paired with its pattern. Nothing was kept and nothing ` +
        `re-asked (got: "${text.slice(0, 200)}")`
    );
  }
  return lines.map((title, i) => ({ pattern: patterns[i].name, how: patterns[i].how, title }));
}

/** The one call, as a unit of the run's plan: planned right after the titles, on the titles row's option. */
export class PatternTitlesUnit implements MetadataUnit {
  readonly label: string;
  readonly fields: MetadataFieldId[] = ['pattern_titles'];
  readonly inputFields: MetadataFieldId[] = [];
  readonly localModel?: string;

  constructor(
    private readonly aiManager: AIManagerService,
    private readonly option: MetadataRoutingOption,
    private readonly lifecycle: JobModelLifecycle,
    private readonly patterns: ResolvedTitlePatterns
  ) {
    const count = patterns.kind === 'patterns' ? patterns.patterns.length : 'the';
    this.label = `${count} tested-pattern titles (${option.kind} ${option.model})`;
    if (option.kind === 'local') this.localModel = option.model;
  }

  describePrompt(ctx: MetadataRunContext): string {
    return this.aiManager.buildPatternTitlesPromptParts(ctx, this.patterns).prompt;
  }

  expectedLoad(ctx: MetadataRunContext): ExpectedLoad | null {
    if (this.option.kind !== 'local') return null;
    const { prompt } = this.aiManager.buildPatternTitlesPromptParts(ctx, this.patterns);
    return { sessions: this.lifecycle.sessions, tokens: loadContextFor(prompt.length, LOCAL_FIELD_NUM_PREDICT), calls: 1 };
  }

  async generate(ctx: MetadataRunContext): Promise<Record<string, unknown>> {
    if (this.patterns.kind !== 'patterns') {
      throw new Error(
        `The tested-pattern titles call for ${ctx.sourceLabel} was asked to run with the dry-run placeholder in ` +
          `place of its patterns; only a show-prompts flow resolves to the placeholder, and it never runs a unit`
      );
    }
    const { prompt, shared } = this.aiManager.buildPatternTitlesPromptParts(ctx, this.patterns);
    const what = `${PATTERN_TITLES_TRACE_PREFIX}${ctx.sourceLabel}`;
    // The titles call's own shape, on the titles call's own model: thinking off, and a local call
    // states the field budget, its own load context, the job's session and the shared prefix.
    const text = await this.aiManager.runPlainRequest(
      prompt,
      this.option.model,
      what,
      this.option.kind === 'local'
        ? {
            thinking: false,
            maxTokens: LOCAL_FIELD_NUM_PREDICT,
            loadContext: loadContextFor(prompt.length, LOCAL_FIELD_NUM_PREDICT),
            job: this.lifecycle.sessions,
            timeoutMs: LOCAL_FIELD_TIMEOUT_MS,
            sharedPrefix: shared,
          }
        : { thinking: false }
    );
    if (!text) {
      throw new Error(`The tested-pattern titles call on ${this.option.model} for ${ctx.sourceLabel} came back empty`);
    }
    const pattern_titles = readPatternTitles(text, this.patterns.patterns, this.option.model, ctx.sourceLabel);

    // The ten's grounding check, as a warning only: no re-ask for these (Law 3).
    const grounding = titleGroundingText(ctx);
    if (grounding.trim().length > 0) {
      const faults = ungroundedTitles(pattern_titles.map((p) => p.title), grounding);
      if (faults.length > 0) {
        ctx.warn(
          `tested-pattern titles used a phrase the video's transcript, chapters and filename contain no part of — ` +
            faults.map((f) => `"${f.title}" says ${f.invented.map((i) => `"${i}"`).join(' and ')}`).join('; ') +
            `. They are kept exactly as written.`
        );
      }
    }
    log.info(
      `[PatternTitles] ${ctx.sourceLabel}: ${pattern_titles.length} tested-pattern title(s) on ${this.option.model}`
    );
    return { pattern_titles };
  }
}
