/**
 * Cancellation, as a metadata run sees it.
 *
 * Two things have to be recognisable, and three services raise them:
 *  - a guard that fired at a stage boundary, before a model call was made, and
 *  - a provider call that was ABORTED mid-flight by the run's AbortController.
 *
 * The second is the one that matters financially: polling a cancel flag between stages
 * says nothing about the 28k-token call running inside one. Each client reports an abort
 * with its own error type, hence the sniffing below rather than a single instanceof.
 *
 * These live here rather than in metadata-generator.service.ts because the AI manager,
 * the task units and the chapter pipeline all raise them, and importing the orchestrator
 * from its own dependencies would be a cycle.
 */

/** Raised by a stage-boundary guard. Carries WHERE, because "cancelled" alone is not a log. */
export class JobCancelledError extends Error {
  constructor(where: string) {
    super(`Job cancelled by user: ${where}`);
    this.name = 'JobCancelledError';
  }
}

/**
 * Did this error come from an AbortSignal firing?
 *
 * Every client names it differently: axios raises CanceledError (code ERR_CANCELED), the
 * Anthropic and OpenAI SDKs raise APIUserAbortError, and an aborted fetch raises a
 * DOMException named AbortError.
 *
 * Note this only works on the error as THROWN. The AI queue re-wraps every rejection as
 * a plain Error (queue-manager.service.ts), so anything that crosses that boundary has
 * to be classified by asking whether cancellation was requested, not by asking the error.
 */
export function isAbortError(error: any): boolean {
  const name = error?.name;
  return (
    name === 'CanceledError' ||
    name === 'AbortError' ||
    name === 'APIUserAbortError' ||
    error?.code === 'ERR_CANCELED'
  );
}
