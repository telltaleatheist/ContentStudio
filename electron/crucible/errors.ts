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

/** A refusal from the settings bridge: a patch the pane may not send, or a key copy with nothing to copy. */
export class CrucibleSettingsError extends Error {
  constructor(readonly code: 'invalid_settings' | 'nothing_to_copy' | 'unknown_server', message: string) {
    super(message);
    this.name = 'CrucibleSettingsError';
  }
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
