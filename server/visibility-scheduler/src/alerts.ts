// Tells Owen by email when a change fails or a channel needs reconnecting, through Triton's own
// exim. A failed release otherwise only shows on a page nobody is looking at. An alert that cannot
// be sent is logged and goes no further: the change has already finished by then.

import { spawn } from 'node:child_process';
import type { Config } from './config.js';

const SENDMAIL = '/usr/sbin/sendmail';
const FROM = 'scheduler@owenmorgan.com';
const SEND_LIMIT_MS = 30_000;

/** The whole message. Video titles reach the subject, so line breaks are taken out of it. */
export function alertMessage(to: string, subject: string, body: string): string {
  const oneLine = subject.replace(/[\r\n]+/g, ' ').trim();
  const encoded = `=?UTF-8?B?${Buffer.from(oneLine, 'utf8').toString('base64')}?=`;
  return [`From: ContentStudio scheduler <${FROM}>`, `To: ${to}`, `Subject: ${encoded}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', body, ''].join('\n');
}

export async function sendAlert(config: Config, subject: string, body: string): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      const mail = spawn(SENDMAIL, ['-i', '-f', FROM, config.allowedEmail], { stdio: ['pipe', 'ignore', 'pipe'], timeout: SEND_LIMIT_MS });
      let stderr = '';
      mail.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      mail.on('error', reject);
      mail.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`sendmail exited ${String(code)}: ${stderr.trim()}`))));
      mail.stdin.end(alertMessage(config.allowedEmail, subject, body));
    });
    console.log(`[alert] sent: ${subject}`);
  } catch (err) {
    console.error(`[alert] NOT SENT: ${subject}: ${(err as Error).message}`);
  }
}
