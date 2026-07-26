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

**Stop early once tests run out** (on by default): A/B testing is a recent YouTube
feature, so tested videos sit at the top of a date-sorted list. This stops after 3
consecutive pages with no tests rather than paging through years of back catalogue. If
you have tested an older video, untick it to scan everything — the run tells you when it
stopped early, so a short scan is never mistaken for a complete one.

It pauses a random 2–5 seconds between videos and stops immediately if Studio starts
rate-limiting, rather than pushing through.

**Memory:** YouTube Studio is a heavy page, and Chrome reuses one renderer process for
successive navigations — so driving hundreds of video pages through a single tab would
grow that process the whole way. The scan replaces its working tab every 20 videos to hand
that memory back, and parks it on a blank page when it finishes, so a full-channel run
stays flat rather than climbing. The scan's own data is about 1 MB.

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
| `videoId` | YouTube video id |
| `videoUrl` | `https://youtu.be/<id>` |
| `currentTitle` | the video's title as it appears in your list now |
| `impressions` | lifetime thumbnail impressions |
| `impressionsCtrPct` | lifetime impressions click-through rate, e.g. `10.2` |
| `views` | lifetime views |
| `watchHours` | lifetime watch time in hours |
| `avgPctViewed` | average percentage of the video watched |
| `testStatus` | `A/B Test running` or `A/B Test completed` |
| `testOutcome` | `winner`, `performed-same`, `inconclusive`, `running` (still in progress), `no-test`, or `unrecognised: <text>` carrying Studio's own wording if YouTube changes it |
| `variantIndex` | 1, 2, 3 — the order YouTube showed them in |
| `variantTitle` | the title text of that variant |
| `watchTimeSharePct` | that variant's watch-time share, e.g. `42.1` |
| `isWinner` | `yes` / `no` |
| `isCurrentlyLive` | `yes` if this variant is the one now shown to everyone |
| `ranFrom`, `ranTo` | the test window as Studio reports it |

Note the winning metric is **watch-time share, not CTR** — that is what YouTube itself
uses to decide a title test.

Videos with a test still *running* are included with `testOutcome = no-report-yet` and no
variant rows, so you can see they exist without mistaking them for finished results.
Videos that were never tested appear once with `testOutcome = no-test` and analytics only.

Analytics come from a single request covering the entire channel — impressions and
impressions-CTR are not available in the public YouTube Analytics API at all, which is
part of why this tool exists.

### Descriptions

Not included, on purpose. Descriptions are public data, so `yt-dlp` gets them far more
cheaply than driving Studio thousands of times. Join on `videoId`:

```bash
yt-dlp "https://www.youtube.com/channel/<UC…>/videos" \
  --skip-download --ignore-errors \
  --print-to-file "%(id)s\t%(title)j\t%(description)j" descriptions.tsv
```

The `j` conversion JSON-encodes each field so newlines inside descriptions don't break
the file.

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
