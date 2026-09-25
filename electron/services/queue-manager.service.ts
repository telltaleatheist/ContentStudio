/**
 * THE ONE DOOR EVERY MODEL CALL GOES THROUGH: `queueAITask`.
 *
 * This file used to BE the queue: a 5-slot "main" pool (Whisper, FFmpeg), a
 * 1-slot "AI" pool that every model call took, cloud or local, and a watchdog
 * that force-failed an AI task after 30 minutes of wall clock. The Crucible
 * migration replaced all of it (CRUCIBLE-MIGRATION-PLAN.md section 13,
 * LEDGER #195, #205):
 *
 *  - the AI pool is now one GPU LANE PER CRUCIBLE SERVER (electron/crucible/
 *    lanes.ts). A local call takes its server's slot; a cloud call (`claude:`,
 *    `anthropic/…`) and `claude -p` take none, so they no longer queue behind
 *    local work for no reason;
 *  - the watchdog is a STALL clock per queue job (stream-stall.ts): ten minutes
 *    with no sign of life ends a job, ten minutes of work does not;
 *  - the main pool had one caller left (the episode splitter's retired
 *    `analyze()`), and went with `queueTranscription` and `createMainTask`.
 *
 * What stays here is the signature the call sites already use, now with the
 * call's ROUTE stated, so which lane a call takes is a typed fact at the call
 * site rather than something read back out of a model string later.
 *
 * NESTING STILL DEADLOCKS. A GPU call made from inside another GPU call's
 * `execute` waits for the slot its own caller holds. makeRequest must not be
 * wrapped in queueAITask, exactly as before.
 */
import { installedLanes, lanesIfInstalled, type AiCallRoute } from '../crucible/lanes';

export { gpuCall, routeOfModelId, type AiCallRoute } from '../crucible/lanes';

/**
 * Run one model call on its lane and return what it returned. `id` and `name`
 * are for the log; `route` says which lane (`gpuCall(model)` for a local model,
 * `routeOfModelId(prefixedId)` for a routing-table id).
 *
 * A cloud call needs no lanes at all, so it runs even in a process that never
 * installed them (a CLI that only calls Claude). A GPU call in such a process
 * is refused by name.
 */
export async function queueAITask<T>(route: AiCallRoute, id: string, name: string, execute: () => Promise<T>): Promise<T> {
  if (route.lane === 'cloud') {
    const lanes = lanesIfInstalled();
    return lanes === null ? execute() : lanes.aiCall(route, `${name} (${id})`, execute);
  }
  return installedLanes().aiCall(route, `${name} (${id})`, execute);
}
