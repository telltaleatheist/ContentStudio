/**
 * THE ONE DOOR every ContentStudio model call takes (plan 6.1), except
 * `claude -p`, which stays outside Crucible (LEDGER #193) and keeps its own
 * branch in AIManagerService.makeRequest.
 *
 *   chat({model, prompt, act, thinking, maxTokens, temperature?, responseFormat?, signal, what})
 *       -> {text, finishReason, usage, server}
 *   decide({model, state, questions, missing?, signal, what})         act `decide`, POST /v1/decide
 *   withJobLease(server, model, fn)                                    one lease per job per local model
 *
 * THE FRAME (Owen, 2026-09-25): "follow the bookforge model, where bookforge
 * has all these settings (which model to use, etc) but it's really about how it
 * calls the crucible models." The per-field routing table (metadata-routing.ts)
 * stays the only thing that picks a model (LEDGER #204, #205). This file only
 * decides how the chosen model is CALLED, and refuses by name when it cannot
 * be.
 *
 * PORTED, NOT INVENTED. The chat parser's rules are Briefcase's
 * llm/crucible-chat.service.ts `readReply` (a missing finish_reason is refused,
 * never defaulted to `stop`, plan 0a), which the 1.0.34 SDK's own `chat()` now
 * enforces (`readChatResponse` reads `finish_reason` strictly), so the SDK is
 * called rather than a raw fetch. The body rules are Briefcase's target.ts
 * with two ContentStudio rulings over them: `max_tokens` IS sent to Anthropic,
 * 16000, because Crucible fills 4096 when it is absent and a thinking model
 * spends that on reasoning (LEDGER #187); and `thinking` is stated on every
 * call, cloud included, where Crucible drops it and says so in
 * `X-Crucible-Sampling` (the 27B manifest states no default, so an unstated
 * `thinking` would be two models behaving differently for one call, plan 1).
 * The venue is P1's registry `selected` server (Q14: no automatic hand-off);
 * residency and the lease are lease.ts (BookForge's lease.ts, Briefcase's
 * residency).
 *
 * WHAT THE DOOR DOES ON EVERY CALL:
 *   - records itself in the caller's `promptTrace` with the server that runs it,
 *     BEFORE sending (Law 8: a request that fails was still sent);
 *   - names its act per server: `generate` where the capability record lists
 *     it, else `analysis`, logged once per server per session (plan 6.4);
 *   - on a local model: holds it under the job's lease, then checks the prompt
 *     plus `maxTokens` against the loaded context and throws BEFORE sending
 *     when it does not fit (context-check.ts; the old middle-truncation is gone);
 *   - `finish_reason: length` is a hard failure (LEDGER #112): nothing is returned;
 *   - `409 model_not_resident` re-ensures the model ONCE and resends (someone
 *     else's load evicted it; the model never read the prompt, so this is not a
 *     re-ask under Law 3);
 *   - every other refusal passes through with the server's code and status
 *     (a 429 is a 429), never retried here: queues belong to clients (P3).
 */
import * as log from 'electron-log';
import {
  CrucibleProtocolError,
  CrucibleRefused,
  CrucibleServerError,
  type ChatResponse,
  type DecideQuestion,
  type DecideResponse,
} from '@crucible/client';
import { JobCancelledError, isAbortError } from '../services/metadata/cancellation';
import { isUpstreamModelId, upstreamOf, type ContentStudioAct } from './acts';
import type { CrucibleClientFactory } from './client-factory';
import { checkBeforeSending, estimateTokens, loadedContextOf, tokensNeeded } from './context-check';
import { CrucibleCallError } from './errors';
import { JobLeases, callRefusalOf, withJobLeases, type LeaseHost, type LeaseTimings } from './lease';
import type { CrucibleProbes } from './probe';
import type { CrucibleServers } from './servers';

/**
 * `max_tokens` on every `anthropic/` chat (LEDGER #187). One ceiling, sized for
 * thinking: Sonnet 5 thinks by default, and at a ceiling it cannot finish
 * inside it returns NO text. Crucible fills 4096 when it is absent (upstreams.py
 * ANTHROPIC_MAX_TOKENS_DEFAULT), so it is always sent.
 */
export const ANTHROPIC_MAX_TOKENS = 16000;

/** One line of a run's prompt trace, as AIManagerService.promptTrace has always held it, plus the server. */
export interface PromptTraceRecord {
  what: string;
  model: string;
  chars: number;
  at: string;
  prompt: string;
  /** The Crucible server that ran it, or `claude -p` for the outside transport (Law 8). */
  server: string;
}

export interface ChatRequest {
  /** A Crucible model id: `qwen3.8-27b-4bit`, or `anthropic/claude-sonnet-5`. Never an `ollama:`/`claude:` string. */
  model: string;
  prompt: string;
  /** A system turn. The cloud calls carry the plain/JSON contract here, as makeClaudeRequest did. */
  system?: string;
  act: 'generate';
  /** Stated on every call (plan 1, 6.3): the 9B defaults off and the 27B states nothing. */
  thinking: boolean;
  /** The output budget. On `anthropic/` it must be {@link ANTHROPIC_MAX_TOKENS}. */
  maxTokens: number;
  /** Local only: the chapter stage's consensus samples (LEDGER #159). Refused on an upstream (LEDGER #194). */
  temperature?: number;
  /** The compilation package's JSON on a local model (Law 12's one exception). */
  responseFormat?: { type: 'json_object' };
  /** Local only: the context to load the model at when this job loads it (today's num_ctx, LEDGER #111). */
  loadContext?: number;
  /** The job's leases. Absent: this call is a one-call job, leased and released around itself. */
  job?: JobLeases;
  signal?: AbortSignal;
  /** A wall clock on the answer, when the caller has one (the old per-call timeouts). */
  timeoutMs?: number;
  /** What the call is FOR: the noun in every log line, refusal and trace entry. */
  what: string;
  /** Where the call records itself; null only for a caller that has no run trace (a live smoke). */
  trace: PromptTraceRecord[] | null;
}

export interface ChatUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface ChatResult {
  text: string;
  /** Always the server's own word; `length` never reaches a caller (it throws). */
  finishReason: string;
  /** Null where the server did not report usage; each count null where it did not state it (never an invented 0). */
  usage: ChatUsage | null;
  server: string;
  model: string;
  /** The act that crossed the wire: `generate`, or `analysis` on a pre-1.0.24 server. */
  act: ContentStudioAct;
}

export interface DecideRequest {
  model: string;
  state: unknown;
  questions: Readonly<Record<string, DecideQuestion>>;
  /** Plan 0a, N7: `report` (null + missingLabels), with the floor the client's own rule. */
  missing?: 'refuse' | 'report';
  job?: JobLeases;
  signal?: AbortSignal;
  what: string;
  trace: PromptTraceRecord[] | null;
}

export interface TransportHost {
  servers: Pick<CrucibleServers, 'selected' | 'routingView'>;
  factory: Pick<CrucibleClientFactory, 'clientFor'>;
  probes: Pick<CrucibleProbes, 'reach'>;
}

/** The model strings the old transports used. A caller still holding one is refused by name. */
const RETIRED_PREFIXES = ['ollama:', 'claude:', 'openai:'] as const;

export class CrucibleTransport {
  /** Servers already told they get `analysis` this session (plan 6.4: one line per server). */
  private readonly analysisNoted = new Set<string>();
  private readonly leaseHost: LeaseHost;

  constructor(
    private readonly host: TransportHost,
    /** Only a keeper passes this: short clocks for the heartbeat and the stream retry. */
    private readonly timings: Partial<LeaseTimings> = {},
  ) {
    this.leaseHost = { client: (server, options) => host.factory.clientFor(server, options) };
  }

  /** A new job's leases. The caller releases it once, in its `finally` (model-lifecycle.ts does). */
  job(what: string): JobLeases {
    return new JobLeases(this.leaseHost, what, this.timings);
  }

  /**
   * Hold `model` on `server` for the whole of `fn` (plan 13.3), released on
   * every way out. `fn` is handed the job, to pass to each call it makes.
   */
  async withJobLease<T>(
    server: string,
    model: string,
    fn: (job: JobLeases) => Promise<T>,
    options: { what: string; act?: 'generate' | 'decide'; loadContext?: number; signal?: AbortSignal },
  ): Promise<T> {
    const job = this.job(options.what);
    return withJobLeases(job, async () => {
      if (!isUpstreamModelId(model)) {
        const venue = await this.venue(server, options.act ?? 'generate');
        job.server = server;
        await job.hold(server, model, { act: venue.act, need: null, loadContext: options.loadContext, signal: options.signal });
      }
      return fn(job);
    });
  }

  // ── chat ──────────────────────────────────────────────────────────────────

  async chat(request: ChatRequest): Promise<ChatResult> {
    const model = this.requireCrucibleModel(request.model, request.what);
    const upstream = isUpstreamModelId(model);
    if (upstream && request.temperature !== undefined) {
      throw new CrucibleCallError(
        'sampling_to_cloud',
        `${request.what} asked for temperature ${request.temperature} on ${model}. No sampling parameter is ever ` +
          `sent to a cloud upstream (LEDGER #194); nothing was sent.`,
      );
    }
    if (upstreamOf(model) === 'anthropic' && request.maxTokens !== ANTHROPIC_MAX_TOKENS) {
      throw new CrucibleCallError(
        'invalid_model',
        `${request.what} on ${model} asked for ${request.maxTokens} output tokens; every Anthropic call sends ` +
          `${ANTHROPIC_MAX_TOKENS} (LEDGER #187), because a thinking model at a smaller ceiling returns no text.`,
      );
    }
    this.throwIfAborted(request.signal, request.what);

    const oneCall = request.job === undefined;
    const job = request.job ?? this.job(request.what);
    try {
      const server = job.server ?? this.host.servers.selected();
      const venue = await this.venue(server, 'generate');
      job.server ??= server;
      request.trace?.push({
        what: request.what,
        model,
        chars: request.prompt.length + (request.system?.length ?? 0),
        at: new Date().toISOString(),
        prompt: request.system === undefined ? request.prompt : `${request.system}\n\n${request.prompt}`,
        server,
      });

      const need = tokensNeeded(request.prompt.length + (request.system?.length ?? 0), request.maxTokens);
      if (!upstream && request.loadContext !== undefined && need > request.loadContext) {
        throw new CrucibleCallError(
          'over_context',
          `${request.what} needs ~${need} tokens and was sized to load ${model} at ${request.loadContext}. ` +
            `Nothing was sent and nothing was cut.`,
          server,
        );
      }

      let reensured = false;
      for (;;) {
        if (!upstream) {
          await job.hold(server, model, { act: venue.act, need, loadContext: request.loadContext, signal: request.signal });
          job.assertHeld(server, model);
          await this.checkContext(job, server, model, request);
        }
        try {
          const answer = await this.send(server, model, venue.act, request);
          return this.readAnswer(answer, server, model, venue.act, request);
        } catch (err) {
          if (!upstream && !reensured && err instanceof CrucibleRefused && err.code === 'model_not_resident') {
            reensured = true;
            log.warn(`[crucible] ${request.what}: ${model} is no longer resident on "${server}" (${err.serverMessage}); making it resident again, once`);
            job.forget(server, model);
            continue;
          }
          throw this.refusal(err, server, model, request.what, request.signal);
        }
      }
    } finally {
      if (oneCall) await job.releaseAll();
    }
  }

  private async send(server: string, model: string, act: ContentStudioAct, request: ChatRequest): Promise<ChatResponse> {
    const client = await this.host.factory.clientFor(server);
    const upstream = isUpstreamModelId(model);
    const clock = request.timeoutMs === undefined ? undefined : AbortSignal.timeout(request.timeoutMs);
    const signal = clock === undefined ? request.signal
      : request.signal === undefined ? clock : AbortSignal.any([request.signal, clock]);
    const messages = request.system === undefined
      ? [{ role: 'user' as const, content: request.prompt }]
      : [{ role: 'system' as const, content: request.system }, { role: 'user' as const, content: request.prompt }];
    try {
      return await client.chat({
        model,
        messages,
        maxTokens: request.maxTokens,
        thinking: request.thinking,
        act,
        ...(upstream || request.temperature === undefined ? {} : { temperature: request.temperature }),
        // JSON on a local model only: Crucible turns `json_object` into nothing on
        // Anthropic (only a json_schema becomes a forced tool), and the cloud
        // compilation carries its JSON contract in the system turn, as it did.
        ...(upstream || request.responseFormat === undefined ? {} : { responseFormat: request.responseFormat }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (err) {
      if (clock?.aborted && !request.signal?.aborted) {
        throw new CrucibleCallError(
          'unreachable',
          `${request.what} on ${model} did not finish within ${Math.round(request.timeoutMs! / 1000)} s on "${server}".`,
          server,
        );
      }
      throw err;
    }
  }

  private readAnswer(answer: ChatResponse, server: string, model: string, act: ContentStudioAct, request: ChatRequest): ChatResult {
    const usage = answer.usage === null ? null : { ...answer.usage };
    if (answer.finishReason === 'length') {
      throw new CrucibleCallError(
        'truncated',
        `the answer to ${request.what} from ${model} on "${server}" was cut off at its ${request.maxTokens}-token ` +
          `ceiling (${usage?.completionTokens ?? 'unstated'} output tokens, ${answer.content.length} chars of text). ` +
          `A truncated answer must not be used, so nothing is returned.`,
        server,
      );
    }
    log.info(
      `[crucible] ${request.what}: ${model} on "${server}" (${act}) answered ${answer.content.length} chars, ` +
        `finish ${answer.finishReason}, tokens ${usage?.promptTokens ?? 'unstated'} in / ${usage?.completionTokens ?? 'unstated'} out`,
    );
    return { text: answer.content, finishReason: answer.finishReason, usage, server, model, act };
  }

  /** The check before sending, against what the server states the model is loaded with. */
  private async checkContext(job: JobLeases, server: string, model: string, request: ChatRequest): Promise<void> {
    const facts = job.contextFacts(server, model);
    let ceiling: number | null = null;
    if (facts.maxModelLen === null && facts.loadedAt === null) ceiling = await this.ceilingFor(server, model);
    checkBeforeSending({
      model,
      server,
      what: request.what,
      promptChars: request.prompt.length + (request.system?.length ?? 0),
      maxTokens: request.maxTokens,
      loaded: loadedContextOf({ maxModelLen: facts.maxModelLen, loadedAt: facts.loadedAt, ceiling }),
    });
  }

  /** The host's ceiling for a model (`generate` row's `context_ceilings`), or null when it states none. */
  private async ceilingFor(server: string, model: string): Promise<number | null> {
    try {
      const record = await (await this.host.factory.clientFor(server)).capability();
      const generate = record.classes.find((row) => row.capability === 'generate');
      const row = generate?.contextCeilings?.find((c) => c.model === model);
      return row?.tokens ?? null;
    } catch {
      // Unreadable is not a ceiling; the check refuses by name with nothing stated.
      return null;
    }
  }

  // ── decide ────────────────────────────────────────────────────────────────

  /**
   * One decision (plan 10, PHASE22-DECIDE). Exported for the chaptering service
   * another agent is finishing; P2 wires no caller. The model is required: the
   * routing names the scorer, and this door never picks one.
   */
  async decide(request: DecideRequest): Promise<DecideResponse> {
    const model = this.requireCrucibleModel(request.model, request.what);
    if (isUpstreamModelId(model)) {
      throw new CrucibleCallError(
        'refused',
        `${request.what} named ${model}; no upstream returns a distribution, so decide runs on a local model only.`,
        null, 400, 'decide_needs_logprobs',
      );
    }
    this.throwIfAborted(request.signal, request.what);
    const oneCall = request.job === undefined;
    const job = request.job ?? this.job(request.what);
    try {
      const server = job.server ?? this.host.servers.selected();
      await this.venue(server, 'decide');
      job.server ??= server;
      const state = typeof request.state === 'string' ? request.state : JSON.stringify(request.state);
      request.trace?.push({
        what: request.what,
        model,
        chars: state.length,
        at: new Date().toISOString(),
        prompt: `${state}\n\n[decide: ${Object.keys(request.questions).join(', ')}]`,
        server,
      });
      const need = estimateTokens(state.length);
      let reensured = false;
      for (;;) {
        await job.hold(server, model, { act: 'decide', need, signal: request.signal });
        job.assertHeld(server, model);
        const facts = job.contextFacts(server, model);
        checkBeforeSending({
          model, server, what: request.what, promptChars: state.length, maxTokens: 0,
          loaded: loadedContextOf({ ...facts, ceiling: null }),
        });
        try {
          const client = await this.host.factory.clientFor(server);
          return await client.decide(
            { model, state: request.state, questions: request.questions, ...(request.missing === undefined ? {} : { missing: request.missing }) },
            { act: 'decide', ...(request.signal === undefined ? {} : { signal: request.signal }) },
          );
        } catch (err) {
          if (!reensured && err instanceof CrucibleRefused && err.code === 'model_not_resident') {
            reensured = true;
            job.forget(server, model);
            continue;
          }
          if (err instanceof CrucibleServerError && err.code === 'decide_not_served') {
            throw new CrucibleCallError('decide_not_served', `"${server}" cannot serve ${request.what} on ${model}: ${err.serverMessage}`, server, err.status, err.code);
          }
          throw this.refusal(err, server, model, request.what, request.signal);
        }
      }
    } finally {
      if (oneCall) await job.releaseAll();
    }
  }

  // ── the venue and the act ─────────────────────────────────────────────────

  /**
   * The server, checked, and the act it takes. Every refusal names the fix:
   * Settings › Crucible Servers is where the selection, the pause and the keys
   * live. Nothing is sent to any other server (Q14, #205).
   */
  private async venue(server: string, want: 'generate' | 'decide'): Promise<{ act: ContentStudioAct }> {
    const row = this.host.servers.routingView().servers.find((entry) => entry.name === server);
    if (row?.paused === true) {
      throw new CrucibleCallError('paused', `"${server}" is paused in Settings › Crucible Servers; its AI work waits until it is set to Running.`, server);
    }
    const answer = await this.host.probes.reach(server);
    if (answer.probe.outcome !== 'ok') {
      throw new CrucibleCallError(
        'unreachable',
        `"${server}" cannot take AI work (${answer.reach.replace(/_/g, ' ')}): ${answer.probe.message}`,
        server,
      );
    }
    const facts = answer.probe.facts;
    if (facts.needsUpdate) {
      throw new CrucibleCallError('needs_update', `"${server}" runs Crucible ${facts.version}, older than ContentStudio can use. Update it there.`, server);
    }
    if (want === 'decide') {
      const row = facts.capabilities?.find((c) => c.capability === 'decide');
      if (row === undefined || !row.enabled) {
        throw new CrucibleCallError(
          'decide_not_served',
          `"${server}" does not serve the decide class${row === undefined ? '' : ` (${row.reason ?? 'no reason stated'})`}; ` +
            `snap needs Crucible 1.0.24 or newer with its decide door.`,
          server,
        );
      }
      return { act: 'decide' };
    }
    if (facts.generationAct === null) {
      throw new CrucibleCallError(
        'act_undecided',
        `"${server}"'s capability record could not be read (${facts.capabilitiesUnread ?? 'no reason stated'}), so the act ` +
          `to send cannot be chosen; a guessed act is refused 400 unknown_act by a server that does not know it.`,
        server,
      );
    }
    if (facts.generationAct === 'analysis' && !this.analysisNoted.has(server)) {
      this.analysisNoted.add(server);
      log.warn(`[crucible] "${server}" predates 1.0.24; sending act analysis`);
    }
    return { act: facts.generationAct };
  }

  // ── refusals ──────────────────────────────────────────────────────────────

  private requireCrucibleModel(model: string, what: string): string {
    const retired = RETIRED_PREFIXES.find((prefix) => model.startsWith(prefix));
    if (retired !== undefined || model.startsWith('claude-cli:') || model.trim() === '') {
      throw new CrucibleCallError(
        'invalid_model',
        `${what} was handed "${model}", which is not a Crucible model id. Local models are Crucible ids ` +
          `(qwen3.8-27b-4bit), cloud ones anthropic/<id>; claude -p never reaches this door.`,
      );
    }
    return model;
  }

  private throwIfAborted(signal: AbortSignal | undefined, what: string): void {
    if (signal?.aborted) throw new JobCancelledError(`before ${what} was sent`);
  }

  private refusal(err: unknown, server: string, model: string, what: string, signal?: AbortSignal): unknown {
    if (signal?.aborted || isAbortError(err)) return new JobCancelledError(`${what} was aborted mid-flight`);
    if (err instanceof CrucibleRefused && err.code === 'upstream_unconfigured') {
      const upstream = upstreamOf(model) ?? 'that';
      return new CrucibleCallError(
        'upstream_unconfigured',
        `"${server}" has no ${upstream} key, so ${model} cannot run there. Add it on that server in Settings › ` +
          `Crucible Servers › ${server} › Keys; nothing was sent anywhere else.`,
        server, err.status, err.code,
      );
    }
    if (err instanceof CrucibleProtocolError) {
      return new CrucibleCallError('protocol_error', `"${server}" answered ${what} in a shape ContentStudio cannot use: ${err.message}`, server);
    }
    return callRefusalOf(err, server);
  }
}

// ── the process-wide door ───────────────────────────────────────────────────

let installed: CrucibleTransport | null = null;

/** main.ts (and the CLI) install the one transport once the registry exists. */
export function installCrucibleTransport(transport: CrucibleTransport | null): void {
  installed = transport;
}

/** The installed transport, or a named refusal: a call made before main.ts wired Crucible is a bug, not a wait. */
export function crucibleTransport(): CrucibleTransport {
  if (installed === null) {
    throw new CrucibleCallError(
      'unreachable',
      'the Crucible transport is not installed in this process (main.ts installs it at startup; a CLI installs its own).',
    );
  }
  return installed;
}
