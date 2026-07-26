# Title A/B Test Feature — Plan

Status: **v1 VALIDATED END-TO-END on a live draft (2026-07-26).** Steps 1–3 and 5 built and
working; remaining work listed in §6 and §8.

First successful full run — Fireside draft `oTRHqYYTTi8` (`f2 - amanda grace.mov`), all five
fill actions green:
```
✓ Tags: Removed 16 existing tag(s), added 12.
✓ Description: Replaced the description (1806 chars).
✓ No altered/AI content: Answered "No" to altered content. (already set)
✓ No paid promotion: Paid promotion is unchecked (no sponsor).
✓ Title + A/B variants: Filled 3 A/B variants. Press "Set test" to start the test.
```
Studio then reported **"Title test ready"** with Set test enabled. The operator still
presses Set test and Save — by design.

Three bugs were found only by running it live, all with the same root cause: the original
DOM recon was done on the standalone `/video/<id>/edit` page, but the real workflow is the
upload wizard, and the two differ more than assumed (different A/B dialog host element,
navigation chips polluting `ytcp-chip`, paid promotion as a checkbox instead of radios).
**Any future recon must be done in the wizard.**

Goal: after analysis, pick 3 titles (plus description + tags), auto-link the job to the
right YouTube draft, push metadata, and set up a 3-variant native title A/B test — per
channel, across three channels, operable by both Owen and his editor.

Built to a real product bar (multi-operator, multi-machine, guided setup) but never
listed publicly. Designed to lift cleanly into the planned ContentStudio + AutoCutStudio
merge — see §7.

---

## 1. External facts (verified — don't re-derive)

### Native A/B testing
- YouTube's **"A/B test titles & thumbnails"** supports titles. Global rollout ~2025-12-04,
  requires Advanced Features, not YPP-gated. https://support.google.com/youtube/answer/16391400
- **Up to 3 variants.** Runs ≤2 weeks. Winner = **watch time per impression, not CTR.**
  Inconclusive → variant 1 wins, so **variant order is a real decision.**
- Configurable **during the upload/draft flow**, then published or scheduled. ✅ Confirmed
  live on a draft — so the draft → set variants → publish path works.
- Not eligible: Shorts, Premieres (until converted), Made for Kids, age-restricted, and
  **private videos** (see §3 for why this doesn't block the draft flow).

### No API, and no legal headless path
- Data API v3 has **no** experiment/test/variant resource (revision history clean through
  2026-07-07). Analytics API has no experiment dimension. Content ID is unrelated.
- No public tool creates a native test programmatically. TubeBuddy/vidIQ/ThumbnailTest do
  **not** drive native A/B — they run their own `videos.update` rotation. They're also
  YouTube-certified partners, which is itself the ToS "prior written permission" carve-out;
  that status doesn't transfer.
- **Decision taken:** the last mile is a Chrome-extension **autofill with human approval** —
  the operator opens the draft, reviews what's proposed, and clicks. Not headless
  automation. Rationale: the operator is the channel owner (or a delegated editor acting
  with permission), nothing is scraped, and the committing action is always a human click.

### Drafts via the API — SPIKE RESULTS ✅
Ran read-only against all three live channels 2026-07-25.

- **Private drafts DO enumerate** via `channels.list` → uploads playlist →
  `playlistItems.list` → `videos.list`. Confirmed on all three channels.
  `search.list` remains unreliable (index lag) — don't use it.
- **`fileDetails.fileName` is NOT returned.** Even with
  `processingDetails.fileDetailsAvailability === 'available'`, `fileName` and `fileSize`
  come back `undefined`. Only `durationMs` is populated. **No exact filename join via API.**
  (But see §3 — the Studio DOM has it.)
- **`durationMs` IS returned** — a near-unique fingerprint, useful as a verification guard.
- **`videos.update` replaces the whole submitted part.** Omitted mutable fields are cleared;
  `snippet.title` + `snippet.categoryId` are required when updating `snippet`. Always
  read-modify-write.
- `status.publishAt` only settable while private and never-published.
- Title max length: **100 chars** (Studio shows a live `n/100` counter).

### Quota (bucketed model — older blog figures are superseded)
10,000 units/day shared, plus separate 100/day buckets for `search.list` and `videos.insert`.
`videos.update` = 50, `videos.list` = 1, `playlistItems.list` = 1, `thumbnails.set` = 50.
Resets midnight Pacific. ~200 metadata writes/day ceiling — ample.

---

## 2. Live inventory (2026-07-25)

| Channel | State |
|---|---|
| **Owen Morgan (Telltale)** `UCgIi12EA6BQ8HKL8QUccsOQ` | **0 drafts.** 3 private videos, all **scheduled** (`publishAt` Jul 26 / Jul 30 / Aug 2), real titles, 2.1–2.4k descriptions. **Hands off.** |
| **Owen's Fireside Chat** `UCo6JSNp6SuUKf-yiaBQReNA` | **3 drafts:** `f3   trump coins`, `f2   amanda grace`, `3  Book Signing` |
| **Owen Unfiltered** `UCOB86WpguzlOEs4z93iZ7kA` | **5 drafts:** `u1   flashpoint pt 1`, `u2   flashpoint pt 2`, `u3   amanda grace`, `u4   killing america ch 4`, `u5   killing america ch 5` |

**Draft signature:** `privacyStatus === 'private'` **AND** no `publishAt`, plus the channel
upload defaults (`descLen: 448`, `tags: 16`) and a filename-derived title.

⚠️ **The `publishAt` gate is the single most important safety rule in this feature.**
`private` alone means "draft OR finished-and-scheduled." Treating private as draft would
overwrite finished work.

---

## 3. Studio DOM — SPIKE RESULTS ✅

### ⚠️ TWO ENTRY POINTS — the wizard is the one that matters (corrected 2026-07-26)

Drafts are normally opened via **"Edit draft"**, which launches the **upload wizard modal**,
not the standalone details page:

```
upload wizard (PRIMARY)  https://studio.youtube.com/channel/<cid>/videos/upload?…&udvid=<videoId>
standalone page          https://studio.youtube.com/video/<videoId>/edit
```

The standalone URL works if typed directly, but **YouTube exposes no link to it for drafts** —
so normal navigation always lands in the wizard (Details → Monetization → Video elements →
Checks → Visibility, with a Next button). A content script matching only `/video/*` never
runs on the real workflow. Manifest therefore matches `https://studio.youtube.com/*`.

Differences to handle:
| | standalone `/video/<id>/edit` | upload wizard |
|---|---|---|
| videoId | path segment | **`udvid` query param** |
| draft marker | banner "This video is in a draft state" | chip **"Saved as draft"** |
| everything else | identical | identical |

Verified live in the wizard: title field, description field, `ytcp-video-info` filename,
`ytcp-button#ab-test-button`, `ytcp-button#toggle-button` all resolve.

⚠️ **The A/B dialog's HOST ELEMENT differs between entry points.** On the standalone page
it is `ytcp-dialog`; in the upload wizard it is `tp-yt-paper-dialog#dialog`. Scoping the
variant-slot lookup to `ytcp-dialog` alone finds nothing in the wizard and times out (real
bug, hit on first live run — the main title and description filled fine, only the variants
silently failed). Locate slots via `div#textbox[aria-label^="Add title"]` first, with a
positional fallback across `tp-yt-paper-dialog, ytcp-dialog` that **skips any container
holding the description field** — that container is the wizard form itself, whose
title+description textboxes would otherwise be mistaken for two variant slots and
overwritten.

**Stable ids found (prefer these over visible text — locale-proof):**
- `ytcp-button#ab-test-button` — the TITLE A/B trigger. Note the page also has a separate
  thumbnail experiment control (`ytcp-thumbnails-experiment-editor`) that must NOT be clicked.
- `ytcp-video-metadata-editor ytcp-button#toggle-button` — the "Show more" expander.

Run live against draft `oTRHqYYTTi8` (`f2   amanda grace`) on 2026-07-26. Test string was
written, verified, and removed; draft left clean (Save/Undo both disabled afterward).

**Everything needed is in the LIGHT DOM. No shadow-root piercing required.**

| Need | Selector / source | Verified value |
|---|---|---|
| Video ID | `location.pathname.match(/\/video\/([^/]+)\//)[1]` | `oTRHqYYTTi8` |
| **Original filename** | `ytcp-video-info div.label` where text is `Filename` → `.nextElementSibling` (`div.value`) | **`f2 - amanda grace.mov`** |
| Main title field | `div#textbox[aria-label^="Add a title"]` | `f2   amanda grace` |
| Description field | `div#textbox[aria-label^="Tell viewers"]` | (channel default boilerplate) |
| A/B variant 1 | `div#textbox[aria-label="Add title 1"]` | prefilled w/ current title |
| A/B variant 2 | `div#textbox[aria-label="Add title 2"]` | required |
| A/B variant 3 | `div#textbox[aria-label="Add title 3"]` | optional |
| A/B open trigger | button labelled `A/B Testing` beneath the title box | — |
| A/B modes | tabs: `Title only` \| `Thumbnail only` \| `Title and thumbnail` | `Title only` default |
| Commit | `Set test` button — disabled until variant 2 is non-empty | — |
| Draft detection | banner `This video is in a draft state` | — |

**🎯 The Studio DOM exposes the original filename that the API withholds.** So matching is an
*exact* filename join, not fuzzy title similarity. This is the single most valuable finding.

### Second recon pass (2026-07-26) — tags, altered content, paid promotion

Behind **Show more** (must be clicked first; the fields don't exist until then).

| Need | Selector | Verified |
|---|---|---|
| Tags input | `input#text-input[aria-label="Tags"]` — a plain `<input>`, light DOM | value empty, 16 chips already present |
| Existing tag chips | **`ytcp-form-input-container#tags-container ytcp-chip`** — MUST be scoped, see below | 16 channel-default tags |
| Chip remove button | `ytcp-chip #delete-icon` — **use the id**, `aria-label="Remove"` is localized | ✅ clicking removes the chip |

⚠️ **`ytcp-chip` MUST be scoped to `#tags-container`.** In the upload wizard the modal
overlays the channel content list, whose navigation filter chips (Videos / Shorts / Live /
Posts / Playlists) are ALSO `ytcp-chip`, are also visible, and sort FIRST in document order.
Live counts: 21 visible `ytcp-chip` = 5 nav + 16 tags. An unscoped selector grabs "Videos",
which has no `#delete-icon`, so clearing dies before touching a single real tag — which is
exactly how the first live run failed. Scoped, it returns the 16 tag chips, all deletable.
| No-AI answer | `tp-yt-paper-radio-button[name="VIDEO_HAS_ALTERED_CONTENT_NO"]` | **currently unanswered** — both YES and NO are `aria-checked=false` |
| No-sponsor answer | **TWO SHAPES** — standalone: `tp-yt-paper-radio-button[name="VIDEO_PAID_PRODUCT_PLACEMENT_NO"]`; wizard: checkbox `ytcp-checkbox-lit#has-ppp` where UNCHECKED = no paid promotion | radios absent entirely in the wizard |
| Made for kids | `[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]` | already `true`, leave alone |

**🎯 The radios carry stable `name` attributes** (`VIDEO_HAS_ALTERED_CONTENT_NO` etc.), which
are locale-independent — that removes the localization risk for these fields entirely. Prefer
`name` over any visible-text or aria-label selector.

**Tags fill mechanic — CONFIRMED WORKING.** Unlike the title/description contenteditables,
this is a real `<input>`, so it needs the native value setter, not `execCommand`:

```js
const input = document.querySelector('input#text-input[aria-label="Tags"]');
const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
input.focus();
nativeSetter.call(input, 'tag one,tag two,tag three');  // commas split into separate chips
input.dispatchEvent(new Event('input', { bubbles: true }));
for (const t of ['keydown','keypress','keyup'])         // Enter commits
  input.dispatchEvent(new KeyboardEvent(t, { key:'Enter', code:'Enter', keyCode:13, which:13, bubbles:true }));
```
Verified live: one comma-separated write + Enter took the chip count 16 → 18, creating both
chips at once. So the whole tag set goes in with a single write.

⚠️ **Tags REPLACE requires clearing first.** The 16 channel-default chips are not overwritten
by typing — new tags are appended. The filler must click every `ytcp-chip #delete-icon` (loop
with a guard; each removal re-renders) before writing the new set.

⚠️ Adding/removing chips marks the form **dirty** even if the end state is identical, so the
extension should surface that Save is now required rather than leaving it ambiguous.

It also confirms the normalization rule: `f2 - amanda grace.mov` → YouTube title
`f2   amanda grace` (extension stripped, ` - ` collapsed to whitespace).

### Fill method — CONFIRMED WORKING
The fields are `contenteditable` divs, so `.value` assignment does nothing. What works:

```js
const el = document.querySelector('div#textbox[aria-label="Add title 2"]');
el.focus();
const sel = getSelection(), range = document.createRange();
range.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(range);
document.execCommand('insertText', false, title);   // genuine beforeinput/input sequence
```

Verified: Polymer registered the change — the "2nd title is required" error cleared and the
**Set test** button flipped from disabled to enabled. Clearing via `execCommand('delete')`
reverts it. **No native-setter hack or synthetic-event fabrication needed.**

---

## 4. What already exists in-repo

| Piece | Status | Location |
|---|---|---|
| Per-channel OAuth, **full `youtube` read/write scope already consented** | ✅ | `electron/services/youtube/youtube-auth.service.ts:43-46` |
| Per-channel token bundles (all 3 live, refresh tokens valid) | ✅ | `<userData>/youtube-tokens.json` |
| Channel registry + prompt-set→channel mapping | ✅ | `<userData>/analytics/channels.json` |
| Uploads enumeration | ✅ | `youtube-api.service.ts:225,239` |
| Analytics collection + verdicts + insights→prompt injection | ✅ | `analytics/`, `extension/` |
| Extension ↔ app localhost channel (`:43117`) | ✅ | `ingest-server.service.ts`, `extension/src/ingest-client.ts` |
| Extension already injects into Studio MAIN world | ✅ | `extension/src/collector.ts:266,295` |
| `titleHistory[].origin: upload\|manual-edit\|ab-rotation\|test-compare` | ✅ schema only | `analytics-types.ts:29` |
| `VideoVerdict.abTest {variants,winner,method,liftPct}` | ✅ schema, **never written** | `analytics-types.ts:68` |
| `ChannelInsights.abLearnings` → generation prompt + UI | ✅ consumer wired | `distillation.service.ts:318`, `insights-prompt.ts:62-69` |
| 10 titles generated, top 3 framed for A/B | ✅ | `electron/assets/youtube-*.yml:145` |
| Guided-setup precedent to match | ✅ | `ai-setup-wizard/`, `environment-setup.ts`, component downloader |

**The A/B loop is a fully-designed empty socket** — writing `abTest` lights up `abLearnings`,
which feeds straight back into title generation. That's the closed loop.

### Missing
❌ Title picking/editing (display-and-copy only) · ❌ chosen-metadata persistence ·
❌ **any write to YouTube** (every call is a GET) · ❌ job↔video linkage · ❌ A/B engine ·
❌ extension content script (it uses `executeScript`, has no content script yet) ·
❌ extension host permission for reading its own app's publish queue (localhost already allowed)

---

## 5. Target flow

1. **Analyze** (existing) → 10 titles + description + tags.
2. **Pick** in ContentStudio: 3 titles, ordered (variant 1 wins ties). Edit description/tags
   inline. → persists a `ChosenMetadata` record.
3. **Link** job → draft. Enumerate the channel's drafts (private, no `publishAt`), match on
   normalized filename, verify against `durationMs`, show the operator the proposed links
   for confirmation.
4. **Push** description + tags (+ title variant 1) via `videos.update`. Robust, no DOM,
   read-modify-write. Happens before Studio is ever opened.
5. **Open the draft in Studio.** Extension content script reads the videoId from the URL and
   the exact filename from the sidebar, asks ContentStudio what it has, and shows a small
   panel: *"Matched job `f2 - amanda grace` — fill 3 A/B titles?"* with the titles visible.
6. **Operator clicks fill.** Extension opens the A/B dialog, fills variants via
   `execCommand('insertText')`. Operator reviews, clicks **Set test**, continues through
   the normal ads/visibility flow, publishes or schedules.
7. **Record.** ContentStudio writes `titleHistory` spans (`origin: 'test-compare'`) and a
   pending `abTest`.
8. **Close the loop.** Outcome recorded → `abTest.winner` + `liftPct` → `abLearnings` →
   injected into the next generation. *(Whether the Studio verdict is machine-readable is
   still unknown — see §8.)*

**Why the DOM surface is deliberately tiny:** description and tags go through the API because
there's a perfectly good one; only the A/B variants — the thing with no API — touch the DOM.
Fewer selectors, less to break on a Studio redesign.

### Matcher rules
- **filename match + duration match** → auto-link, high confidence
- **filename match, duration mismatch** → link but flag (*"draft is 82 min, analyzed file was
  7.5 min — different cut?"*)
- **no filename match** → manual pick list of that channel's drafts
- **never touch a private video with `publishAt` set**
- Normalization: strip extension, collapse `_ . -` and whitespace runs to single spaces,
  lowercase, trim.

### Fallback: rotation engine (deferred, not v1)
`method: 'rotation'` — rotate titles on a schedule via `videos.update`, attribute deltas from
existing snapshots. Fully automatic, fully API-legal, but time-confounded (a title in week 1
vs week 3 isn't a fair comparison on fast-decaying content). Only worth it for back-catalog.
Schema already supports it. **Do not build in v1.**

---

## 5b. Fill actions (extension) — a registry, not hardcoded buttons

The operator gets per-field fill buttons plus a "fill everything". Each action is a
registry entry `{ id, label, detect, fill, verify }` so the planned additions (thumbnail
upload, scheduling) are one new entry rather than surgery on the panel.

| id | Fills | Notes |
|---|---|---|
| `title` | Main title **and** the 3 A/B variants | One action, not two — picking 3 titles has to actually produce a test. If A/B is unavailable for this video/account, degrade to setting the main title only (which is variant 1 by definition). |
| `description` | Description | Same `div#textbox` contenteditable as the title; `execCommand('insertText')` proven. Replaces the channel-default boilerplate, doesn't append. |
| `tags` | Tags | ⚠️ **Different mechanic** — a chip/token input that commits on comma/Enter, not a plain contenteditable. Needs its own recon before implementing. |
| `altered-content` | "No" on the Altered content / AI-disclosure radio | Owen never uses AI content. Studio **requires** an answer before publishing, so this saves a mandatory click every time. Operator can override. |
| `paid-promotion` | Leaves paid promotion unchecked / sets "no sponsor" | Same rationale — a standing default, overridable per video. |
| `all` | Runs every applicable action in order | The one-click path. |

Each action must **fail loud** when its selector misses — a silent no-op reads as "filled"
and would be discovered only after publishing.

## 6. Build order

1. ✅ **DONE — `ChosenMetadata` model + persistence.** `electron/services/publish/`
   (`publish-types.ts`, `publish-store.service.ts`, `publish-ipc.ts`), stored under
   `<userData>/publish/selections/<jobId>.json`. Kept out of `<jobId>.json` so raw
   generator output stays pristine and regeneration isn't shadowed by a stale edit.
   `readGenerated` is injected, so publish/ imports nothing from services/metadata.
2. ✅ **DONE — title selection UI.** `frontend/src/app/features/publish/` (`publish.types.ts`,
   `publish-state.ts`) + numbered picking in metadata-reports. Click order = variant order,
   big variant badge, up/down reorder, 3-variant cap, clear-all. Selection lives in the
   shared service; the component only renders it (the one seam).
   *Still to add here: inline description/tags editing — the IPC (`publish-set-fields`) and
   state (`setFields`) are already built and wired, the UI controls aren't.*
3. ✅ **DONE — draft matcher.** `publish/video-matcher.ts` + `YouTubeApiService.listRecentUploads()`
   (new: requests `part=status`, stops after 100 videos instead of paging thousands; ~5 quota
   units). IPC: `publish-find-draft`, `publish-link-video`, `publish-unlink-video`. Never
   auto-links — the matcher proposes, linking is an explicit call. Verified against the real
   observed drafts: all 3 scheduled Telltale videos excluded, cross-channel `amanda grace`
   cuts stay distinct, separator variants normalize, duration mismatch downgrades to a
   warning, ambiguity refuses to guess.
   *Known gap: `sourceDurationSec` is not populated yet (needs an ffprobe probe of the source).
   Null is handled — it downgrades a match to 'filename' (unverified) rather than failing.*
4. ~~`videos.update` push~~ — **DROPPED from v1.** Everything is filled through the extension
   where the operator reviews before saving, which avoids the part-replacement footgun
   entirely. Kept in reserve for headless work (back-catalog rotation).
5. ✅ **BUILT (untested end-to-end) — extension content script.** `extension/src/publish/`
   (`dom.ts`, `fillers.ts`, `page.ts`, `panel.ts`, `publish-client.ts`) + entry
   `src/publish-content.ts`. Manifest gains a `content_scripts` entry for
   `studio.youtube.com/video/*`; build.mjs gains a SECOND esbuild pass in **iife** format
   because MV3 loads content scripts as classic scripts and the existing esm output would
   throw an import error at runtime.
   - Runs in the ISOLATED world — DOM nodes are shared across worlds, so no MAIN-world
     injection and no page-script privileges are taken.
   - Polls `location.href` every 600ms because Studio is an SPA and never fires a page load
     between videos.
   - Panel lives in a shadow root so Studio's CSS can't reach in.
   - Fill actions ordered so title/A-B runs LAST — it opens the modal that covers the rest
     of the form, leaving the operator looking at the A/B dialog with everything else done.
   - Every filler verifies its own write and reports a specific reason on failure.
   - ⚠️ **ALL localhost traffic goes through the service worker** (`publish-messages.ts`),
     never the content script. A content-script `fetch` is attributed to the PAGE's origin,
     so it (a) trips Chrome's local-network prompt — *"youtube.com wants to access services
     on this device"* — and (b) arrives with `Origin: https://studio.youtube.com`, which the
     ingest server's CSRF whitelist rejects with 403. That rejection is correct and must not
     be relaxed: it's exactly the malicious-page shape the guard exists to stop. The worker's
     `chrome-extension://` origin is whitelisted and isn't subject to page CORS. (Discovered
     the hard way on first live test; same reason the analytics collector fetches in the
     worker.) The error `kind` is preserved across the message boundary so 'unreachable'
     stays silent instead of showing an error box on every Studio page.
   *Also added: `PublishBridge` + `GET /publish/pending`, `POST /publish/resolve`,
   `POST /publish/filled` on the existing ingest server (structurally typed, so analytics/
   imports nothing from publish/). 26/26 HTTP tests incl. the CSRF guard.*
6. **Record + close the loop** — `titleHistory`, `abTest`, `abLearnings`.
7. **Onboarding** — OAuth setup wizard following the `ai-setup-wizard` pattern; replaces the
   hand-placed `youtube-oauth.json`. Warn that the unverified-app consent screen is expected.

---

## 7. Segmentation (for the AutoCutStudio merge)

- **Main process:** new `electron/services/publish/` — `publish-types.ts`, `video-matcher.ts`,
  `publish.service.ts`, `ab-recorder.ts`. May depend on `services/youtube/` and
  `services/analytics/` types; **must not** reach into `services/metadata/` internals. Input
  is the `ChosenMetadata` DTO defined in `publish/` — so the generator upstream stays swappable.
- **Frontend:** `frontend/src/app/features/publish/` (standalone components + one state
  service). The only edit to an existing component is metadata-reports emitting selection into
  that service. One seam.
- **IPC:** namespace `publish-*`, export a single `setupPublishIpc(deps)` registered with one
  call — don't scatter handlers through the 1800-line `ipc-handlers.ts`.
- **Extension:** put autofill in `extension/src/publish/`, fully separate from `collector.ts`.
  Different purpose, different lifecycle, different risk profile.
- **Persistence:** `<userData>/publish/`. `titleHistory`/`abTest` stay in `analytics/` where
  they already live.

`youtube/` and `analytics/` are already cleanly segmented and port as-is.

---

## 8. Open questions

1. **Is the A/B verdict machine-readable?** Studio shows Winner / Performed Same /
   Inconclusive. Unknown whether it's exposed via the `yta_web/join` graph the collector
   already speaks. Needs the same recon that produced `STUDIO-COLLECTOR-SPEC.md`. If not,
   the operator records the winner manually — the loop still closes, just with a human step.
2. **Advanced Features enabled on all three channels?** Required for A/B. Assumed, unverified.
3. **Editor's access model** — own Google account with a delegated Editor/Manager role, or
   signed in as Owen. Designing for the delegated case covers both, so this is not blocking.
   (Studio → Settings → Permissions shows granted roles.)
4. **Extension install on a second machine** — unpacked (dev-mode friction, nag on launch) vs
   Chrome Web Store unlisted (nicer install, reintroduces review). Deliberate call needed.
5. **Telltale had no drafts** at spike time — its uploads were already configured and
   scheduled. Confirm whether that channel's workflow differs.
