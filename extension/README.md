# ContentStudio Companion

Chrome MV3 extension that collects YouTube Studio analytics the public
YouTube Analytics API does not expose — impressions and impressions
click-through rate — and pushes them to the ContentStudio desktop app over
localhost HTTP.

**Current status: scaffold.** Everything around data collection is real and
working (settings, ingest client, outbox, scheduling, popup/options UI). The
collector itself — the module that talks to YouTube Studio's internal
analytics endpoints — is intentionally NOT implemented; the endpoints have not
been reconnoitered yet. Until then every collection attempt records
"Collector pending Studio recon" and the popup shows the same.

## How it fits together

```
┌────────────────────┐   chrome.alarms (6h)   ┌──────────────────────┐
│ background.js (SW) │──── collection cycle ──▶ collector.ts          │
│                    │                         │ (throws CollectorNot │
│  outbox flush      │                         │  ImplementedError    │
└─────────┬──────────┘                         │  until recon done)   │
          │                                    └──────────────────────┘
          ▼ POST /analytics/videos | /analytics/ingest (Bearer token)
┌────────────────────┐
│ ContentStudio app  │  http://127.0.0.1:<port>  (default 43117)
│ GET /health        │  → { ok: true, app: "contentstudio" }
└────────────────────┘
```

Failed pushes are never dropped or degraded — they stay in a
`chrome.storage.local` outbox and are retried on the next alarm cycle or when
you press **Sync now** in the popup. Failure states stay distinct end to end:
bad token (401), payload rejected (400, details logged to the service worker
console), and app-not-running (connection refused) each render differently in
the popup.

## Build

```bash
cd extension
npm install
npm run build       # bundle TS + copy manifest/HTML/CSS into dist/
npm run watch       # rebuild on TS changes (re-run for static-only changes)
npm run typecheck   # tsc --noEmit
```

## Load into Chrome

`dist/` is the complete, loadable extension root — the build copies
`manifest.json`, the popup/options HTML/CSS, and the bundled JS into it.

1. Run `npm run build`.
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the **`extension/dist/`** directory
   (absolute path: `/Volumes/Callisto/Projects/ContentStudio/extension/dist`).

After a rebuild, click the reload icon on the extension card in
`chrome://extensions` to pick up changes.

Note: `manifest.json` at `extension/manifest.json` is the source of truth; the
build copies it into `dist/`. Paths inside it (`background.js`, `popup.html`,
`options.html`) are relative to `dist/` because `dist/` is what Chrome loads.

## Configure

1. Open the ContentStudio desktop app and go to its **Analytics** page. It
   shows the local ingest **port** (default 43117) and a **token**.
2. Right-click the extension icon → **Options** (or open the popup and click
   "Options").
3. Enter the port and paste the token.
4. Add each YouTube channel to collect: the **channel ID** (starts with `UC`,
   24 characters — YouTube Studio → Settings → Channel → Advanced settings)
   and a display name. Invalid IDs are rejected on save.
5. Open the popup: the connection row should show
   **Connected to ContentStudio** while the app is running.

## Visibility scheduler (0.3.0; in Studio's dialog since 0.4.0)

Click a video's visibility, on the Content list or its Details page, and Studio's dialog has
a **Change visibility later** box under **Schedule**: pick the visibility and time, press
**Schedule change**. It is saved then and there; Studio's own buttons do not affect it.

The Studio shelf's **This video** tab has a **Visibility** section whenever a
video is open. It reads and schedules visibility changes (public / unlisted /
private at a set time) on the scheduler at
`https://contentstudio.owenmorgan.com/scheduler` (server code in
`server/visibility-scheduler/`, plan in `VISIBILITY-SCHEDULER-PLAN.md`). It
talks to Triton only, so it works with the ContentStudio desktop app closed.

- **Permission:** `host_permissions` includes
  `https://contentstudio.owenmorgan.com/*` for these calls.
- **Key:** make a device key on the setup page (Device keys), paste it into
  Options → Visibility scheduler → **Save key**. **Test** calls `/health` and
  `/channels` with the key in the field and lists the connected channels, or
  shows the server's error. Stored in `chrome.storage.local` under
  `schedulerKey`; sent only to the scheduler as `Authorization: Bearer`.
- **Transport:** the content script never fetches the scheduler itself
  (Studio's CORS); it messages the service worker (`scheduler-*` messages,
  `src/scheduler/scheduler-messages.ts`), which calls the API
  (`src/scheduler/scheduler-client.ts`). Server errors (`{error}`) reach the
  shelf verbatim.
- **What the section shows:** the video's visibility now, and "YouTube will
  publish at …" when YouTube's own schedule is set; pending changes soonest
  first (Edit / Cancel), history newest first (failed in red with the
  server's message; done as before → after, "ran N min late" past two
  minutes, "cancelled YouTube’s own schedule"); **+ Schedule a change**
  (visibility, local date and time, optional note). Times are sent as ISO with
  this computer's offset for that date; a time the clocks skip or repeat is
  refused. Warnings the server returns on save are shown under the list.
- **States:** no key → says so with an **Open Options** link; a video no
  connected channel owns → says so, with the server's message; any other
  failure → a red box with the message.
- **Reads are lazy:** the video is read only when the section is on screen
  (expanded shelf, This video tab), because each read is a YouTube API call on
  the scheduler's quota. The shelf's ⟳ re-reads it. No background polling.

The pure helpers (runAt with offset, row text, ordering) are checked by
`node tools/visibility-format-checks.js` (part of the root `check:pure`).

## Popup status reference

| Row | Meaning |
| --- | --- |
| Connected to ContentStudio | `GET /health` returned `{ok:true,app:"contentstudio"}` |
| ContentStudio not running | connection refused — start the app or fix the port |
| Unauthorized | the server returned 401 — re-paste the token from the Analytics page |
| Unexpected response | something answered on that port, but it is not ContentStudio |
| Collector: Pending Studio recon | data collection is not implemented yet (see below) |
| Outbox: N payload(s) queued | payloads waiting for a successful push |

## Current limitations

- **The collector is not implemented.** `src/collector.ts` defines the
  contract and throws `CollectorNotImplementedError('Studio endpoint recon
  pending')`. No YouTube-internal endpoint code exists anywhere in this
  repository yet — the Studio endpoints (URLs, request shapes, auth, response
  parsing) must be reconnoitered first. The future implementation will call
  Studio's internal analytics JSON endpoints with the user's existing session
  credentials — never DOM scraping. See the header comment in
  `src/collector.ts` for the full contract, including per-video cadence
  tiering (<7d every 6h cycle, 7–28d daily, 28–365d weekly, >1y monthly).
- Snapshots therefore never accumulate yet; the outbox only ever carries
  payloads once the collector lands.
- Watch mode re-copies static files (manifest/HTML/CSS) after each TS rebuild
  only; if you change *only* a static file, re-run `npm run build`.
- No extension icons yet — Chrome shows the default puzzle piece.

## Layout

```
extension/
├── manifest.json        MV3 manifest (source; copied into dist/ by the build)
├── package.json         self-contained toolchain (typescript + esbuild)
├── tsconfig.json        strict TS config for `npm run typecheck`
├── scripts/build.mjs    esbuild bundle + static copy → dist/
├── public/              popup.html / options.html / companion.css (copied to dist/)
├── src/
│   ├── types.ts         shared data contract (mirrors ContentStudio's schema)
│   ├── settings.ts      typed chrome.storage.local wrapper (port/token/channels)
│   ├── ingest-client.ts localhost HTTP client with distinct typed failure states
│   ├── outbox.ts        persistent queue for failed pushes + flush logic
│   ├── status.ts        per-channel lastAttempt/lastError + last-cycle summary
│   ├── collector.ts     CONTRACT ONLY — throws until Studio recon is done
│   ├── background.ts    service worker: alarms, collection cycle, sync-now
│   ├── popup.ts         status view logic
│   ├── options.ts       settings editor logic (port, scheduler key)
│   ├── publish/         the Studio shelf (visibility-panel.ts = its Visibility section)
│   └── scheduler/       visibility scheduler client, messages, pure formatting
└── dist/                build output = the loadable extension (git-ignored)
```
