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
 * never defaulted to `stop`, plan 0a), read off a STREAM (chat-stream.ts) so
 * the job's stall clock hears every chunk (P3). The body rules are Briefcase's
 * target.ts with two ContentStudio rulings over them: `max_tokens` IS sent to
 * Anthropic, 16000, because Crucible fills 4096 when it is absent and a
 * thinking model spends that on reasoning (LEDGER #187); and `thinking` is
 * stated on every call, cloud included, where Crucible drops it and says so in
 * `X-Crucible-Sampling` (the 27B manifest states no default, so an unstated
 * `thinking` would be two models behaving differently for one call, plan 1).
 * Residency and the lease are lease.ts (BookForge's lease.ts, Briefcase's
 * residency).
 *
 * THE LANE IS THE VENUE (P3, docs/crucible/P3.md "What transport.ts must call").
 * Every call runs inside `queueAITask` and reads the step's hooks
 * (`crucibleStepHooks()`): a GPU call runs on `hooks.server` and nowhere else
 * (the job's venue: the fast pin's server or the selected one, LEDGER #205); a
 * cloud call has no lane and goes to the SELECTED server, the one whose key the
 * routing dialog judged Claude against (plan 0 #20). Every load and lease is
 * written to the in-flight ledger the moment the server admits it, settled when
 * it ends, and a hook's abort signal (Stop, a park, a stall, quit) is handed to
 * every fetch. A busy card is NOT retried here: the SDK's refusal travels up as
 * the `cause` of the door's own, and the lane parks the job on it.
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
  type DecideQuestion,
  type DecideResponse,
} from '@crucible/client';
import { JobCancelledError, isAbortError } from '../services/metadata/cancellation';
import { isUpstreamModelId, upstreamOf, type ContentStudioAct } from './acts';
import { readChatStream, refusalOf, type StreamedChat } from './chat-stream';
import type { CrucibleClientFactory } from './client-factory';
import { checkBeforeSending, estimateTokens, loadedContextOf, tokensNeeded } from './context-check';
import { CrucibleCallError } from './errors';
import { crucibleStepHooks, type CrucibleStepHooks } from './lanes';
import { JobLeases, callRefusalOf, withJobLeases, type LeaseHost, type LeaseTimings } from './lease';
import * as fs from 'fs';
import * as path from 'path';

/**
 * A development capture of every chat body as sent (the Crucible agent's ask, 2026-09-26: the Mac
 * 27B's `metal::malloc` crash reproduces only from the exact bytes, and a rebuild from the prompt
 * code was 24% short of the tokenizer's count). Set CONTENTSTUDIO_DUMP_CHAT_BODIES to an absolute
 * directory and each call writes `<n>-<act>-<model>.body.json` (the request body, byte for byte)
 * and `.meta.json` (server, path, the headers the transport sets, load context, what). engineFetch
 * adds User-Agent, X-Crucible-Client, Authorization and X-Crucible-Api on top. Unset, nothing is
 * written and nothing is checked.
 */
const DUMP_CHAT_BODIES_ENV = 'CONTENTSTUDIO_DUMP_CHAT_BODIES';
let dumpSeq = 0;
function dumpChatBody(meta: Record<string, unknown>, body: string): void {
  const dir = process.env[DUMP_CHAT_BODIES_ENV];
  if (!dir) return;
  if (!path.isAbsolute(dir)) throw new Error(`${DUMP_CHAT_BODIES_ENV} must be an absolute directory, got "${dir}"`);
  fs.mkdirSync(dir, { recursive: true });
  const n = String(++dumpSeq).padStart(3, '0');
  const slug = `${n}-${String(meta['act'])}-${String(meta['model']).replace(/[^a-z0-9.-]+/gi, '_')}`;
  fs.writeFileSync(path.join(dir, `${slug}.body.json`), body);
  fs.writeFileSync(path.join(dir, `${slug}.meta.json`), JSON.stringify({ ...meta, sent_at: new Date().toISOString(), body_bytes: Buffer.byteLength(body) }, null, 2));
}
import type { CrucibleProbes } from './probe';
import type { CrucibleServers } from './servers';

/**
 * `max_tokens` on every `anthropic/` chat (LEDGER #187). One ceiling, sized for
 * thinking: Sonnet 5 thinks by default, and at a ceiling it cannot finish
 * inside it returns NO text. Crucible fills 4096 when it is absent (upstreams.py
 * ANTHROPIC_MAX_TOKENS_DEFAULT), so it is always sent.
 */
export const ANTHROPIC_MAX_TOKENS = 16000;

/** How often a streamed answer tells the stall clock it is alive (P3): a beat per second at most. */
const BEAT_EVERY_MS = 1_000;

/** One line of a run's prompt trace, as AIManagerService.promptTrace has always held it, plus the server. */
export interface PromptTraceRecord {
  what: string;
  model: string;
  chars: number;
  at: string;
  prompt: string;
  /** The Crucible server that ran it, or `claude -p` for the outside transport (Law 8). */
  server: string;
  /**
   * P4: the call's output budget (0 on a decide, whose need is its state plus the questions) and
   * the load context it asked for, so a finished item can say how big each local call was
   * (context-assertion.ts). Absent on a claude -p entry and on a trace written before P4.
   */
  maxTokens?: number;
  loadContext?: number | null;
  act?: 'generate' | 'decide';
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
  /**
   * `X-Crucible-Sampling`, parsed: where each sampling key the engine used came from (`request`,
   * `manifest`, `engine`, `dropped`). Informational (plan 0a: read tolerantly), null when the
   * server sent none or it does not parse; a caller that needs a key to be `request` checks it.
   */
  sampling: Record<string, string> | null;
}

export interface DecideRequest {
  model: string;
  state: unknown;
  questions: Readonly<Record<string, DecideQuestion>>;
  /** Plan 0a, N7: `report` (null + missingLabels), with the floor the client's own rule. */
  missing?: 'refuse' | 'report';
  /**
   * The context to load the scorer at when this job loads it (snap's states run to ~12k tokens plus
   * the questions, so the 9B loads at 16,384: plan 7.3's "Snap assign" row). Absent: the server's
   * default, which on 1.0.24+ is 8k and refuses a snap state over it before sending.
   */
  loadContext?: number;
  job?: JobLeases;
  signal?: AbortSignal;
  what: string;
  trace: PromptTraceRecord[] | null;
}

export interface TransportHost {
  servers: Pick<CrucibleServers, 'selected' | 'routingView'>;
  factory: Pick<CrucibleClientFactory, 'clientFor' | 'engineFetch'>;
  probes: Pick<CrucibleProbes, 'reach'>;
  /** The step's lane hooks. Default: lanes.ts `crucibleStepHooks()`; a keeper may pass its own. */
  hooks?: () => CrucibleStepHooks;
}

/** The model strings the old transports used. A caller still holding one is refused by name. */
const RETIRED_PREFIXES = ['ollama:', 'claude:', 'openai:'] as const;

/** Every signal that should end this call, as one (a missing one is left out, never invented). */
function anySignal(...signals: Array<AbortSignal | null | undefined>): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => s !== null && s !== undefined);
  if (present.length === 0) return undefined;
  return present.length === 1 ? present[0] : AbortSignal.any(present);
}

export class CrucibleTransport {
  /** Servers already told they get `analysis` this session (plan 6.4: one line per server). */
  private readonly analysisNoted = new Set<string>();
  private readonly leaseHost: LeaseHost;
  private readonly hooksOf: () => CrucibleStepHooks;

  constructor(
    private readonly host: TransportHost,
    /** Only a keeper passes this: short clocks for the heartbeat and the stream retry. */
    private readonly timings: Partial<LeaseTimings> = {},
  ) {
    this.leaseHost = { client: (server, options) => host.factory.clientFor(server, options) };
    this.hooksOf = host.hooks ?? crucibleStepHooks;
  }

  /** A new job's leases. The caller releases it once, in its `finally` (model-lifecycle.ts does). */
  job(what: string): JobLeases {
    return new JobLeases(this.leaseHost, what, this.timings);
  }

  /**
   * Hold `model` on `server` for the whole of `fn` (plan 13.3), released on
   * every way out. `fn` is handed the job, to pass to each call it makes. Runs
   * inside a lane like every call; `server` must be the lane's (a GPU step never
   * runs anywhere else, P3).
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
        const hooks = this.hooksOf();
        const onLane = this.gpuServer(hooks, job, options.what);
        if (onLane !== server) {
          throw new CrucibleCallError('refused', `${options.what} asked for "${server}", and its lane runs on "${onLane}"; a GPU step never moves (P3, #205).`, server);
        }
        const venue = await this.venue(server, options.act ?? 'generate');
        await job.hold(server, model, {
          act: venue.act, need: null, loadContext: options.loadContext, signal: anySignal(options.signal, hooks.signal), hooks,
        });
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
    const hooks = this.hooksOf();
    const signal = anySignal(request.signal, hooks.signal);
    this.throwIfAborted(signal, request.what);

    const oneCall = request.job === undefined;
    const job = request.job ?? this.job(request.what);
    try {
      const server = upstream ? this.host.servers.selected() : this.gpuServer(hooks, job, request.what);
      const venue = await this.venue(server, 'generate');
      if (!upstream) job.server ??= server;
      request.trace?.push({
        what: request.what,
        model,
        chars: request.prompt.length + (request.system?.length ?? 0),
        at: new Date().toISOString(),
        prompt: request.system === undefined ? request.prompt : `${request.system}\n\n${request.prompt}`,
        server,
        maxTokens: request.maxTokens,
        loadContext: upstream ? null : request.loadContext ?? null,
        act: 'generate',
      });

      const need = tokensNeeded(request.prompt.length + (request.system?.length ?? 0), request.maxTokens);
      if (!upstream && request.loadContext !== undefined && need > request.loadContext) {
        throw new CrucibleCallError(
          'over_context',
          `${request.what} needs ~${need} tokens (~${estimateTokens(request.prompt.length + (request.system?.length ?? 0))} ` +
            `of prompt plus a ${request.maxTokens}-token output budget) and was sized to load ${model} at ` +
            `${request.loadContext}. Nothing was sent and nothing was cut.`,
          server,
        );
      }

      let reensured = false;
      for (;;) {
        if (!upstream) {
          await job.hold(server, model, { act: venue.act, need, loadContext: request.loadContext, signal, hooks });
          job.assertHeld(server, model);
          await this.checkContext(job, server, model, request);
        }
        try {
          const answer = await this.send(server, model, venue.act, request, signal, hooks);
          hooks.beat();
          return this.readAnswer(answer, server, model, venue.act, request);
        } catch (err) {
          if (!upstream && !reensured && err instanceof CrucibleRefused && err.code === 'model_not_resident') {
            reensured = true;
            log.warn(`[crucible] ${request.what}: ${model} is no longer resident on "${server}" (${err.serverMessage}); making it resident again, once`);
            job.forget(server, model);
            continue;
          }
          throw this.refusal(err, server, model, request.what, signal);
        }
      }
    } finally {
      if (oneCall) await job.releaseAll();
    }
  }

  /**
   * One streamed completion on the chat door (chat-stream.ts). The body is the one the SDK's
   * `chat()` would send (its `#chatRequest` keys), plus `stream` and the usage frame.
   */
  private async send(
    server: string,
    model: string,
    act: ContentStudioAct,
    request: ChatRequest,
    signal: AbortSignal | undefined,
    hooks: CrucibleStepHooks,
  ): Promise<StreamedChat & { sampling: Record<string, string> | null }> {
    const upstream = isUpstreamModelId(model);
    const clock = request.timeoutMs === undefined ? undefined : AbortSignal.timeout(request.timeoutMs);
    const combined = anySignal(signal, clock);
    const messages = request.system === undefined
      ? [{ role: 'user', content: request.prompt }]
      : [{ role: 'system', content: request.system }, { role: 'user', content: request.prompt }];
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: request.maxTokens,
      // Stated on every call, cloud included: Crucible does not forward it to Anthropic and
      // says so in X-Crucible-Sampling (`dropped`), which is the declared state (plan 6.3).
      chat_template_kwargs: { enable_thinking: request.thinking },
    };
    // Local only (LEDGER #194): no sampling parameter crosses to a cloud upstream.
    if (!upstream && request.temperature !== undefined) body['temperature'] = request.temperature;
    // JSON on a local model only: Crucible turns `json_object` into nothing on Anthropic
    // (only a json_schema becomes a forced tool), and the cloud compilation carries its JSON
    // contract in the system turn, as it did.
    if (!upstream && request.responseFormat !== undefined) body['response_format'] = request.responseFormat;
    const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'X-Crucible-Act': act };
    const bytes = JSON.stringify(body);
    dumpChatBody({ server, path: '/v1/openai/chat/completions', act, model, headers, loadContext: request.loadContext ?? null, what: request.what }, bytes);
    try {
      const { response, url } = await this.host.factory.engineFetch(server, '/v1/openai/chat/completions', {
        method: 'POST',
        headers,
        body: bytes,
        ...(combined === undefined ? {} : { signal: combined }),
      });
      if (!response.ok) throw await refusalOf(response, url);
      let last = 0;
      const streamed = await readChatStream(response, url, () => {
        const now = Date.now();
        if (now - last < BEAT_EVERY_MS) return;
        last = now;
        hooks.beat();
      });
      return { ...streamed, sampling: samplingOf(response.headers.get('X-Crucible-Sampling')) };
    } catch (err) {
      if (clock?.aborted && !signal?.aborted) {
        throw new CrucibleCallError(
          'unreachable',
          `${request.what} on ${model} did not finish within ${Math.round(request.timeoutMs! / 1000)} s on "${server}".`,
          server,
        );
      }
      throw err;
    }
  }

  private readAnswer(answer: StreamedChat & { sampling: Record<string, string> | null }, server: string, model: string, act: ContentStudioAct, request: ChatRequest): ChatResult {
    const usage = answer.usage;
    if (answer.finishReason === 'length') {
      throw new CrucibleCallError(
        'truncated',
        `the answer to ${request.what} from ${model} on "${server}" was cut off at its ${request.maxTokens}-token ` +
          `ceiling (${usage?.completionTokens ?? 'unstated'} output tokens, ${answer.text.length} chars of text` +
          `${answer.reasoningChars > 0 ? `, ${answer.reasoningChars} of reasoning` : ''}). A truncated answer must ` +
          `not be used, so nothing is returned.`,
        server,
      );
    }
    log.info(
      `[crucible] ${request.what}: ${model} on "${server}" (${act}) answered ${answer.text.length} chars, ` +
        `finish ${answer.finishReason}, tokens ${usage?.promptTokens ?? 'unstated'} in / ${usage?.completionTokens ?? 'unstated'} out`,
    );
    return { text: answer.text, finishReason: answer.finishReason, usage, server, model, act, sampling: answer.sampling };
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
   * routing names the scorer, and this door never picks one. A GPU step: it runs
   * on its lane's server.
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
    const hooks = this.hooksOf();
    const signal = anySignal(request.signal, hooks.signal);
    this.throwIfAborted(signal, request.what);
    const oneCall = request.job === undefined;
    const job = request.job ?? this.job(request.what);
    try {
      const server = this.gpuServer(hooks, job, request.what);
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
        maxTokens: 0,
        loadContext: request.loadContext ?? null,
        act: 'decide',
      });
      const need = estimateTokens(state.length);
      let reensured = false;
      for (;;) {
        await job.hold(server, model, { act: 'decide', need, loadContext: request.loadContext, signal, hooks });
        job.assertHeld(server, model);
        const facts = job.contextFacts(server, model);
        checkBeforeSending({
          model, server, what: request.what, promptChars: state.length, maxTokens: 0,
          loaded: loadedContextOf({ ...facts, ceiling: null }),
        });
        try {
          const client = await this.host.factory.clientFor(server);
          const answer = await client.decide(
            { model, state: request.state, questions: request.questions, ...(request.missing === undefined ? {} : { missing: request.missing }) },
            { act: 'decide', ...(signal === undefined ? {} : { signal }) },
          );
          hooks.beat();
          return answer;
        } catch (err) {
          if (!reensured && err instanceof CrucibleRefused && err.code === 'model_not_resident') {
            reensured = true;
            job.forget(server, model);
            continue;
          }
          if (err instanceof CrucibleServerError && err.code === 'decide_not_served') {
            throw new CrucibleCallError('decide_not_served', `"${server}" cannot serve ${request.what} on ${model}: ${err.serverMessage}`, server, err.status, err.code, null, err);
          }
          throw this.refusal(err, server, model, request.what, signal);
        }
      }
    } finally {
      if (oneCall) await job.releaseAll();
    }
  }

  // ── the venue and the act ─────────────────────────────────────────────────

  /**
   * The server a GPU step runs on: its lane's, and nothing else (P3). A job that
   * already holds a server keeps it; a lane that says otherwise is refused by
   * name rather than followed onto a second card.
   */
  private gpuServer(hooks: CrucibleStepHooks, job: JobLeases, what: string): string {
    if (hooks.lane !== 'gpu' || hooks.server === null) {
      throw new CrucibleCallError('refused', `${what} is a local model call, and it reached the door on a ${hooks.lane} lane with no server; a GPU call runs on its server's lane (P3).`);
    }
    if (job.server !== null && job.server !== hooks.server) {
      throw new CrucibleCallError('refused', `${what} belongs to a job holding "${job.server}", and its lane runs on "${hooks.server}"; a job's work never moves between servers (#205).`, hooks.server);
    }
    return hooks.server;
  }

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
        server, err.status, err.code, null, err,
      );
    }
    if (err instanceof CrucibleProtocolError) {
      return new CrucibleCallError('protocol_error', `"${server}" answered ${what} in a shape ContentStudio cannot use: ${err.message}`, server, null, null, null, err);
    }
    return callRefusalOf(err, server);
  }
}

/** `X-Crucible-Sampling` as a key -> source map, or null (absent, or not a JSON object of strings). */
export function samplingOf(header: string | null): Record<string, string> | null {
  if (header === null) return null;
  try {
    const parsed: unknown = JSON.parse(header);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value;
      else if (value !== null && typeof value === 'object' && typeof (value as { source?: unknown }).source === 'string') out[key] = (value as { source: string }).source;
    }
    return out;
  } catch {
    return null;
  }
}

// ── the process-wide door ───────────────────────────────────────────────────

let installed: CrucibleTransport | null = null;

/** main.ts (and cli-lanes.ts, for a CLI) install the one transport once the registry exists. */
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
