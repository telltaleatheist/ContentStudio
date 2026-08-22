# Phase 4 — Metadata report redesign + publish calendar

Design doc. Read-only investigation of the repo at `/Volumes/Callisto/Projects/ContentStudio`,
2026-08-21. Status: **PROPOSED** — nothing here is built. Companion mockups:
`report-mockup.html`, `calendar-mockup.html` (same directory, static, open in a browser).

Audience of the software: one operator, one Mac Studio, wide display, keyboard-fluent, runs
three YouTube channels plus a podcast. Every trade-off below resolves toward **density and
fewer gestures**, not toward whitespace or discoverability-for-newcomers.

---

## 0. What I measured first

Numbers, not impressions. All from the live install.

**The report list is 111 rows of nearly identical chrome.**
`/Volumes/Callisto/ContentStudio/.contentstudio/metadata` holds 111 job JSONs: 94 distinct
sources, 11 with no titles at all (failed runs, indistinguishable from good ones in the list),
and 17 rows that are re-runs of a source already in the list (`4 - satanism.mov` ×7,
`2 - starburst.mov` ×6, `1 - kent christmas.mov` ×3). Prompt sets: fireside 46, unfiltered 36,
telltale 23, podcast-spreaker 6. The list today shows title + date + prompt-set badge and
offers **no search, no filter, and no state**. Finding "the Kent Christmas one I scheduled" is
a scroll-and-squint.

**A real report is four to five screens of vertical scroll.**
Section heights from `metadata-reports.scss` and a real item
(`job-1787348933385-5e6swauyc.json`, "1 - kent christmas"):

| Section | Approx. height |
|---|---|
| Publish panel (channel + schedule + thumbnail + proposal) | 380–560 px |
| Titles (10 rows) | ~560 px |
| Description (`min-height: 300px` textarea + header) | ~400 px |
| Tags (13 chips) | ~140 px |
| Thumbnail Text (10 rows) | ~460 px |
| Chapters (5–30 rows) | 200–1100 px |
| Pinned Comment (3) | ~180 px |
| Clip Suggestions (5 long rows) | ~400 px |
| **Total** | **~2,700–3,800 px** |

Usable viewport on the reports route is roughly 800 px. So: **3.5–4.75 screens, in one column,
at a fixed `350px 1fr` grid** (`metadata-reports.scss:26-33`) that leaves ~700 px of the Mac
Studio's width empty on the right at typical window sizes.

**The single most important decision is buried at position 2.**
Picking the three A/B titles in order is the highest-stakes thing the operator does with a
report — click order is variant order and variant 1 is what YouTube keeps when a test is
inconclusive (`metadata-reports.ts:96-99`). It currently sits below a Publish panel that can be
560 px tall, and the *result* of that decision (which three, in what order) is only readable by
scanning ten rows for badges. There is no place that shows the chosen slate as a slate.

**Publish state is invisible until you scroll to it.** Channel, schedule, thumbnail, podcast
flag and A/B count are five independent facts about an item and there is no line anywhere that
shows all five.

**`channelId` is null on all 44 live selection records.** The unrouted state is not an edge
case to sweep up later; it is the *majority* state at design time, and the calendar must render
it as a first-class thing rather than dropping those rows.

**The renderer scans the disk on every mount.** `loadReports()` (`metadata-reports.ts:381+`)
reads and `JSON.parse`s all 111 job files in the renderer, per mount and per refresh. Called
out in `PUBLISH-PIPELINE-PLAN.md` Phase 4 as "fix while in there". It is also the reason the
calendar cannot simply be another renderer-side scan.

**A vocabulary correction.** The brief mentions `pushedAt` on publish records. There is no such
field. The record (`electron/services/publish/publish-types.ts:150-236`) has `publishAt`,
`publishAtSetAt`, `updatedAt`, and `filledAt` ("when the extension last filled Studio"), plus
`status: 'selecting' | 'ready' | 'linked' | 'filled' | 'published'`. The calendar's "has it
gone out" axis is `status` + `videoId`, and `filledAt` is the extension-touched timestamp.
Designed against the real fields.

---

## 1. The report page

### 1.1 What the operator actually does with a report

Observed from the code paths that exist and the data on disk, in order:

1. **Pick the A/B slate** — three titles, ordered, from ten candidates; sometimes tweak one
   inline first.
2. **Read the description, occasionally override it**; same for tags.
3. **Harvest copy-outs** — thumbnail text goes to the thumbnail designer, chapters go into the
   YouTube description box, pinned comment goes into a comment, clip suggestions go to the
   Shorts editing session. These are *clipboard sources*, not decisions. Every one of them is
   already a click-to-copy surface.
4. **Record publish intent** — channel, date/time, thumbnail image, podcast flag.
5. **Push** — extension fill today, API upload in Phase 3.

Steps 1–2 are *editing*. Step 3 is *extraction*. Steps 4–5 are *dispatch*. The current page
interleaves all three in one scrolling column, in an order that matches none of them. The
redesign gives each its own column.

### 1.2 Layout — three columns, no page scroll

```
┌──────────────┬──────────────────────────────────────┬───────────────────────┐
│ REPORTS      │ ① READINESS STRIP  (one line)        │ PUBLISH  (sticky)     │
│ (280px,      │──────────────────────────────────────│  channel              │
│  resizable)  │ ② A/B SLATE   1 ▸ 2 ▸ 3              │  schedule + offset    │
│              │──────────────────────────────────────│  thumbnail + proposal │
│ search box   │ ③ TITLES   (10 rows, own scroll)     │  podcast              │
│ filter chips │                                      │  ─────────────────    │
│              │──────────────────────────────────────│ ASSETS (accordion)    │
│ ▸ row        │ ④ DESCRIPTION (capped, own scroll)   │  ▸ Thumbnail Text 10  │
│ ▸ row  ●●    │──────────────────────────────────────│  ▸ Chapters        5  │
│ ▸ row  ●     │ ⑤ TAGS (chips, wrap)                 │  ▸ Pinned Comment  3  │
│              │                                      │  ▸ Clip Suggests   5  │
└──────────────┴──────────────────────────────────────┴───────────────────────┘
     280px                    fluid, min 620px                420px
```

The page itself never scrolls. Each of the three columns scrolls independently, and inside the
middle column the Titles list and the Description each have their own capped, scrolling
viewport. This is the single biggest change: **the vertical budget stops being a queue and
becomes a set of panes.** A 30-chapter report and a 5-chapter report present identically.

Why the publish rail moves right rather than staying on top: it is *reference and dispatch*,
consulted at the end, but it must stay visible while the titles are being picked — because
"which channel is this?" changes which titles are right. Sticky right rail solves both; a
collapsible top panel solves neither.

Why the assets go in the rail rather than the work column: they are pure clipboard sources.
Collapsed accordion headers carry their counts (`Thumbnail Text 10`), so nothing is hidden —
the count *is* the information until you want the text. Chapters expanded by default when
present (they are pasted almost every time); the other three collapsed. `chaptersSkipped`
renders as an expanded, non-collapsible reason block in the Chapters slot, exactly as today.

### 1.3 ① The readiness strip

One line under the report's title. Five chips, each showing state and each a jump target:

```
[Telltale ▾]  [Aug 24, 09:00 EDT]  [A/B 3/3]  [Thumb ✓]  [Podcast —]      [Push ▸]
```

- Grey/hollow = not set. Solid = set. Warn amber = set but suspect (schedule in the past,
  offset disagreement, thumbnail warnings).
- Clicking a chip focuses the corresponding control in the right rail; clicking `A/B 3/3` puts
  focus in the titles list.
- `Push ▸` is a placeholder in Phase 4 (Phase 3/5 wire it). It renders disabled with the reason
  as its tooltip — "no channel", "no titles picked" — which makes the strip a checklist.

This is the line that currently does not exist anywhere, and it is what makes the page
answerable at a glance.

### 1.4 ② The A/B slate

Three numbered slots above the titles list, always rendered:

```
 ①  Kent Christmas Says God Will Send a Death Angel to Kill Congress    main · YouTube's fallback
 ②  Kent Christmas Only Heals the Dying if They Tithe First
 ③  ⌀ empty — click a title below
```

Slot 1 is annotated because slot 1 is a different kind of choice from slots 2 and 3: it becomes
the video's title and the variant YouTube keeps if the test is inconclusive. That fact is
currently a sentence of hint text above a ten-row list; here it is attached to the thing it
describes. Character counts sit on each slot against the 100-char limit already enforced in the
editor (`MAX_TITLE_LENGTH`).

The slate is a **display of `publish.chosenTitles()`**, not a second editor. Clicking a slot
scrolls its row into view in the list below and highlights it. Removing is done where it is
done today — clicking the chosen row.

### 1.5 ③ Titles list

Behaviourally identical to today. Visually: rows go from ~52 px to ~36 px (single line,
ellipsis with full text on hover-title), the variant badge keeps its position so nothing shifts
between chosen and unchosen, and the row actions (`✎`, `📋`) fade in on hover instead of
sitting permanently at full opacity — 20 always-lit glyphs is what makes the current list feel
noisy.

Keyboard, all additive (no existing pointer behaviour changes):

| Key | Action |
|---|---|
| `↑` `↓` | move row focus |
| `Space` / `Enter` | toggle focused title into/out of the A/B slate |
| `e` | edit focused title inline (same editor, same Enter/Esc) |
| `c` | copy focused title |
| `1`…`9`, `0` | toggle the *n*th title directly |
| `⌘F` | focus the report search box in the left column |

### 1.6 ④ Description, ⑤ Tags

The description keeps its exact semantics — it is whatever `publish-get-resolved` composed in
the main process, never recomposed in the renderer, never rendered as an empty box while
resolving. What changes: the `min-height: 300px` becomes a **capped ~14-line viewport with its
own scrollbar**, and the char count becomes `2,143 / 5,000` against YouTube's real description
limit. Edit / Revert / Copy and the `edited` badge stay exactly where they are.

Tags stay chips (they are click-to-copy individually, which is worth keeping) but wrap in a
2-row viewport that expands on click when there are many.

### 1.7 Left column — the report list

The list gets three things it does not have:

1. **Search** over title + source filename, `⌘F`. With 111 rows this is the fix that matters
   most.
2. **Filter chips**: channel (Telltale / Fireside / Unfiltered / Podcast / unrouted), and state
   (`scheduled`, `unscheduled`, `A/B picked`, `no titles`). The 11 zero-title reports become
   filterable instead of being landmines.
3. **State dots on each row** — the same five facts as the readiness strip, as ≤5 dots. A row
   reads: title, source basename, date, prompt-set badge, dots.

**Re-runs collapse.** Rows sharing a `job_name` collapse under the newest, with a `3 runs ▾`
affordance that expands them in place. 111 rows become 94, and — more usefully — the six stale
`2 - starburst.mov` runs stop competing with the good one. Delete, multi-select and Export TXT
operate on whatever is visible, unchanged.

Rows go from a 3-line card to a 2-line dense row; 280 px wide instead of 350 px, and the split
is draggable (persisted in localStorage, like other panes in this app).

### 1.8 Visual language — converge on the analytics page, don't invent one

The reports page uses full-bleed `--gradient-primary` panel headers with forced-white text
(`metadata-reports.scss:49-95`). The analytics page — the newest surface in the app — uses a
flat header with a bottom border and `.card` blocks whose titles carry a single orange
`mat-icon` (`analytics.scss:20-77`). The second convention is better here: it costs ~60 px less
per section, it survives dark mode without `!important` overrides, and it lets orange mean
"this is interactive/accent" instead of "this is a header".

So: **no new tokens.** The redesign uses `--bg-card`, `--bg-secondary`, `--bg-tertiary`,
`--border-color`, `--text-primary/secondary/muted`, `--primary-orange`, and the existing
`--success/warning/danger/info-*` pairs, in both themes. The only additions are the three
channel hues in §2.3, which are genuinely new data-encoding colours and are declared as such.

### 1.9 Behaviours preserved unchanged — explicit list

Nothing in this redesign alters any of the following. If an implementation PR changes one of
these, it has gone wrong:

**A/B titles**
- Click order is variant order; variant 1 is the main title and YouTube's inconclusive-test
  fallback.
- Cap of 3 (`MAX_AB_VARIANTS`); a 4th click is blocked with the "Deselect one first" tooltip,
  not silently ignored.
- Inline edit stores an A/B *variant*; the generated report file is never rewritten. Enter
  saves, Escape cancels, and the ✓/✕ pair occupies the same cells as ✎/📋 so nothing shifts
  under the cursor.
- A rejected edit leaves the banner up and the editor open with the typed text intact.
- `Clear` wipes the slate.

**Description / tags**
- The displayed description is the main process's composition (`publish-get-resolved`) — the
  renderer never composes a second copy.
- Override + `edited` badge + `Revert`; the generated value is kept and restorable.
- Tags are stored comma-separated, exactly as the extension types them into Studio.
- While unresolved, the "Reading the composed description…" state renders — never an empty box.

**Publish panel**
- A suggested channel is pre-selected but **not stored**; it is committed with the next save,
  or immediately if the operator picks it.
- `unknownStoredChannel` warning text and behaviour.
- Schedule stores an instant with an explicit offset; the offset in effect on that date is
  *shown* next to the boxes, never assumed. Past-time warning and the offsets-disagree note
  both stay, verbatim.
- The thumbnail proposal is **never** pre-applied — Confirm is required, and Confirm waits for
  the preview image. Warnings render beside it.
- The preview is decoded and downscaled in the main process; the renderer never reads the file
  and `webSecurity` stays on.
- `isPodcast` is a strict boolean, never absent.

**Page-level**
- One error banner for every publish action, carrying the main process's refusal text verbatim,
  click to dismiss.
- `chaptersSkipped` renders in the Chapters slot with its recorded reason and failed/skipped
  distinction.
- Multi-select + Export TXT, Show in Folder, per-row delete, refresh.
- Click-to-copy with ✓ feedback on every list item, tag, chapter, thumbnail-text line, pinned
  comment and clip suggestion.
- **No fallbacks.** Phase 0b removes `loadReportsLegacy` and the `job_id || filename` fallback;
  the redesign does not reintroduce a "best effort" path anywhere. A report that cannot be read
  is reported, not approximated.

---

## 2. The publish calendar

### 2.1 What it is for

One question, asked constantly, currently unanswerable: **"what is going out, on which channel,
when — and what have I not scheduled?"** Three channels plus a podcast, all scheduled by hand,
one video at a time, from inside a per-item panel that shows only that item.

### 2.2 Placement and navigation

Its own route, `/publish-calendar`, with a sidenav entry **Calendar** (`event` icon) directly
under *Metadata Reports*. It is a different *scope* — all items, all channels, over time — not
a tab of a single-item view; putting it inside the reports page would mean one of the two views
is always fighting for the same 1,600 px.

They are round-trippable:
- Reports header gets a `Calendar ▸` button.
- Calendar header gets a `Reports ▸` button.
- **Click-through**: clicking a calendar chip navigates to
  `/metadata-reports?item=<itemId>`, which selects that report on load. Deep-linking by
  `itemId` is a few lines (`ActivatedRoute` query param → `selectReport`) and it is what makes
  the calendar a navigation surface rather than a poster.

### 2.3 Channel colour

Three hues, chosen to be distinguishable from each other and from the app's orange chrome, and
to survive both themes and the common colour-vision deficiencies (orange / teal / violet is a
safe triad — no red-green pair):

| Channel | Hue | Token |
|---|---|---|
| Owen Morgan (Telltale) | `#ff6b35` brand orange | `--ch-telltale` |
| Owen's Fireside Chat | `#2dd4bf` teal | `--ch-fireside` |
| Owen Unfiltered | `#a78bfa` violet | `--ch-unfiltered` |
| **Not routed** (`channelId: null`) | `#6b7280` grey, dashed border | `--ch-none` |
| Podcast (Spreaker) | no hue — a 🎙 glyph on the chip | — |

Telltale takes the brand orange because it *is* the flagship channel and the brand colour is
literally Owen Morgan's. Chips carry a 3 px colour bar plus the channel initial (`T` / `F` /
`U`), so colour is never the only encoding.

Podcast is deliberately **not a fourth colour**: `isPodcast` is orthogonal to channel routing
(settled in the plan, decision 5 — one account, one show, pulls from all channels), so it is a
glyph that can appear on any chip. The six live `podcast-spreaker` reports have a prompt set
that maps to no channel, so they land in the grey unrouted state *with* the podcast glyph —
which is exactly right and immediately legible.

### 2.4 Views — Month and Agenda. No week view.

**Month grid is primary.** At Owen's cadence — call it 1–2 uploads a day across three channels
— a month cell holds one or two chips and the whole month reads at once. A week view would show
the same information at 4× the size and require four times the navigation to see a month; it
earns nothing. Explicitly cut.

**Agenda is the second view**, and it is the one a keyboard user will live in: a dense
chronological table — date, time, channel, title, state, A/B count, thumbnail ✓ — sortable and
filterable, `↑`/`↓` to move, `Enter` to open the report. It is the same joined data with a
different renderer, so it is nearly free, and it answers "the next ten things" better than any
grid.

Month | Agenda toggle in the header, alongside `◂ August 2026 ▸` and `Today`.

**Left rail: the unscheduled tray.** Every publish record with `publishAt === null`, newest
first, showing chosen-title-or-source, channel chip, and A/B count. This is the calendar's real
work surface — the grid tells you what is handled, the tray tells you what is not. It carries a
count in its header (`Unscheduled · 7`) which doubles as the page's one number worth watching.

### 2.5 Chip states — the part the plan specifically demands

`status.publishAt` is settable **only while a video is private and never-published**. The
calendar must therefore distinguish re-schedulable rows from finished ones, and must not offer
scheduling on the latter.

| State | Derived from | Rendering | Schedulable? |
|---|---|---|---|
| **Scheduled** | `publishAt` set, `status ∈ {selecting, ready, linked, filled}`, `publishAt` in the future | solid channel bar, time, title | yes — Move… offered |
| **Published** | `status === 'published'` (or `videoId` set and `publishAt` past) | dimmed, ✓, lock glyph, no Move… | **no** — controls absent, not disabled-and-lying |
| **Stale schedule** | `publishAt` in the past, `status !== 'published'` | amber outline, `⚠ was due 2 days ago · set 6 days ago` | yes |
| **Not routed** | `channelId === null` | grey dashed chip, `no channel` | yes, but Push is blocked with that reason |
| **A/B pending** | 3 variants chosen, not yet live | small hollow `A/B` badge on the chip | — |

`publishAtSetAt` is what makes the stale state honest: it can say *when the intent was recorded*
as well as when it lapsed, which is the difference between "I forgot" and "this drifted".

The **A/B-pending** badge is a designed slot with an open dependency: the operator is checking
whether Studio renders the A/B control on a scheduled-private video. If it does not, that badge
becomes a real warning ("A/B cannot be created until this publishes") and the agenda gets a
filter for it. Until that answer arrives it is a neutral marker. Flagged rather than guessed.

### 2.6 Scheduling gesture (v1) — select, then click a day

The Phase 4 requirement is literally "scheduling a video on a date sets its `publishAt`". v1:

1. Click an item in the unscheduled tray (or an existing chip) — it becomes *armed*, and the
   grid dims non-legal targets.
2. Click a day cell.
3. A small inline confirm appears on that cell with a **time field, pre-filled and visible**,
   and the offset in effect on that date printed beside it — the same contract as the report
   panel. Enter confirms; Esc cancels.
4. Confirm calls the existing `setPublishAtLocal(date, time)`. All existing validation (≥15 min
   in the future, ≤2 years out, explicit offset) applies unchanged, and a refusal lands in the
   page banner verbatim.

The pre-filled time is **the last time used on that channel**, labelled as such
("last used on Telltale"), or empty if there is none. It is never applied without the operator
seeing it — a silently-defaulted publish time is exactly the class of unexpected production
path the no-fallbacks rule exists to prevent.

**Drag-to-reschedule is v2, and I do not think it is cheap here.** The honest cost is not the
drag: it is that a drop carries only a date, while `publishAt` is an instant with a time and an
explicit offset, so a drop must either silently preserve the old wall-clock time (defensible,
but silent) or open the same time popover the click gesture already opens — at which point the
drag bought one gesture. On top of that, drop legality has to be computed live per cell
(published rows refuse; past days refuse), which is the same validation surface twice. Two
clicks with a visible time beats one drag with an invisible one, for this operator. Revisit
once the click gesture has real mileage.

### 2.7 Data — one main-process index, one IPC call

The calendar needs a join that does not exist: publish records (`userData/publish/selections/…`)
carry `channelId`, `publishAt`, `publishAtSetAt`, `status`, `videoId`, `isPodcast`,
`thumbnailPath`, `chosenTitles` — but for an item the operator has not picked titles for, the
display title lives in the job JSON on the output volume, and `sourceFilename` is null on all
44 live records.

So: **a report index in the main process**, mtime-keyed, built once and invalidated per file.
One IPC (`publish-list-calendar`) returns the joined rows:

```
{ itemId, jobId, promptSet, displayTitle, sourceFilename,
  channelId, publishAt, publishAtSetAt, status, videoId,
  isPodcast, hasThumbnail, abCount }
```

The same index backs the reports list (`metadata-list-reports`), which retires the renderer's
111-file scan on every mount — the fix `PUBLISH-PIPELINE-PLAN.md` asks for under Phase 4.
Note that `listActionable()` (`publish-store.service.ts:204`) filters to `ready|linked|filled`
and is therefore *not* the right source: the calendar must show `selecting` rows too, because
that is the unscheduled tray.

Existing store semantics are untouched: `listItemIds` still refuses to silently drop an
unreadable record, and an unreadable selection surfaces as a fault on the calendar (a visible
"1 record could not be read" line), never as a missing row.

---

## 3. Implementation sketch — PR-sized chunks

Ordered so that each lands independently and nothing is half-migrated. Phase 4 assumes Phase 0b's
stable `itemId` is in place; every join below is keyed by `itemId` and never by position.

**PR 4.1 — Report index in the main process. No visual change.**
New `electron/services/metadata/report-index.ts` (scan + mtime cache + per-item projection);
new IPC `metadata-list-reports` and `publish-list-calendar` in
`electron/services/publish/publish-ipc.ts`; `frontend/src/app/components/metadata-reports/metadata-reports.ts`
`loadReports()` replaced by one call. *Acceptance:* the rendered list is byte-identical to
today's for all 111 reports; a second mount issues no file reads; touching one job file
invalidates only that entry. Ships alone so a regression here is unambiguous.

**PR 4.2 — Report page shell.** Three-column grid, readiness strip, section chrome converged on
the analytics `.card` convention, independent scroll panes, resizable + persisted left split.
`metadata-reports.html` / `.scss` only; every handler, signal and `PublishState` call site
untouched. *Acceptance:* the §1.9 preserved-behaviour list passes by inspection, and a
30-chapter report and a 5-chapter report produce the same page height.

**PR 4.3 — Titles slate, density, keyboard.** A/B slate strip; 36 px rows; hover-revealed row
actions; capped description viewport with `n / 5,000`; tags 2-row viewport. Keyboard map from
§1.5 added as a directive; all of it additive. *Acceptance:* every existing pointer interaction
still works with the keyboard layer disabled.

**PR 4.4 — Publish rail + assets accordion.** The existing publish panel relocated into the
sticky rail, collapsing to a summary line when complete; Thumbnail Text / Chapters / Pinned
Comment / Clip Suggestions become accordions with counts; `chaptersSkipped` occupies the
Chapters slot, expanded and non-collapsible. Markup move plus the readiness-strip wiring — no
new IPC.

**PR 4.5 — Calendar, read-only.** New `frontend/src/app/components/publish-calendar/`
(`.ts/.html/.scss`), route in `app.routes.ts`, sidenav entry in `app.html`. Month grid + agenda
toggle + unscheduled tray + chip states from §2.5, all fed by `publish-list-calendar`. Nothing
writes. *Acceptance:* every publish record appears exactly once across grid + tray; the 44
null-channel records render as unrouted rather than vanishing; the six podcast-set reports carry
the glyph.

**PR 4.6 — Scheduling gestures.** Arm-then-click-a-day with the visible pre-filled time; Move…
on an existing chip; legality gating (published rows offer no control at all); refusals shown
verbatim in the page banner. Reuses `setPublishAtLocal` / `clearPublishAt` — no new validation
anywhere. *Acceptance:* a published row exposes no scheduling affordance; a rejected time leaves
the popover open with the typed value.

**PR 4.7 — Deep links.** `/metadata-reports?item=<itemId>` selects on load; cross-buttons in
both headers; browser-history back returns to the calendar with its month intact.

**PR 4.8 (conditional) — A/B-pending state.** Only once the operator's Studio check lands. If
A/B is unavailable on scheduled-private videos, the badge becomes a warning state plus an agenda
filter; if it is available, the badge stays informational and this PR is one line.

Cut from Phase 4 on purpose, listed so they are not re-derived later: drag-to-reschedule (§2.6),
week view (§2.4), bulk reschedule, iCal export, per-day capacity targets, analytics overlaid on
the calendar (best-time-to-publish belongs to the analytics loop, not here).

---

## 4. The mockups

`report-mockup.html` — the redesigned report page, dark theme, populated from the real
`1 - kent christmas` report (10 titles, its real description, 13 tags, 10 thumbnail-text lines,
3 pinned comments, 5 clip suggestions) with three A/B titles picked, a Telltale routing, a
schedule, and a pending thumbnail proposal. The left list is the real recent-reports list
including a collapsed re-run group and a failed run.

`calendar-mockup.html` — August 2026, month view, plausible schedule across the three channels
including one day with two videos, a published (locked) row, a stale schedule, an unrouted
podcast episode, and a 7-item unscheduled tray.

Both are static: inline CSS, no scripts that matter, no external resources. They are for
eyeballing, not for lifting into the app.
