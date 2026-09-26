/**
 * THE SEAM every other part of the main process uses to reach the registry and
 * the choice: the registry and the routing record together, announcing every
 * change to in-process listeners and to the renderer.
 *
 * Ported from Briefcase's registry.service.ts (BookForge's servers.ts before
 * it), without the Nest wrapping. Announced where the record is WRITTEN rather
 * than at each caller, so the pane, the pairing flow and auto-connect all get
 * it (BookForge learned this the hard way: a record nobody announced is a lane
 * nobody can use until something unrelated publishes).
 *
 *   list()            {name, url, tokenMasked, added}[]   no token, ever
 *   getWithToken()    {name, url, token}                  for the client factory only
 *   selected()        the one server all work goes to     throws `no_selected_server` by name
 *   fastServer()      the "fast" pin's server              throws `no_fast_server` by name
 */
import * as log from 'electron-log';
import * as path from 'path';
import { REGISTRY_FILE, ServerRegistry, type ResolvedServer } from './registry';
import { ROUTING_FILE, Routing } from './routing';
import type { CrucibleServerRow, CrucibleServersChangedPayload, RoutingView } from './wire';

export type RegistryListener = (change: CrucibleServersChangedPayload) => void;

export class CrucibleServers {
  private readonly registry: ServerRegistry;
  private readonly routing: Routing;
  private readonly listeners = new Set<RegistryListener>();

  /**
   * @param stateDir  where crucible-servers.json and crucible-routing.json live (userData)
   * @param announce  pushes the change to the renderer; a keeper passes a recorder
   */
  constructor(stateDir: string, private readonly announceToRenderer: (change: CrucibleServersChangedPayload) => void = () => {}) {
    this.registry = new ServerRegistry(path.join(stateDir, REGISTRY_FILE));
    this.routing = new Routing(path.join(stateDir, ROUTING_FILE));
  }

  /** Has a registry ever been written? An empty one may be a user who removed a server on purpose. */
  exists(): boolean {
    return this.registry.exists();
  }

  list(): CrucibleServerRow[] {
    return this.registry.list();
  }

  names(): string[] {
    return this.registry.names();
  }

  /**
   * One server WITH its token. For the client factory only: nothing that
   * answers the renderer may call this.
   */
  getWithToken(name: string): ResolvedServer {
    return this.registry.get(name);
  }

  add(server: { name: string; url: string; token: string }): CrucibleServerRow {
    const row = this.registry.add(server);
    this.routing.added(row.name, this.names());
    log.info(`[crucible] Added server "${row.name}" at ${row.url}`);
    this.announce({ reason: 'added', server: row.name });
    return row;
  }

  /** Forget a server. When it was the selected one, nothing is selected until the user picks. */
  remove(name: string): CrucibleServerRow {
    const row = this.registry.remove(name);
    this.routing.removed(row.name);
    log.info(`[crucible] Removed server "${row.name}"`);
    this.announce({ reason: 'removed', server: row.name });
    return row;
  }

  routingView(): RoutingView {
    return this.routing.view(this.names());
  }

  /** The server all work goes to. Throws `no_selected_server` by name when there is none. */
  selected(): string {
    return this.routing.selectedServer(this.names());
  }

  /** The server a fast-pinned item goes to. Throws `no_fast_server` by name when none is pinned. */
  fastServer(): string {
    return this.routing.fastServer(this.names());
  }

  /** The user switches servers. Work waiting to start goes to this one from now on. */
  select(name: string): RoutingView {
    const view = this.routing.select(name, this.names());
    log.info(`[crucible] Selected server "${name}"`);
    this.announce({ reason: 'selected', server: name });
    return view;
  }

  /** The user pins the fast server (or unpins it with null). */
  setFast(name: string | null): RoutingView {
    const view = this.routing.setFast(name, this.names());
    log.info(name === null ? '[crucible] Fast server unpinned' : `[crucible] Fast server pinned to "${name}"`);
    this.announce({ reason: 'fast', server: name });
    return view;
  }

  /**
   * The Running/Paused switch. A paused server takes no new work and its work
   * waits; nothing is moved to another server (LEDGER #205).
   */
  setPaused(name: string, paused: boolean): RoutingView {
    const view = this.routing.setPaused(name, paused, this.names());
    log.info(`[crucible] Server "${name}" ${paused ? 'paused' : 'running'}`);
    this.announce({ reason: paused ? 'paused' : 'resumed', server: name });
    return view;
  }

  /** In-process listeners (the client factory's engine cache, the probe cache, readiness). */
  onChange(listener: RegistryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private announce(change: CrucibleServersChangedPayload): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (err) {
        log.warn(`[crucible] A registry listener threw: ${(err as Error).message}`);
      }
    }
    this.announceToRenderer(change);
  }
}
