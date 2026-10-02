/**
 * FOLLOWING EACH SERVER'S EVENT STREAM for the lanes strip (Crucible 1.0.76, LEDGER #255).
 *
 * Until 1.0.55 the lanes read every running server's `/v1/activity` every 15 s while work was
 * queued (the "preflight"), for two things: the strip (who holds the card, the resident model, how
 * far along) and the parked jobs (whether what parked one had gone). Parking is gone (a job's
 * session waits in the server's own line, session.ts), so what is left is DISPLAY, and display is
 * what `GET /v1/events` is for (MIGRATION.md: "Polling /v1/activity ... -> events()"): it opens
 * with a snapshot (`/v1/activity`, exactly), then sends each change (`job.*`, `session.*`,
 * `card.*`, ...) as it happens, reconnects by itself with `Last-Event-ID`, and waits out a server
 * that is stopping.
 *
 * WHEN. Exactly when the preflight ran: only while ContentStudio has work queued (readiness.ts
 * `needsPolling`, LEDGER #234, which switches it through the lanes' `setPolling`). One stream per
 * registered server that is not paused.
 *
 * GATED BY THE FEATURE, NOT A VERSION: `await client.has('events')`. A server that does not list
 * it is said by name on its chip and not followed (no polling in its place: a fallback would be a
 * strip that looks live on a server this side cannot follow).
 *
 * A stream that fails for weather (the server asleep, a refused connection before the first
 * snapshot) is followed again after {@link WATCH_RETRY_MS}; the SDK itself reconnects a stream
 * that drops after it opened.
 */
import type { CrucibleClient } from '@crucible/client';
import * as log from 'electron-log';
import { applyServerEvent, cardViewOf, type CardView } from './card-holder';

/** How long a server whose stream could not be opened waits before it is followed again. */
export const WATCH_RETRY_MS = 15_000;

export interface ServerWatchDeps {
  /** A WORK client (no deadline: a deadline would cut the stream off). */
  clientFor(server: string): Promise<CrucibleClient>;
  /** The server's view changed (the snapshot, or an event that moved it). */
  onView(server: string, view: CardView): void;
  /** The server could not be followed: why, in a sentence. */
  onFailure(server: string, reason: string): void;
  retryMs?: number;
}

export class ServerWatch {
  private readonly following = new Map<string, AbortController>();

  constructor(private readonly deps: ServerWatchDeps) {}

  /** Follow exactly these servers: start the new ones, stop the ones no longer listed. */
  follow(servers: readonly string[]): void {
    for (const [server, controller] of this.following) {
      if (!servers.includes(server)) {
        controller.abort();
        this.following.delete(server);
      }
    }
    for (const server of servers) {
      if (this.following.has(server)) continue;
      const controller = new AbortController();
      this.following.set(server, controller);
      void this.run(server, controller.signal);
    }
  }

  /** The servers being followed (a keeper reads it). */
  followed(): string[] {
    return [...this.following.keys()];
  }

  stop(): void {
    for (const controller of this.following.values()) controller.abort();
    this.following.clear();
  }

  private async run(server: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const client = await this.deps.clientFor(server);
        if (!(await client.has('events'))) {
          this.deps.onFailure(server, `"${server}" does not offer the server event stream (/v1/events, Crucible 1.0.76 or newer), so this strip cannot follow it. Update Crucible there.`);
          return;
        }
        let view: CardView | null = null;
        for await (const event of client.events({ signal })) {
          const next: CardView | null = event.event === 'snapshot' ? cardViewOf(event.activity) : view === null ? null : applyServerEvent(view, event);
          if (next === null || next === view) continue;
          view = next;
          this.deps.onView(server, view);
        }
        if (signal.aborted) return;
        throw new Error('the event stream ended');
      } catch (err) {
        if (signal.aborted) return;
        const reason = err instanceof Error ? err.message : String(err);
        this.deps.onFailure(server, reason);
        log.warn(`[crucible] could not follow "${server}"'s event stream (${reason}); following it again in ${(this.deps.retryMs ?? WATCH_RETRY_MS) / 1000} s`);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.deps.retryMs ?? WATCH_RETRY_MS);
          timer.unref?.();
          signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }
    }
  }
}
