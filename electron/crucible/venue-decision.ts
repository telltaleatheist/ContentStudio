/**
 * WHERE A QUEUED JOB RUNS: one rule, one place.
 *
 * Ported from BookForge's electron/crucible/venue-decision.ts by way of
 * Briefcase's, and cut to LEDGER #205 ("no automatic hand-off between
 * servers"; Owen, of Briefcase: "it should never randomly hand a gpu job to
 * another server"):
 *
 *   an item pinned FAST goes to the fast server (LEDGER #195: the pin is the
 *   only way work reaches the PC); every other item goes to the SELECTED
 *   server. Nothing else. There is no rank order, no "first that answers" and
 *   no `newJobsWaitFor: 'any'`: an unpinned item stays on the selected server
 *   even when another one is idle, and a fast item waits for the fast server
 *   even when the selected one is idle.
 *
 * "Who is free right now" is NOT asked here. That is the door's question: a
 * `409 server_busy`/`leased` at submit, or a load refused for free VRAM, parks
 * the item (parking.ts), and the 15 s preflight says when to ask again.
 *
 * Three answers, and the queue does something different with each:
 *
 *   venue   admit to that server's lane.
 *   wait    park the item with this sentence: nothing selected or pinned, the
 *           server paused ("paused, work waits"), or not answering. Work with
 *           no venue is never failed and never moved.
 *   fail    the server refused this computer outright (a bad token, not a
 *           Crucible, a newer protocol): a misconfiguration somebody has to
 *           repair, and waiting would hide it (plan section 13.2, "Failure").
 */
import type { ServerReach } from './wire';

/** Why an item is not running, when the answer is to wait. The renderer shows it grey, not red. */
export type VenueWait = 'no_server' | 'paused' | 'unreachable';

export type VenueAnswer =
  | { kind: 'venue'; server: string; because: 'the fast pin' | 'the selected server' }
  | { kind: 'wait'; server: string | null; wait: VenueWait; line: string }
  | { kind: 'fail'; server: string; reason: string };

/** The only things this decision reads from the world, so a keeper drives every branch. */
export interface VenueHost {
  /** The selected server. Throws routing's own sentence (`no_selected_server`) when there is none. */
  selected(): string;
  /** The fast pin's server. Throws routing's own sentence (`no_fast_server`) when none is pinned. */
  fastServer(): string;
  isPaused(server: string): boolean;
  /** The probe's answer, at most 15 s old. */
  reach(server: string): Promise<{ reach: ServerReach; message: string | null }>;
}

const MISCONFIGURED: ReadonlySet<ServerReach> = new Set<ServerReach>(['bad_token', 'not_crucible', 'version_mismatch']);

/** The server this item is FOR, without asking it anything: the pin or the selection. Throws routing's sentence. */
export function intendedServer(fast: boolean, host: Pick<VenueHost, 'selected' | 'fastServer'>): string {
  return fast ? host.fastServer() : host.selected();
}

export async function decideVenue(fast: boolean, host: VenueHost): Promise<VenueAnswer> {
  let server: string;
  try {
    server = intendedServer(fast, host);
  } catch (err) {
    return { kind: 'wait', server: null, wait: 'no_server', line: (err as Error).message };
  }
  if (host.isPaused(server)) {
    return { kind: 'wait', server, wait: 'paused', line: `${server} is paused, work waits. Set it to Running to let it start.` };
  }
  const answer = await host.reach(server);
  // Busy is not a reason to wait HERE: the door decides, and a 409 parks with
  // the holder's own sentence. The probe's busy line is display only.
  if (answer.reach === 'ready' || answer.reach === 'busy') {
    return { kind: 'venue', server, because: fast ? 'the fast pin' : 'the selected server' };
  }
  const said = answer.message ? `${server}: ${answer.message}` : `${server} (${answer.reach.replace(/_/g, ' ')})`;
  if (MISCONFIGURED.has(answer.reach)) {
    return { kind: 'fail', server, reason: `The Crucible server won't take work from this computer: ${said}` };
  }
  return { kind: 'wait', server, wait: 'unreachable', line: `Waiting for Crucible on ${said}` };
}
