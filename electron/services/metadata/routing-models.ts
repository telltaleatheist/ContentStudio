/**
 * A job's routed options, resolved against the server the job runs on, at its start
 * (metadata-routing.ts RoutingModels; Owen, 2026-09-29: "content studio shouldnt request a
 * model that isnt available on a crucible server").
 *
 * The server is where a GPU step started now would run (lanes.ts `gpuVenue`): the admitted job's
 * venue inside a job (the fast pin's server, else the routing's, else the selected one), and for
 * a standalone call (the reports page, the editor's story titles) the routing's server, else the
 * selected one. Its catalog is read ONCE here; the job binds every option from that one read.
 *
 * A job whose options are all cloud or `claude -p` reads no catalog: nothing it sends runs on a
 * card, so a server that cannot be reached must not hold it up.
 */
import * as log from 'electron-log';
import { installedLanes } from '../../crucible/lanes';
import { RoutingModels, routesLocal } from './metadata-routing';

export async function readRoutingModels(
  what: string,
  optionIds: readonly unknown[],
  /** Where a GPU step would run now; lanes.ts `gpuVenue` unless a caller states its own (story-ipc's). */
  venueNow?: () => { server: string } | { server: null; reason: string },
): Promise<RoutingModels> {
  if (!routesLocal(optionIds)) {
    return RoutingModels.withoutCatalog(`${what} routes no local model`);
  }
  const lanes = installedLanes();
  const venue = (venueNow ?? (() => lanes.gpuVenue()))();
  const inventory = venue.server === null
    ? { server: null, reachable: false, error: venue.reason, models: {}, anthropicConfigured: null }
    : await lanes.inventoryFor(venue.server);
  const models = RoutingModels.on(inventory);
  for (const line of models.describe(optionIds)) log.info(`[MetadataRouting] ${what}: ${line}`);
  return models;
}
