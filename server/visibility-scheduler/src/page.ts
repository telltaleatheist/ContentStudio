// The setup page: server-rendered HTML, no scripts (the CSP forbids them).

import type { Config } from './config.js';
import type { Job } from './jobs.js';

export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const CSS = `
:root { --bg:#fbfaf7; --fg:#1d1c1a; --muted:#6b6862; --line:#e4e1da; --card:#fff; --accent:#c2410c; --bad:#b91c1c; --ok:#15803d; }
@media (prefers-color-scheme: dark) { :root { --bg:#161513; --fg:#ecebe7; --muted:#a19d95; --line:#2e2c29; --card:#1e1d1a; --accent:#fb923c; --bad:#f87171; --ok:#4ade80; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, -apple-system, sans-serif; }
main { max-width:960px; margin:0 auto; padding:24px 16px 64px; }
h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:17px; margin:32px 0 8px; }
.muted { color:var(--muted); } .bad { color:var(--bad); } .ok { color:var(--ok); }
section { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; overflow-x:auto; }
table { border-collapse:collapse; width:100%; } th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
th { font-weight:600; color:var(--muted); font-size:13px; }
a.button, button { display:inline-block; font:inherit; padding:6px 12px; border-radius:6px; border:1px solid var(--line); background:var(--card); color:var(--fg); cursor:pointer; text-decoration:none; }
a.primary, button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
form.inline { display:inline; } input[type=text] { font:inherit; padding:6px 8px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--fg); }
code.key { display:block; padding:12px; border:1px solid var(--line); border-radius:6px; word-break:break-all; user-select:all; }
header { display:flex; justify-content:space-between; align-items:baseline; gap:12px; flex-wrap:wrap; }
`;

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive"><title>${esc(title)}</title><style>${CSS}</style></head>
<body><main>${body}</main></body></html>`;
}

export function signInPage(config: Config, error?: string): string {
  return shell(
    'Scheduler',
    `<h1>Scheduler</h1>
${error ? `<p class="bad">${esc(error)}</p>` : ''}
<p><a class="button primary" href="${esc(config.baseUrl)}/login">Sign in with Google</a></p>`,
  );
}

export function messagePage(config: Config, title: string, message: string): string {
  return shell(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p><p><a class="button" href="${esc(config.baseUrl)}/">Back</a></p>`);
}

export function newKeyPage(config: Config, name: string, key: string): string {
  return shell(
    'New device key',
    `<h1>Device key for ${esc(name)}</h1>
<p>Copy it now. Only a hash of it is kept, so it is not shown again.</p>
<code class="key">${esc(key)}</code>
<p><a class="button" href="${esc(config.baseUrl)}/">Done</a></p>`,
  );
}

/** The extension submits this form itself; the button is for when it is not loaded here. */
export function extensionConnectPage(config: Config): string {
  return shell(
    'Connect the extension',
    `<h1>Connecting the extension…</h1>
<form id="cs-extension-connect" method="post" action="${esc(config.baseUrl)}/extension-key"><button class="primary">Connect</button></form>`,
  );
}

/** The extension reads the key from here, stores it and closes this tab. */
export function extensionKeyPage(key: string): string {
  return shell(
    'Extension connected',
    `<h1>Almost done</h1>
<p>This tab closes by itself. If it stays open, ContentStudio Companion is not loaded in this browser: load it and try again from there.</p>
<code id="cs-extension-key" class="key">${esc(key)}</code>`,
  );
}

export interface ChannelRow {
  channel_id: string;
  title: string;
  connected_at: number;
  state: string;
  last_error: string | null;
}
export interface KeyRow {
  id: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export function homePage(config: Config, email: string, channels: ChannelRow[], keys: KeyRow[], jobs: Job[], lastTick: number | null): string {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: config.displayTimeZone, dateStyle: 'medium', timeStyle: 'short' });
  const t = (ms: number | string | null) => (ms === null ? '' : esc(fmt.format(new Date(ms))));
  const base = esc(config.baseUrl);

  const channelRows = channels.length
    ? channels
        .map(
          (c) => `<tr><td>${esc(c.title)}<div class="muted">${esc(c.channel_id)}</div></td>
<td>${c.state === 'ok' ? '<span class="ok">connected</span>' : `<span class="bad">needs reconnecting</span><div class="muted">${esc(c.last_error)}</div>`}</td>
<td>${t(c.connected_at)}</td>
<td><form class="inline" method="post" action="${base}/channels/${esc(c.channel_id)}/disconnect"><button>Disconnect</button></form></td></tr>`,
        )
        .join('')
    : '<tr><td colspan="4" class="muted">No channels connected yet.</td></tr>';

  const keyRows = keys.length
    ? keys
        .map(
          (k) => `<tr><td>${esc(k.name)}</td><td>${t(k.created_at)}</td><td>${k.last_used_at ? t(k.last_used_at) : '<span class="muted">never</span>'}</td>
<td>${k.revoked_at ? `<span class="muted">revoked ${t(k.revoked_at)}</span>` : `<form class="inline" method="post" action="${base}/keys/${esc(k.id)}/revoke"><button>Revoke</button></form>`}</td></tr>`,
        )
        .join('')
    : '<tr><td colspan="4" class="muted">No device keys yet.</td></tr>';

  const jobRow = (j: Job) => {
    const r = j.result;
    let outcome = '';
    if (j.state === 'done' && r) outcome = `<span class="ok">${esc(r.before)} → ${esc(r.after)}</span> at ${t(r.ranAt)}${r.lateByMs > 120_000 ? ` <span class="bad">(${Math.round(r.lateByMs / 60_000)} min late)</span>` : ''}${r.message ? `<div class="muted">${esc(r.message)}</div>` : ''}${r.clearedYouTubeSchedule ? '<div class="muted">cancelled YouTube’s own schedule</div>' : ''}`;
    else if (j.state === 'failed' && r) outcome = `<span class="bad">failed</span><div class="bad">${esc(r.message)}</div>`;
    else if (j.state === 'pending' && j.attempts.length) outcome = `<span class="bad">retrying (attempt ${j.attempts.length + 1} at ${t(j.nextAttemptAt)})</span><div class="muted">${esc(j.attempts.at(-1)!.error)}</div>`;
    else outcome = `<span class="muted">${esc(j.state)}</span>`;
    return `<tr><td>${t(j.runAt)}</td><td><a href="https://studio.youtube.com/video/${esc(j.videoId)}/edit">${esc(j.videoTitle)}</a><div class="muted">${esc(j.channelTitle ?? j.channelId)}${j.note ? ` · ${esc(j.note)}` : ''}</div></td>
<td>→ ${esc(j.target)}</td><td>${outcome}</td><td class="muted">${esc(j.createdBy)}</td></tr>`;
  };
  const pending = jobs.filter((j) => j.state === 'pending');
  const history = jobs.filter((j) => j.state !== 'pending').reverse().slice(0, 100);
  const jobTable = (list: Job[], empty: string) =>
    `<table><tr><th>When</th><th>Video</th><th>To</th><th>Outcome</th><th>Made by</th></tr>${list.length ? list.map(jobRow).join('') : `<tr><td colspan="5" class="muted">${empty}</td></tr>`}</table>`;

  const loop = lastTick === null ? '<span class="bad">the loop has not run yet</span>' : Date.now() - lastTick > 120_000 ? `<span class="bad">the loop last ran ${t(lastTick)}</span>` : `<span class="muted">loop ran ${t(lastTick)}</span>`;

  return shell(
    'Scheduler',
    `<header><div><h1>Scheduler</h1><div class="muted">Visibility changes for YouTube. Times in ${esc(config.displayTimeZone)}. ${loop}</div></div>
<form class="inline" method="post" action="${base}/logout"><span class="muted">${esc(email)}</span> <button>Sign out</button></form></header>

<h2>Channels</h2>
<section><table><tr><th>Channel</th><th>State</th><th>Connected</th><th></th></tr>${channelRows}</table>
<p><a class="button primary" href="${base}/connect">Connect a channel</a> <span class="muted">Pick the channel on Google’s chooser. Connecting one again replaces its login.</span></p></section>

<h2>Device keys</h2>
<section><table><tr><th>Name</th><th>Made</th><th>Last used</th><th></th></tr>${keyRows}</table>
<form method="post" action="${base}/keys"><p><input type="text" name="name" required maxlength="60" placeholder="e.g. ContentStudio on the Mac Studio"> <button class="primary">Make a key</button></p></form></section>

<h2>Coming changes</h2>
<section>${jobTable(pending, 'Nothing scheduled.')}</section>

<h2>History</h2>
<section>${jobTable(history, 'Nothing has run yet.')}</section>
<p class="muted">Changes are made and edited from ContentStudio and the extension.</p>`,
  );
}
