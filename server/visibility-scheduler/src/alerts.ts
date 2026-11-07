// Records what Owen must hear about: a change that failed, a channel that needs reconnecting. The
// Mac pulls this file and shows each line as a notification (ops/mac-watch.sh). Not email: Gmail
// refuses mail from Triton's address outright (550 5.7.1, seen 2026-11-07).

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';

/** One line, so the Mac can count what it has seen. Video titles and YouTube's words reach it. */
export function alertLine(at: Date, text: string): string {
  return `${at.toISOString()} ${text.replace(/\s*[\r\n]+\s*/g, ' ').trim()}\n`;
}

export function recordAlert(config: Config, text: string): void {
  const line = alertLine(new Date(), text);
  appendFileSync(join(config.dataDir, 'alerts.log'), line);
  console.error(`[alert] ${line.trimEnd()}`);
}
