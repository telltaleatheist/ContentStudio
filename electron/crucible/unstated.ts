/**
 * unstated: how a Crucible fact the server did not send is SHOWN.
 *
 * Ported from BookForge's electron/crucible/unstated.ts, byte for byte in
 * substance. Since Crucible 1.0.25 the SDK reads an informational field a
 * server left out as `null` ("it did not say") instead of refusing the whole
 * document. So a log line or a label that names such a field has to be able to
 * say that nothing was stated, honestly and the same way everywhere, rather
 * than each site inventing an empty string or a zero that reads as a real
 * answer (plan 0a: `promptTokens: null` means "not reported", never 0).
 *
 * FOR DISPLAY ONLY. A null that a DECISION depends on is decided where the
 * decision is made (a named refusal), never smoothed over with this.
 */

/** The literal shown in place of a fact the server did not state. */
export const UNSTATED = '(not stated)';

/** A fact for a log line or a label: itself, or {@link UNSTATED}. */
export function stated(value: string | number | boolean | null): string {
  return value === null ? UNSTATED : String(value);
}
