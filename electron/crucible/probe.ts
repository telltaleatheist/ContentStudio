/**
 * WHAT A CRUCIBLE SERVER SAYS ABOUT ITSELF, as a named outcome.
 *
 * Ported from Briefcase's backend/src/crucible/probe.ts (BookForge's
 * electron/crucible/probe.ts before it). `ping` is unauthenticated and `info`
 * is not, so the pair tells apart the five outcomes plan section 4 names:
 *
 *   nothing there             → `unreachable`
 *   something, not a Crucible → `not_a_crucible`
 *   a Crucible, bad token     → `wrong_token`
 *   a Crucible, other API     → `version_mismatch`
 *   the probe's own clock     → `timeout` (a sleeping PC answers nothing)
 *   a Crucible                → `ok`, with its facts
 *
 * and `refused` for any other named refusal (an orchestrator with no engine),
 * in its own words.
 *
 * Every probe carries a clock (3 s per call, plan section 4): a sleeping Mac
 * answers nothing for minutes, and a Test button that hangs is worse than one
 * that says so.
 *
 * `ok` is not permission to submit. It says the address answers; whether the
 * lane is free is settled at the door by `POST /v1/jobs` (P3). `busyLine` is a
 * display, read from `/v1/activity`, which is a preflight and never a lock.
 */
import * as log from 'electron-log';
import {
  CrucibleAuthError,
  CrucibleCapabilityUndecided,
  CrucibleNotACrucible,
  CrucibleUnreachable,
  CrucibleVersionError,
  type Activity,
  type CrucibleClient,
  type Ping,
} from '@crucible/client';
import type { CrucibleClientFactory } from './client-factory';
import type { CrucibleServers } from './servers';
import { EngineResolveError, type ResolvedEngine } from './engine-resolve';
import { transportFailureCause } from './transport-failure';
import type {
  CapabilityFact,
  CrucibleProbeAnswer,
  CrucibleProbeResult,
  ServerFacts,
  ServerReach,
} from './wire';

/**
 * The oldest Crucible ContentStudio routes work to (plan section 4). An older
 * server is shown as "needs update" and gets no work (the transport refuses
 * it by name). 1.0.32 since P2: the decide door and its SDK method arrived in
 * 1.0.24, and the Qwen3-ASR lineup the transcription phase sends (#203, #206)
 * in 1.0.30; 1.0.32 is the release Briefcase checked the whole lineup against
 * (plan 0a). The acts are still detected per server from `capability()`, never
 * from this number (plan 6.4).
 */
export const MIN_CRUCIBLE = '1.0.32';
/** The clock on each probe call (plan section 4: a 3 s clock). */
export const PROBE_TIMEOUT_MS = 3_000;
/** How long a probe answers `reach()` before it is asked again (plan section 4: 15 s). The Test button bypasses it. */
export const PROBE_CACHE_MS = 15_000;

/** The capability classes ContentStudio reads off a server (plan sections 6.4, 8, 9, 10). */
export const PROBED_CLASSES: readonly string[] = ['generate', 'analysis', 'decide', 'asr', 'align', 'denoise'];

type Failure = Exclude<CrucibleProbeResult, { outcome: 'ok' }>;

/** `a` compared with `b` as dotted release numbers: negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((part) => Number.parseInt(part, 10));
  const pb = b.split(/[.+-]/).map((part) => Number.parseInt(part, 10));
  for (let i = 0; i < 3; i += 1) {
    const x = Number.isFinite(pa[i]) ? pa[i]! : 0;
    const y = Number.isFinite(pb[i]) ? pb[i]! : 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * The probe's own clock ran out. The SDK rethrows the platform's
 * `TimeoutError` DOMException untouched rather than folding it into
 * `CrucibleUnreachable` (its client.ts, `ProbeOptions`), so the two can be
 * told apart here. Only the clock's name counts: an `AbortError` would be a
 * caller's cancel, and nothing cancels a probe.
 */
function isTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as Error).name === 'TimeoutError';
}

/**
 * One failure as the outcome a row shows. Every branch names what to fix; the
 * last keeps the message it was given rather than inventing one.
 */
export function failureOutcome(err: unknown, at: string, clockMs: number = PROBE_TIMEOUT_MS): Failure {
  if (isTimeout(err)) {
    return {
      outcome: 'timeout',
      message: `${at} did not answer within ${clockMs / 1000} s. It may be asleep or off; a wrong address usually fails at once instead.`,
    };
  }
  if (err instanceof CrucibleUnreachable || transportFailureCause(err) !== null) {
    return {
      outcome: 'unreachable',
      message: `Nothing answered at ${at}. Check the address, that Crucible is running there, and that this computer can reach it.`,
    };
  }
  if (err instanceof CrucibleNotACrucible) {
    return {
      outcome: 'not_a_crucible',
      message: `${at} answered, but it is not a Crucible. Check the address: it is the base URL, without /v1.`,
    };
  }
  if (err instanceof CrucibleAuthError) {
    return {
      outcome: 'wrong_token',
      message: `${at} is a Crucible and refused this computer's access key (${err.serverMessage}). Remove it and connect again.`,
    };
  }
  if (err instanceof CrucibleVersionError) {
    return {
      outcome: 'version_mismatch',
      message: `${at} speaks Crucible API version ${err.serverApiVersion ?? 'unknown'}; ContentStudio speaks `
        + `${err.clientApiVersion}. Update whichever is older.`,
    };
  }
  if (err instanceof EngineResolveError) return { outcome: 'refused', message: err.message };
  return { outcome: 'refused', message: err instanceof Error ? err.message : String(err) };
}

/**
 * The holder of the card, in one sentence, or null when the lane accepts work
 * and nothing else claims the engine. A claim by anything but ContentStudio is
 * busy even with the lane free: a streaming session, or Crucible's own
 * settlement clearing the card after a lapsed lease. The sentence is the
 * shape plan section 3.2 wants on a parked row: "busy: bookforge, tts 62% done".
 */
export function busyLineOf(activity: Activity): string | null {
  const claim = activity.claim?.heldBy?.trim();
  if (claim && !/^contentstudio\b/i.test(claim)) return `busy: the card is held by ${claim}`;
  if (activity.slots.accelerated.acceptsWork) return null;
  const job = activity.running[0];
  if (job !== undefined) {
    const done = job.progress === null ? '' : ` ${Math.round(job.progress * 100)}% done`;
    return `busy: ${job.client ?? 'another app'}, ${job.type}${done}`;
  }
  return 'busy: the GPU is not accepting work right now';
}

export function reachOf(result: CrucibleProbeResult): ServerReach {
  switch (result.outcome) {
    case 'ok': return result.facts.busyLine === null ? 'ready' : 'busy';
    case 'unreachable': return 'unreachable';
    case 'timeout': return 'timeout';
    case 'wrong_token': return 'bad_token';
    case 'not_a_crucible': return 'not_crucible';
    case 'version_mismatch': return 'version_mismatch';
    case 'refused': return 'refused';
  }
}

/** What one probe needs, so the same steps serve a registered server and unregistered credentials. */
export interface ProbeSteps {
  /** Unauthenticated ping at the address as given. */
  ping(): Promise<Ping>;
  /** `info` at the address, plus the one orchestrator hop. */
  resolve(): Promise<ResolvedEngine>;
  /** A clocked client on the resolved engine, for activity and capability. */
  engine(resolved: ResolvedEngine): Promise<CrucibleClient> | CrucibleClient;
}

/** ping, then info (through the hop), then activity and capability on the engine. */
export async function probeWith(steps: ProbeSteps, at: string): Promise<CrucibleProbeResult> {
  let resolved: ResolvedEngine;
  let engine: CrucibleClient;
  try {
    const pong = await steps.ping();
    if (pong.apiVersion !== 1) {
      return {
        outcome: 'version_mismatch',
        message: `${at} speaks Crucible API version ${pong.apiVersion}; ContentStudio speaks 1. Update whichever is older.`,
      };
    }
    resolved = await steps.resolve();
    engine = await steps.engine(resolved);
  } catch (err) {
    return failureOutcome(err, at);
  }
  const info = resolved.info;
  if (info.server.apiVersion !== 1) {
    return {
      outcome: 'version_mismatch',
      message: `${at} speaks Crucible API version ${info.server.apiVersion}; ContentStudio speaks 1. Update whichever is older.`,
    };
  }
  let busyLine: string | null = null;
  let resident: string | null = null;
  let activityUnread: string | null = null;
  try {
    const activity = await engine.activity();
    busyLine = busyLineOf(activity);
    resident = activity.resident?.id ?? null;
  } catch (err) {
    // The activity read is a display, so a server that cannot answer it is
    // still a server. But a transport, clock or token failure here means the
    // engine itself is not answering, and that IS the probe's answer.
    const failure = failureOutcome(err, at);
    if (failure.outcome === 'wrong_token' || failure.outcome === 'unreachable' || failure.outcome === 'timeout') return failure;
    activityUnread = failure.message;
  }
  let capabilities: CapabilityFact[] | null = null;
  let capabilitiesUnread: string | null = null;
  let generationAct: ServerFacts['generationAct'] = null;
  try {
    const record = await engine.capability({ timeoutMs: PROBE_TIMEOUT_MS });
    capabilities = record.classes
      .filter((row) => PROBED_CLASSES.includes(row.capability))
      .map((row) => ({
        capability: row.capability,
        enabled: row.enabled,
        selected: row.selected,
        route: row.route,
        reason: row.reason,
      }));
    // Feature detection, never version-sniffing (plan section 4): a server that
    // lists `generate` takes 1.0.24's acts; one that does not takes `analysis`.
    generationAct = record.classes.some((row) => row.capability === 'generate') ? 'generate' : 'analysis';
  } catch (err) {
    // Not a probe failure: the server answered info and activity. The facts
    // say the rows are unknown, and why. The act stays null, so the caller
    // that needs it (P2's act choice) refuses by name rather than guessing one.
    capabilitiesUnread = err instanceof CrucibleCapabilityUndecided
      ? `${at} has not decided its capabilities yet (crucible capability --write has not run there).`
      : failureOutcome(err, at).message;
  }
  const facts: ServerFacts = {
    serverName: info.server.name,
    version: info.server.version,
    apiVersion: info.server.apiVersion,
    platform: info.host.platform,
    arch: info.host.arch,
    backend: info.host.backend,
    gpu: info.host.gpu === null ? null : { vendor: info.host.gpu.vendor, name: info.host.gpu.name, vramBytes: info.host.gpu.vramBytes },
    jobTypes: [...info.jobTypes],
    busyLine,
    resident,
    activityUnread,
    // An unstated version is not an old one: nothing to warn about (the calls themselves answer).
    needsUpdate: info.server.version !== null && compareVersions(info.server.version, MIN_CRUCIBLE) < 0,
    engineUrl: resolved.through === null ? null : resolved.url,
    capabilities,
    capabilitiesUnread,
    generationAct,
  };
  return { outcome: 'ok', facts };
}

/**
 * Probes with a 15 s cache for `reach()` (the pane's first paint, and P3's
 * lanes), and a fresh `test()` for the Test button. The cache is dropped for a
 * server whenever the registry changes.
 */
export class CrucibleProbes {
  private readonly cache = new Map<string, CrucibleProbeAnswer>();
  private readonly inFlight = new Map<string, Promise<CrucibleProbeAnswer>>();

  /** The clock, replaceable by a keeper. */
  now: () => number = Date.now;

  constructor(
    private readonly factory: CrucibleClientFactory,
    private readonly servers: CrucibleServers,
  ) {
    servers.onChange((change) => {
      if (change.server === null) return;
      this.cache.delete(change.server);
    });
  }

  /** A probe no older than {@link PROBE_CACHE_MS}. */
  async reach(name: string): Promise<CrucibleProbeAnswer> {
    const cached = this.cache.get(name);
    if (cached !== undefined && this.now() - cached.at < PROBE_CACHE_MS) return cached;
    return this.test(name, false);
  }

  /** A probe taken now. `fresh` also drops the cached orchestrator hop. */
  async test(name: string, fresh = true): Promise<CrucibleProbeAnswer> {
    const running = this.inFlight.get(name);
    if (running !== undefined && !fresh) return running;
    const request = this.probeRegistered(name, fresh).finally(() => {
      if (this.inFlight.get(name) === request) this.inFlight.delete(name);
    });
    this.inFlight.set(name, request);
    return request;
  }

  private async probeRegistered(name: string, fresh: boolean): Promise<CrucibleProbeAnswer> {
    let result: CrucibleProbeResult;
    try {
      if (fresh) this.factory.forgetResolved(name);
      const address = this.factory.addressClientFor(name, { timeoutMs: PROBE_TIMEOUT_MS });
      result = await probeWith({
        ping: () => address.ping({ timeoutMs: PROBE_TIMEOUT_MS }),
        resolve: () => this.factory.resolve(name),
        engine: () => this.factory.clientFor(name, { timeoutMs: PROBE_TIMEOUT_MS }),
      }, `"${name}" (${address.url})`);
    } catch (err) {
      // An unknown name or a corrupt registry: each is already a named refusal.
      result = { outcome: 'refused', message: err instanceof Error ? err.message : String(err) };
    }
    const answer: CrucibleProbeAnswer = { server: name, reach: reachOf(result), probe: result, at: this.now() };
    if (this.servers.names().includes(name)) this.cache.set(name, answer);
    if (result.outcome !== 'ok') log.debug(`[crucible] Probe of "${name}": ${result.outcome}`);
    return answer;
  }

  /** A probe of credentials that are not registered yet. Never cached. */
  async probeCredentials(url: string, token: string, at = url): Promise<CrucibleProbeResult> {
    const address = this.factory.clientForCredentials(url, token, { timeoutMs: PROBE_TIMEOUT_MS });
    return probeWith({
      ping: () => address.ping({ timeoutMs: PROBE_TIMEOUT_MS }),
      resolve: () => this.factory.resolveCredentials(url, token),
      engine: (resolved) => this.factory.clientForCredentials(resolved.url, token, { timeoutMs: PROBE_TIMEOUT_MS }),
    }, at);
  }
}
