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

## What you get

One row per **variant** (long format, which is what you want for training or analysis):

| column | meaning |
|---|---|
| `videoId` | YouTube video id |
| `videoUrl` | `https://youtu.be/<id>` |
| `currentTitle` | the video's title as it appears in your list now |
| `testStatus` | `A/B Test running` or `A/B Test completed` |
| `testOutcome` | `winner`, `performed-same`, `inconclusive`, or a reason it couldn't be read |
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
