/**
 * THE CONNECT CODE FOR A SERVER THIS APP IS ALREADY TALKING TO.
 *
 * Ported from BookForge's electron/crucible/connect-code.ts. A registered
 * server is a name, an address and a token this app already holds and already
 * sends on every request. Emitting the line it already has is what lets a
 * person hand a server to another machine without a terminal on the server
 * (Owen ran aground exactly there on 2026-09-15: "i tried accessing it on the
 * mac but i dont know the bearer token").
 *
 * Why the line never reaches the renderer: wire.ts, first paragraph. The line
 * is built in main and written STRAIGHT TO THE CLIPBOARD by connect.ts; the
 * renderer is told what was copied with the token elided.
 */
import { CrucibleConnectError } from './errors';

/**
 * `crucible://<name>@<host>:<port>/#<token>`: crucible `pairing.py`'s format,
 * mirrored field for field, and what `crucible token --url` prints.
 *
 * BOTH COMPONENTS ARE PERCENT-ENCODED WITH NOTHING SAFE, which is `quote(...,
 * safe='')` on the other side. The name is the half that matters today:
 * `crucible@owens-pc` carries an `@`, and unencoded it would make the
 * authority start at the wrong one: the line would parse, name the host
 * `owens-pc`, and be wrong in a way that looks right. The token is encoded
 * because `secrets.token_urlsafe` emits only unreserved characters today,
 * which is precisely when a rule should be written down.
 *
 * THE TRAILING `/` BEFORE THE FRAGMENT IS PART OF THE FORMAT. Without it a
 * lenient parser reads the fragment as part of the authority and a strict one
 * refuses the line.
 */
export function connectCodeFor(name: string, url: string, token: string): string {
  const authority = new URL(url).host;
  if (authority === '') {
    throw new CrucibleConnectError(
      'invalid_pairing',
      `"${name}" is registered at ${url}, which has no host to build a connect code from. `
        + 'A connect code names the address an app should reach, and there is none here.',
    );
  }
  return `crucible://${encodeURIComponent(name)}@${authority}/#${encodeURIComponent(token)}`;
}

/** A connect code with its token elided, fit to show: `crucible://name@host/#****`. */
export function elideConnectCode(line: string): string {
  return line.replace(/#.*$/, '#****');
}
