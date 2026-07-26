# YouTube A/B Title Test Exporter

Exports your own YouTube **A/B title test** results to a CSV file on your computer —
every title variant you tested, its watch-time share, and which one won.

**Nothing is uploaded.** The extension has no server. It writes a CSV to your Downloads
folder and stops there. Sharing that file with anyone is a separate decision you make.

---

## Why this exists

YouTube gives you no way to export A/B test results. There is no Data API resource for
them, no Analytics API dimension, and no CSV download in Studio — the results only exist
on screen, one video at a time. If you want them as data, something has to read them.

## Install

No build step, no npm, nothing to compile.

1. Download / unzip this folder.
2. Go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select this folder.

## Use

1. Open **YouTube Studio → Content** for the channel you want to export.
2. Click the extension icon.
3. Read the consent screen and continue.
4. It should say *"Found Studio tab for channel UC…"*. Click **Scan this channel**, then
   **Download CSV** when it finishes.

There is no channel ID to enter. The scan runs in the Studio tab you already have open,
so it always uses the account you're already signed in as. If you have several channels
under one Google login (a brand account), just open the one you want first — switching
channels in Studio is all it takes.

It opens a tab and steps through the relevant pages. Leave that tab alone while it runs.
Only videos your list marks as having an A/B test are opened, so a channel with thousands
of uploads still only takes a handful of page loads.

**Skip my back catalogue** (off by default, and usually leave it off): titles come from
the video list, so stopping the walk early leaves older videos with full analytics but no
title — in one real run, 1,383 of 1,561 videos. Walking the whole list only clicks through
pages, it does not load them, so it costs seconds. Only tested videos are ever opened, and
that is the slow part regardless. The run always reports when it stopped early, so a short
scan is never mistaken for a complete one.

It pauses a random 2–5 seconds between videos and stops immediately if Studio starts
rate-limiting, rather than pushing through.

**It uses the tab you started from.** No extra tabs are opened, and the tab is brought to
the front for every step so you can always see what it is doing. When a channel finishes it
is returned to your Content page rather than left on some video's edit screen.

**Memory:** YouTube Studio is a heavy page, and Chrome reuses one renderer process across
successive navigations — so hundreds of video pages in one tab would grow that process the
whole way. Every 20 videos the tab bounces through a blank page, which lets Chrome reclaim
that renderer, so a full-channel run stays flat instead of climbing. The scan's own data is
about 1 MB.

## Several channels at once

Open **Studio → Content** for each channel in its own tab. The popup lists every channel
it finds; tick the ones you want and they are scanned **one after another**, each saving
its own CSV named after its channel.

They are never scanned in parallel, and that is deliberate: the request rate is what makes
YouTube start throttling, so three at once would be slower in practice as well as riskier.
Sequential costs nothing extra — the pacing between videos dominates either way.

Resuming from a CSV applies to a single channel, so untick the others when you do that.

## It runs unattended

Start it and walk away. When the scan finishes the CSV **saves itself to your Downloads
folder** and you get a desktop notification, so nothing depends on you having a window
open at the right moment.

Results are written to the extension's local storage as they're collected, so a scan
survives Chrome suspending the extension (which it does aggressively). The download stays
available from the popup afterwards until you run the next scan — so grab or note each
channel's file before starting another one.

## Windows, macOS and Linux

Identical on all three. The extension only uses Chrome APIs, and the CSV is written via
Chrome's own downloads system, so it lands in whatever you have set as your download
folder on that machine. Filenames are restricted to letters, digits, dashes, underscores
and dots — no colons — so they are valid on Windows as well.

Timestamps in the filename are your **local** time.

## What it does not collect

**No earnings data, ever.** No revenue, RPM, CPM, ad performance or payment metrics are
requested. This is enforced in code — monetary metric names are filtered out before the
request is built — so it cannot be reintroduced by accident. Everything collected is
audience and performance data about your videos.

## Permissions, and why

| permission | why |
|---|---|
| `studio.youtube.com` | the only site it can access |
| `tabs`, `scripting` | open and read your Studio pages |
| `downloads` | save the CSV |
| `storage`, `unlimitedStorage` | keep results safe mid-scan; a full channel is a few MB |
| `notifications` | tell you when a scan finishes |
| `offscreen` | build the file for very large exports |

All are granted when the extension is loaded — nothing prompts mid-run. The popup checks
them on open and says so if any are missing.

## Stopping and resuming

A full channel takes a while, so you don't have to do it in one sitting.

While a scan runs, a small panel sits in the bottom-right of the Studio page with live
progress, a **Stop** button, and **Download CSV**. Stop halts after the current video and
keeps everything gathered so far — download it and you have a valid, partial export.

To carry on later: open the popup, pick that CSV under **Resume from a previous CSV**, and
scan again. Videos already exported are skipped; only what's left gets read. Rows that
failed with an error are retried rather than treated as done, and lifetime analytics are
refreshed for every row so the whole file stays internally consistent.

## What you get

One CSV covering the whole channel. Every video gets **lifetime analytics**; videos that
were A/B tested additionally get **one row per title variant** (long format, which is what
you want for training or analysis), with the analytics repeated on each so the file is a
single self-contained table.

| column | meaning |
|---|---|
| `videoId`, `videoUrl` | YouTube id and link |
| `title` | current title |
| `description` | **full** description, untruncated |
| `publishedAt` | release date (ISO) |
| `durationSec` | length in seconds |
| `privacy` | public / unlisted / private |
| `impressions` | lifetime thumbnail impressions |
| `impressionsCtrPct` | lifetime impressions CTR, e.g. `10.2` |
| `views`, `watchHours`, `avgPctViewed` | lifetime view metrics |
| `avgViewDurationSec` | average view duration |
| `subscribersNet`, `subscribersGained`, `subscribersLost` | subscriber movement |
| `newViewers`, `returningViewers` | audience split |
| `likes`, `dislikes`, `comments`, `shares` | lifetime engagement |
| `testState` | `FINISHED`, `INITIALIZED`, or blank |
| `testOutcome` | `winner`, `no-clear-winner`, `running`, `no-test` |
| `testFinishedReason` | YouTube's own reason code |
| `variantIndex` | 1, 2, 3 |
| `variantTitle` | that variant's title text |
| `testStartedAt`, `testFinishedAt` | when the test ran |
| `watchTimeSharePct` | that variant's watch-time share, e.g. `42.15` |
| `isWinner` | `yes` / `no` |

Note the winning metric is **watch-time share, not CTR** — that is what YouTube itself
uses to decide a title test.

Videos with a test still *running* are included with `testOutcome = no-report-yet` and no
variant rows, so you can see they exist without mistaking them for finished results.
Videos that were never tested appear once with `testOutcome = no-test` and analytics only.

Analytics come from a single request covering the entire channel — impressions and
impressions-CTR are not available in the public YouTube Analytics API at all, which is
part of why this tool exists.

### How fast it is

Everything comes from YouTube Studio's own endpoints — **no video pages are opened at
all**, so a whole channel takes seconds rather than hours:

| what | where from |
|---|---|
| titles, full descriptions, release dates, durations, A/B variants and state | `creator/list_creator_videos`, 100 per request |
| impressions, CTR, views, watch time, engagement, subscribers | `yta_web/join`, one request for the channel |
| watch-time share per variant, and the verdict | `creator/get_creator_videos`, 50 per request |

The share percentages are the same figures Studio's own report dialog shows — verified
against it — but obtained without loading the page they appear on.

## What it does and doesn't do

- **Reads only.** It never edits a title, changes a setting, or starts or stops a test.
- Works entirely in your own signed-in Studio session. It asks for no password and has no
  account of its own.
- One video at a time, with a pause between each. It is not trying to be fast.

## The honest caveat

Because YouTube offers no official export for this, the extension reads the Studio pages
directly. YouTube's Terms of Service restrict automated access to the service. This only
touches your own data in your own account, and only reads it — but it is a grey area, and
the risk, however small, is yours to accept. The consent screen says so before anything
runs.

If Studio changes its layout, the export may stop finding results. It will tell you
rather than silently returning an empty file.
