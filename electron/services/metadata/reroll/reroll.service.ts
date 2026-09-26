/**
 * The re-roll gate on a generated item: what the generation loop calls, after the scrub pass and
 * before the save (P9; LEDGER #201, #183).
 *
 * THIS FILE IS THE BINDING, NOT THE GATE. gate.ts decides what goes back and what ships; this
 * file reads the fields off the item, hands the gate its two transports, and writes the answer
 * back:
 *
 *   decide  the SCORER, a fixed declared role (metadata-routing.ts REROLL_SCORER_MODEL, the 9B;
 *           #199 "9b -> ... snap"), through the one door's `decide` on its GPU lane, under the
 *           job's own leases, so the scorer and the field models trade the card inside one job
 *           rather than two leases fighting over it.
 *   revise  the FIELD'S OWN routed model (the routing table stays the only thing that picks a
 *           writing model, #204), through AIManagerService.runPlainRequest like every generation
 *           call, plain text (Law 12), thinking on as the scrub's rewrite was measured.
 *
 * WHAT IT WRITES (Law 8). The item's fields as the gate shipped them; `reroll_gate` — the
 * settings, every unit's every attempt with its readings, the ranking, the warnings; and one
 * `_prompt_trace` entry per decide and per re-roll, appended after the loop's slice as the scrub's
 * are (scrub.ts: slicing afterwards would count a cloud call twice). The warnings also go to the
 * run's, prefixed with the item's label.
 *
 * WHAT NEVER GOES TO A MODEL: chapter timestamps (standing law; titles are reattached by position)
 * and the description's link block (held back by EXACT match, the scrub's generation-time rule; a
 * set whose block is not on the end of the description it just wrote throws rather than sending
 * URLs to a rewrite).
 */

import * as log from 'electron-log';

import type { AIManagerService } from '../ai-manager.service';
import type { Chapter } from '../chapter-generator.service';
import { crucibleTransport } from '../../../crucible/transport';
import { loadContextFor } from '../context-sizing';
import { DECIDE_QUESTION_TOKENS } from '../../../crucible/context-check';
import { LOCAL_FIELD_TIMEOUT_MS } from '../metadata-tasks';
import { MetadataRoutingTaskId, REROLL_SCORER_MODEL, ResolvedMetadataRouting, routingOption } from '../metadata-routing';
import type { JobModelLifecycle } from '../model-lifecycle';
import { parseLines } from '../plain-call';
import { promptAssets } from '../prompt-assets';
import { gpuCall, queueAITask } from '../../queue-manager.service';
import { GateFieldInput, GateRecord, runGate } from './gate';
import { channelFacts, joinSentences, splitSentences } from './rules';
import { RerollGateSettings } from './settings';
import { DecideFn, DecideRequest, GateError, GateField, ReviseFn } from './types';

/**
 * The revise call's output budget: 8,192, unchanged by P4. The revise runs thinking-ON (a unit
 * rewritten against a named rule), and through P2 it borrowed the field calls' number; when the
 * thinking-off field calls came down to 2,048 (metadata-tasks.ts LOCAL_FIELD_NUM_PREDICT) this
 * kept the budget it was built with. No revise answer length appears in any log or stored record
 * P4 could read (docs/crucible/P4.md "Budgets"), so there is no evidence to size it by and the
 * number stays (LEDGER #214). Its load context is its own prompt plus this (LEDGER #209).
 */
export const REVISE_NUM_PREDICT = 8192;

/** Which routing row writes each field's re-roll: its own. */
const FIELD_TASK: Record<GateField, MetadataRoutingTaskId> = {
  titles: 'titles',
  chapters: 'chapters',
  description: 'description',
  thumbnail_text: 'thumbnail_text',
  pinned_comment: 'pinned_comment',
};

export interface RerollGateRun {
  settings: RerollGateSettings;
  /** Read for the prompt set's link block, and (unless `bind` is given) to send the re-roll calls. */
  aiManager: Pick<AIManagerService, 'descriptionLinks' | 'runPlainRequest'>;
  routing: ResolvedMetadataRouting;
  lifecycle: JobModelLifecycle;
  /** The run's warnings; the gate's are pushed here, prefixed with the item's label. */
  warnings: string[];
  sourceLabel: string;
  signal?: AbortSignal;
  /**
   * Only a keeper passes this: its own decide and revise in place of the Crucible scorer and the
   * routed models, so the whole binding — fields off the item, answers back on, trace, record,
   * warnings — is checked with no server (tools/reroll-checks.js).
   */
  bind?: { decide: DecideFn; revise: ReviseFn };
}

/** What the item keeps of the run (the trace keeps the prompts). */
export interface RerollGateItemRecord {
  mode: 'on' | 'off';
  scorer: string;
  at: string;
  settings?: RerollGateSettings;
  fields?: GateRecord['fields'];
  ranking?: { order: NonNullable<GateRecord['ranking']>['order']; skippedRotations: number } | null;
  warnings?: string[];
}

function strings(value: unknown, what: string, sourceLabel: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new GateError('bad_request', `${sourceLabel}'s ${what} is ${typeof value}, not a list`);
  return value.map((v, i) => {
    if (typeof v !== 'string' || v.trim().length === 0) throw new GateError('bad_request', `${sourceLabel}'s ${what} entry ${i + 1} is not text`);
    return v;
  });
}

/** The description's prose and link block, held back by exact match (see the header). */
function holdBackLinks(description: string, links: string, sourceLabel: string): { prose: string; suffix: string } {
  if (links === '') return { prose: description.trim(), suffix: '' };
  const exact = `\n\n${links}`;
  if (!description.endsWith(exact)) {
    throw new GateError(
      'bad_request',
      `${sourceLabel}'s description does not end with its prompt set's description_links block, which was appended ` +
        `moments ago; the re-roll gate will not send a link block to a model, so it stops here.`,
    );
  }
  return { prose: description.slice(0, description.length - exact.length).trimEnd(), suffix: exact };
}

/**
 * The gate's fields off one item, each with where its answer goes back. A field the item does not
 * carry is left out (and the record says which ran).
 */
export function fieldsOf(item: any, links: string, sourceLabel: string): Array<GateFieldInput & { apply: (units: string[]) => void }> {
  const out: Array<GateFieldInput & { apply: (units: string[]) => void }> = [];
  const list = (field: 'titles' | 'thumbnail_text' | 'pinned_comment') => {
    const units = strings(item[field], field, sourceLabel);
    if (units.length > 0) out.push({ field, units, stateText: (u) => u.join('\n'), apply: (u) => { item[field] = u; } });
  };
  list('titles');

  if (Array.isArray(item.chapters) && item.chapters.length > 0) {
    const titles = (item.chapters as Chapter[]).map((c, i) => {
      if (typeof c?.title !== 'string' || c.title.trim().length === 0) throw new GateError('bad_request', `${sourceLabel}'s chapter ${i + 1} has no title`);
      return c.title;
    });
    out.push({
      field: 'chapters',
      units: titles,
      stateText: (u) => u.join('\n'),
      // By position, every other chapter key untouched (scrub.ts's reattachment rule).
      apply: (u) => { item.chapters = (item.chapters as Chapter[]).map((c, i) => ({ ...c, title: u[i] })); },
    });
  }

  if (typeof item.description === 'string' && item.description.trim().length > 0) {
    const { prose, suffix } = holdBackLinks(item.description, links, sourceLabel);
    const parts = splitSentences(prose);
    const hook = typeof item.description_hook === 'string' && item.description_hook.trim().length > 0 ? item.description_hook.trim() : null;
    const lead = hook === null ? 0 : 1;
    out.push({
      field: 'description',
      units: [...(hook === null ? [] : [hook]), ...parts.sentences.map((s) => s.trim())],
      stateText: (u) => (hook === null ? '' : `${u[0]}\n\n`) + joinSentences({ ...parts, sentences: parts.sentences.map((s, i) => rewrap(s, u[lead + i])) }),
      apply: (u) => {
        if (hook !== null) item.description_hook = u[0];
        item.description = joinSentences({ ...parts, sentences: parts.sentences.map((s, i) => rewrap(s, u[lead + i])) }) + suffix;
      },
    });
  }
  list('thumbnail_text');
  list('pinned_comment');
  return out;
}

/** A sentence's replacement, keeping the whitespace the original carried at its edges. */
function rewrap(original: string, text: string): string {
  const before = /^\s*/.exec(original)![0];
  const after = /\s*$/.exec(original)![0];
  return before + text + after;
}

function renderDecide(request: DecideRequest): string {
  const qs = Object.entries(request.questions).map(([name, q]) =>
    q.type === 'yesno' ? `${name}: ${q.instructions}` : `${name}: ${q.instructions}\n${Object.entries(q.options).map(([o, t]) => `  ${o}: ${t}`).join('\n')}`,
  );
  return `${request.state}\n\n[decide]\n${qs.join('\n')}`;
}

/**
 * Run the gate over one generated item, in place. With the gate off, the item records that it was
 * off (Law 8) and nothing is asked.
 */
export async function rerollGateItem(item: any, run: RerollGateRun): Promise<void> {
  const at = new Date().toISOString();
  if (run.settings.mode === 'off') {
    item.reroll_gate = { mode: 'off', scorer: REROLL_SCORER_MODEL, at } satisfies RerollGateItemRecord;
    log.info(`[RerollGate] ${run.sourceLabel}: the gate is off (rerollGate setting); nothing was checked`);
    return;
  }
  if (!Array.isArray(item._prompt_trace)) {
    throw new GateError('bad_request', `the re-roll gate appends to ${run.sourceLabel}'s _prompt_trace, and the item has none; the generation loop writes it before this runs`);
  }
  const promptSet = item._prompt_set;
  if (typeof promptSet !== 'string') throw new GateError('bad_request', `${run.sourceLabel} names no prompt set, so the gate cannot say whose channel it is`);
  const channel = promptAssets().channel(promptSet);
  const facts = channelFacts(channel.name, channel.brandTerms);
  const fields = fieldsOf(item, run.aiManager.descriptionLinks(), run.sourceLabel);

  const decide: DecideFn = run.bind?.decide ?? ((request, o) =>
    queueAITask(gpuCall(REROLL_SCORER_MODEL), `reroll-${Date.now()}`, `Re-roll gate: ${run.sourceLabel}`, async () => {
      const answer = await crucibleTransport().decide({
        model: REROLL_SCORER_MODEL,
        state: request.state,
        questions: request.questions,
        missing: request.missing,
        // Its own step (LEDGER #209), as snap's decide calls size theirs. Absent, the scorer
        // loaded at the server's default, a size nobody stated for this call.
        loadContext: loadContextFor(request.state.length, DECIDE_QUESTION_TOKENS),
        job: run.lifecycle.leases,
        ...(o.signal === undefined ? {} : { signal: o.signal }),
        what: o.what,
        // Recorded by this file, with the answers, after the call (below): the item's trace is
        // already sliced, and the door's own entry would land on the manager's running trace.
        trace: null,
      });
      return { answers: answer.answers as never };
    }));

  const revise: ReviseFn = run.bind?.revise ?? (async (request) => {
    const option = routingOption(FIELD_TASK[request.field], run.routing[FIELD_TASK[request.field]]);
    const what = `re-roll gate: ${request.field} re-roll ${request.attempt} (${request.rule}) for ${run.sourceLabel}`;
    const text = await run.aiManager.runPlainRequest(
      request.prompt,
      option.model,
      what,
      option.kind === 'local'
        ? {
            thinking: true,
            maxTokens: REVISE_NUM_PREDICT,
            loadContext: loadContextFor(request.prompt.length, REVISE_NUM_PREDICT),
            timeoutMs: LOCAL_FIELD_TIMEOUT_MS,
          }
        : { thinking: true },
    );
    if (!text) throw new GateError('no_answer', `${what} on "${option.model}" came back empty`);
    return parseLines(text, what);
  });

  const { fields: shipped, record } = await runGate({
    fields,
    facts,
    decide,
    revise,
    settings: run.settings,
    sourceLabel: run.sourceLabel,
    rank: fields.some((f) => f.field === 'titles'),
    signal: run.signal,
  });
  // Only a field the gate CHANGED is written back: an untouched field stays byte for byte what the
  // run wrote (the prose is rebuilt around a re-rolled sentence, never re-flowed around none).
  for (const f of fields) {
    const units = shipped.get(f.field);
    if (units && units.some((u, i) => u !== f.units[i])) f.apply(units);
  }

  const trace = item._prompt_trace as Array<Record<string, unknown>>;
  for (const call of record.decideCalls) {
    const prompt = renderDecide(call.request);
    // `maxTokens`/`act` (P4) let the item's context assertion size the call (context-assertion.ts).
    trace.push({ what: call.what, model: REROLL_SCORER_MODEL, chars: prompt.length, at: call.at, prompt, answers: call.answers, maxTokens: 0, act: 'decide' });
  }
  for (const call of record.rerollCalls) {
    const option = routingOption(FIELD_TASK[call.field], run.routing[FIELD_TASK[call.field]]);
    trace.push({
      what: `re-roll gate: ${call.field} re-roll ${call.attempt} (${call.rule})`, model: option.model, chars: call.prompt.length, at: call.at,
      prompt: call.prompt, answers: call.answers, ...(option.kind === 'local' ? { maxTokens: REVISE_NUM_PREDICT, act: 'generate' } : {}),
    });
  }
  if (record.ranking) {
    const prompt = renderDecide(record.ranking.request);
    trace.push({ what: `re-roll gate: title ranking for ${run.sourceLabel}`, model: REROLL_SCORER_MODEL, chars: prompt.length, at, prompt, answers: record.ranking.answers, maxTokens: 0, act: 'decide' });
  }

  item.reroll_gate = {
    mode: 'on',
    scorer: REROLL_SCORER_MODEL,
    at,
    settings: run.settings,
    fields: record.fields,
    ranking: record.ranking ? { order: record.ranking.order, skippedRotations: record.ranking.skippedRotations } : null,
    warnings: record.warnings,
  } satisfies RerollGateItemRecord;
  for (const w of record.warnings) run.warnings.push(`${run.sourceLabel}: ${w}`);

  const rerolled = record.fields.filter((f) => f.rerolls > 0).map((f) => `${f.field} x${f.rerolls}`);
  log.info(
    `[RerollGate] ${run.sourceLabel}: ${record.decideCalls.length} decide call(s) on ${REROLL_SCORER_MODEL}, ` +
      `${record.rerollCalls.length} re-roll call(s)${rerolled.length ? ` (${rerolled.join(', ')})` : ''}, ` +
      `${record.warnings.length} warning(s)`,
  );
}
