/**
 * WHICH CRUCIBLE SERVER CONTENTSTUDIO USES: exactly one, the one the user
 * selected, plus the one a queue item's "fast" pin sends it to, and which of
 * them the user has paused.
 *
 * Ported from Briefcase's backend/src/crucible/routing.ts, with `fastServer`
 * and `paused` as ContentStudio's additions (plan sections 4 and 14). The
 * registry owns which servers exist; this owns the choice, as a second file,
 * so switching never rewrites a token:
 *
 *   <userData>/crucible-routing.json
 *   { "selected": "crucible@owens-mac-studio", "fastServer": "owens-pc", "paused": [] }
 *
 * Every GPU and cloud job goes to the selected server. There is no ranking and
 * no hand-off (LEDGER #205, Owen's Briefcase ruling applied: "it should never
 * randomly hand a gpu job to another server"): a busy server makes work wait
 * for it, and an unreachable one makes work wait with its reason. Work moves
 * to another server only when the user selects that server, or pins one item
 * "fast" (LEDGER #195), which is the only way work reaches the PC.
 *
 * The rules:
 *  - the first server added is selected when it is added; later ones are not;
 *  - no choice ever recorded (no file) and exactly one server registered:
 *    that one. Removing the selected server records "none", so the user
 *    chooses again: the remaining server is never picked for them;
 *  - `fastServer` is a pin, never a default: nothing is fast until the user
 *    says so, and removing that server clears the pin. A fast item with no
 *    fast server has nowhere to go, and the queue (P3) says so by name;
 *  - `paused` is the per-server Running/Paused switch (plan section 14). A
 *    paused server takes no NEW work, and its work WAITS; it is never sent to
 *    another server instead, because that would be the hand-off #205 rules
 *    out. Pausing is not deselecting: the selection stays, so resuming puts
 *    everything back exactly where the user left it;
 *  - a record written before selection existed (`{order, disabled}`, the
 *    ranked list) reads as its first running server, and its `disabled` list
 *    as the paused servers; it is rewritten only when the user next chooses;
 *  - a selected server the registry no longer has is REPORTED (`missing`),
 *    never swapped for another;
 *  - a corrupt record is refused, never replaced.
 */
import * as fs from 'fs';
import * as path from 'path';
import { CrucibleRoutingError } from './errors';
import type { RoutingView } from './wire';

export const ROUTING_FILE = 'crucible-routing.json';

export interface RoutingRecord {
  selected: string | null;
  fastServer: string | null;
  paused: string[];
}

export class Routing {
  constructor(readonly file: string) {}

  /** The recorded choice; `recorded` is false when no choice was ever written. */
  read(): RoutingRecord & { recorded: boolean } {
    if (!fs.existsSync(this.file)) return { selected: null, fastServer: null, paused: [], recorded: false };
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
    } catch (err) {
      throw this.corrupt(`is not valid JSON (${(err as Error).message})`);
    }
    const record = parsed as Record<string, unknown> | null;
    if (record === null || typeof record !== 'object' || Array.isArray(record)) throw this.corrupt('is not an object');
    const isNames = (value: unknown): value is string[] => Array.isArray(value) && value.every((name) => typeof name === 'string' && name !== '');
    const nameOrNull = (value: unknown, key: string): string | null => {
      if (value === undefined || value === null) return null;
      if (typeof value !== 'string' || value === '') throw this.corrupt(`has a "${key}" that is neither a server name nor null`);
      return value;
    };
    if ('selected' in record) {
      const paused = record.paused ?? [];
      if (!isNames(paused)) throw this.corrupt('has a "paused" that is not a list of server names');
      return {
        selected: nameOrNull(record.selected, 'selected'),
        fastServer: nameOrNull(record.fastServer, 'fastServer'),
        paused: [...paused],
        recorded: true,
      };
    }
    // The ranked record from before selection: its first running server. It
    // never carried a fast pin; its `disabled` list is what Paused means now.
    const order = record.order;
    const disabled = record.disabled ?? [];
    if (!isNames(order) || !isNames(disabled)) throw this.corrupt('is neither {selected, fastServer, paused} nor the older {order, disabled}');
    const paused = new Set(disabled);
    return { selected: order.find((name) => !paused.has(name)) ?? null, fastServer: null, paused: [...disabled], recorded: false };
  }

  private write(record: RoutingRecord): void {
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
    fs.renameSync(temp, this.file);
  }

  /** The record as it stands, with `patch` applied: every write keeps the fields it does not change. */
  private update(patch: Partial<RoutingRecord>): void {
    const { recorded: _recorded, ...current } = this.read();
    this.write({ ...current, ...patch });
  }

  /** The choice resolved against the servers that exist. */
  view(known: readonly string[]): RoutingView {
    const record = this.read();
    let selected: string | null = null;
    let missing: string | null = null;
    if (record.selected !== null) {
      if (known.includes(record.selected)) selected = record.selected;
      else missing = record.selected;
    } else if (!record.recorded && known.length === 1) {
      selected = known[0]!;
    }
    // A fast pin on a server that is gone is no pin: the queue asks by name and is told there is none.
    const fastServer = record.fastServer !== null && known.includes(record.fastServer) ? record.fastServer : null;
    const paused = new Set(record.paused);
    return {
      servers: known.map((name) => ({ name, selected: name === selected, fast: name === fastServer, paused: paused.has(name) })),
      selected,
      missing,
      fastServer,
    };
  }

  /** The user's choice. Refuses a name that is not registered. */
  select(name: string, known: readonly string[]): RoutingView {
    this.requireKnown(name, known);
    this.update({ selected: name });
    return this.view(known);
  }

  /** The user pins (or unpins, with null) the fast server. Refuses a name that is not registered. */
  setFast(name: string | null, known: readonly string[]): RoutingView {
    if (name !== null) this.requireKnown(name, known);
    // An implicit selection (one server, nothing recorded) is written down with
    // the pin, so recording the pin cannot un-select it.
    this.update({ selected: this.view(known).selected ?? this.read().selected, fastServer: name });
    return this.view(known);
  }

  /** The Running/Paused switch. Refuses a name that is not registered. */
  setPaused(name: string, paused: boolean, known: readonly string[]): RoutingView {
    this.requireKnown(name, known);
    const current = this.read();
    const others = current.paused.filter((entry) => entry !== name);
    this.update({ selected: this.view(known).selected ?? current.selected, paused: paused ? [...others, name] : others });
    return this.view(known);
  }

  /** A server was just added (`known` includes it): it is selected only when nothing was. */
  added(name: string, known: readonly string[]): void {
    const before = this.view(known.filter((entry) => entry !== name));
    if (before.selected === null && before.missing === null) this.update({ selected: name });
    else if (before.selected !== null && this.read().selected === null) this.update({ selected: before.selected });
  }

  /**
   * A server was just removed: when it was the selection, nothing is selected
   * (never another server); a fast pin on it is cleared, and so is its pause,
   * so a server added later under the same name starts Running.
   */
  removed(name: string): void {
    const record = this.read();
    if (record.selected === name || record.fastServer === name || record.paused.includes(name)) {
      this.update({
        selected: record.selected === name ? null : record.selected,
        fastServer: record.fastServer === name ? null : record.fastServer,
        paused: record.paused.filter((entry) => entry !== name),
      });
    }
  }

  /** The server all work goes to. Refuses by name when there is none. */
  selectedServer(known: readonly string[]): string {
    const view = this.view(known);
    if (view.selected !== null) return view.selected;
    throw new CrucibleRoutingError(
      'no_selected_server',
      known.length === 0
        ? 'No Crucible server is connected. Add one in Settings › Crucible Servers.'
        : view.missing !== null
          ? `The selected Crucible server "${view.missing}" isn't connected any more. Select a server in Settings › Crucible Servers.`
          : 'No Crucible server is selected. Select one in Settings › Crucible Servers.',
    );
  }

  /** The server a fast-pinned item goes to. Refuses by name when none is pinned (LEDGER #195: the pin is the only route to the PC). */
  fastServer(known: readonly string[]): string {
    const view = this.view(known);
    if (view.fastServer !== null) return view.fastServer;
    throw new CrucibleRoutingError(
      'no_fast_server',
      'No Crucible server is pinned as "fast". Choose one in Settings › Crucible Servers, or unpin the item.',
    );
  }

  private requireKnown(name: string, known: readonly string[]): void {
    if (!known.includes(name)) {
      throw new CrucibleRoutingError(
        'unknown_server',
        `"${name}" is not one of this machine's Crucible servers (${known.length === 0 ? 'there are none' : `known: ${known.join(', ')}`}).`,
      );
    }
  }

  private corrupt(what: string): CrucibleRoutingError {
    return new CrucibleRoutingError(
      'corrupt_routing',
      `${this.file} ${what}. It records which Crucible server ContentStudio uses, so nothing here will replace it. Repair or delete it by hand.`,
    );
  }
}
