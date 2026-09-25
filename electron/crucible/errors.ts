/**
 * Every way ContentStudio's Crucible layer refuses, each named by a `code`.
 *
 * Ported from Briefcase's backend/src/crucible/errors.ts. Never a generic
 * "something went wrong": the code says which refusal it is, so the IPC block
 * can put it on the wire and the pane can show the sentence, which always
 * carries the fix (Law 1: a missing thing fails by name).
 */
import { CrucibleProtocolError } from '@crucible/client';

export type CrucibleRegistryErrorCode =
  | 'unknown_server'
  | 'duplicate_server'
  | 'invalid_name'
  | 'invalid_url'
  | 'empty_token'
  | 'corrupt_registry';

/** A refusal from the server registry (`crucible-servers.json`). */
export class CrucibleRegistryError extends Error {
  constructor(readonly code: CrucibleRegistryErrorCode, message: string) {
    super(message);
    this.name = 'CrucibleRegistryError';
  }
}

export type CrucibleRoutingErrorCode =
  | 'corrupt_routing'
  | 'unknown_server'
  | 'no_selected_server'
  | 'no_fast_server'
  /** An immediate call on a server the user paused: it would have to wait, and nothing is queued to wait. */
  | 'server_paused'
  /** A choice that is not one: Running/Paused given something other than a yes or no. */
  | 'invalid_choice';

/** A refusal from the routing record (`crucible-routing.json`). */
export class CrucibleRoutingError extends Error {
  constructor(readonly code: CrucibleRoutingErrorCode, message: string) {
    super(message);
    this.name = 'CrucibleRoutingError';
  }
}

export type CrucibleConnectErrorCode =
  /** The pasted line is not a connect code. */
  | 'invalid_pairing'
  /** The device-code request is gone: cancelled, expired or never started here. */
  | 'pairing_not_active'
  /** The pairing or connect code named a server, and probing it did not answer `ok`. */
  | 'probe_failed'
  /** There is no Crucible on this computer to adopt. */
  | 'nothing_discovered'
  /** The clipboard could not be written. */
  | 'clipboard_unavailable'
  /** A copy asked for the local server's code at an address that server does not list. */
  | 'unknown_address'
  /** The local server lists no address another machine can reach (a loopback bind). */
  | 'not_reachable_elsewhere';

/** A refusal while adding a server. */
export class CrucibleConnectError extends Error {
  constructor(readonly code: CrucibleConnectErrorCode | string, message: string) {
    super(message);
    this.name = 'CrucibleConnectError';
  }
}

/** A refusal from the settings bridge: a patch the pane may not send. */
export class CrucibleSettingsError extends Error {
  constructor(readonly code: 'invalid_settings' | 'unknown_server', message: string) {
    super(message);
    this.name = 'CrucibleSettingsError';
  }
}

/**
 * Every way a model call through the one door (transport.ts) refuses, by name.
 *
 * Ported from Briefcase's llm/errors.ts `CrucibleChatError` and BookForge's
 * `CrucibleTextActError` (text-venue.ts): the code is carried beside the
 * message AND prefixed onto it, because a CLI, a queue row and a report show
 * `err.message` and nothing else, so "refused by name" is only true where the
 * name is in the sentence. A caller that has a declared policy for one of
 * these (the chapter pipeline's one-chapter degradation on `truncated`) reads
 * the code, never the sentence (Law 10).
 */
export type CrucibleCallErrorCode =
  /** The answer hit the output ceiling: `finish_reason: length` (LEDGER #112). Nothing is returned. */
  | 'truncated'
  /** Prompt plus output budget is over the loaded context. Thrown BEFORE sending (plan 6.1, Law 1). */
  | 'over_context'
  /** The server stated no context for the model at all, so the check before sending cannot be made (plan 0a). */
  | 'context_unstated'
  /** A sampling parameter was asked for on a cloud upstream (LEDGER #194). */
  | 'sampling_to_cloud'
  /** The selected server has no key for the upstream this model names. */
  | 'upstream_unconfigured'
  /** The model is not in the server's catalog for its backend. */
  | 'unknown_model'
  /** The model is in the catalog and its weights are not downloaded there. */
  | 'model_not_installed'
  /** The server states it cannot run this model on its backend. */
  | 'unsupported_model'
  /** The card is someone else's right now: a job on the lane, or their lease. P3 parks on it. */
  | 'busy'
  /** Our lease on the model was lost mid-job (`unknown_lease` on a heartbeat): the run is unprotected (plan 13.3). */
  | 'lease_lost'
  /** The server's capability record could not be read, so the act to send cannot be chosen (plan 6.4). */
  | 'act_undecided'
  /** The server is paused in Settings; its work waits (P1's Running/Paused switch, #205). */
  | 'paused'
  /** The selected server is not answering, or answers as something other than a usable Crucible. */
  | 'unreachable'
  /** The selected server is older than MIN_CRUCIBLE. */
  | 'needs_update'
  /** A model string that is not a Crucible id (a stale `ollama:` / `claude:` / `openai:` prefix). */
  | 'invalid_model'
  /** The server answered, but not with what this call needs (no finish_reason, no content). */
  | 'protocol_error'
  /** The load job the call waited on failed on the server. */
  | 'load_failed'
  /**
   * The server has no usable decide door for this model (PHASE22 2.4). Spelled as
   * the server spells it because the chaptering service reads exactly this code.
   */
  | 'decide_not_served'
  /** Any other refusal, carried with the server's own code in `serverCode`. */
  | 'refused';

export class CrucibleCallError extends Error {
  constructor(
    readonly code: CrucibleCallErrorCode,
    message: string,
    /** The server that refused, when one was chosen. */
    readonly server: string | null = null,
    /** The HTTP status the server answered with, when it answered one (a 429 passes through as 429). */
    readonly status: number | null = null,
    /** The server's own error code, never renamed in transit. */
    readonly serverCode: string | null = null,
    /** The holder's sentence for `busy` ("busy: bookforge, tts 62% done"), for P3's parked line. */
    readonly busyLine: string | null = null,
  ) {
    super(`${code}: ${message}`);
    this.name = 'CrucibleCallError';
  }
}

/** Is this the one door's refusal with this code? Typed, never a message substring (Law 10). */
export function isCrucibleCallError(err: unknown, code?: CrucibleCallErrorCode): err is CrucibleCallError {
  return err instanceof CrucibleCallError && (code === undefined || err.code === code);
}

/**
 * A Crucible answered without a field ContentStudio cannot work without.
 *
 * Since @crucible/client 1.0.25 the SDK reads a field it calls informational
 * as `null` when the server leaves it out (plan section 0a: "any Crucible that
 * answers works"). Most of those are rendered as unknown or skipped; the few a
 * path DEPENDS on for correctness (the host backend a module is filtered to,
 * say) are refused here, by name, rather than guessed. A protocol error: the
 * server answered, but not with what this act needs.
 */
export class CrucibleFieldMissing extends CrucibleProtocolError {
  constructor(
    /** The server, when the caller knows it. */
    readonly server: string | null,
    /** The field as the wire spells it, with the route it came from. */
    readonly field: string,
    /** What ContentStudio needed it for. */
    readonly neededFor: string,
  ) {
    super(`${server === null ? 'the Crucible server' : `"${server}"`} did not state ${field}, which ContentStudio needs to ${neededFor}`);
    this.name = 'CrucibleFieldMissing';
  }
}
