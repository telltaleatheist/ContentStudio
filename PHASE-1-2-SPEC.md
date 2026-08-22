# Phase 1 (publish data model) + Phase 2 (transcript reuse) — Design

Read-only investigation, 2026-08-21, by an Opus design agent. Built on PR B's world
(selections at `userData/publish/selections/items/<itemId>.json`, ChosenMetadata keyed by
itemId). Status: PROPOSED — PR 1 is uncontroversial and started; the rest awaits Owen's
read, especially Q1.

## 1. Current state (verified with file:line refs)

- An editor "project" is a FOLDER identified by scan, not an id. Registry
  config/projects.json; `projects:scan-folder` (editor-ipc.ts:1664-1747) derives the
  session name from `<session> master.<ext>`; looks for `<clean>_compounds.zip`,
  `_edits.json`, `_transcript.json`.
- Transcript artifacts: session sidecar `<session>_transcript.json` (word-level, timeline
  coords, written by editor-backend/cli/transcribe.py:809-825); edit state
  `<session>_edits.json` (stories with titles/regions); and the Phase-2 artifact —
  per-story CS import transcripts `<session>_stories_transcripts/<NN>-<slug>.json`
  written by editor-backend/cli/editor_export.py:1707-1770 (`export_transcripts`),
  contract documented in electron/services/metadata/TRANSCRIPT-IMPORT-FORMAT.md, rebased
  by the same collapse ripple the story FCPXML uses — exactly "the ad-free editor
  timeline for one story".
- GATING FACT: the export modal is either/or ('fcpxml' | 'transcripts',
  export-modals.component.ts:40) and Owen exports fcpxml — only ONE week in eight on disk
  has a `_stories_transcripts/` folder. Phase 2 has no fuel without PR 1 below.
- Generation flow: inputs.ts → job-queue (jobId minted renderer-side :78) →
  generate-metadata → runTranscription → InputHandlerService.processVideo →
  WhisperService.transcribeVideo → ContentItem {content, srtSegments, source}.
  IN THE GENERATOR THE TWO CONSUMERS ARE ALREADY SEPARATE: content fields read
  item.content (summarizeTranscript at :297/:325/:393/:472); chapters read ONLY
  item.srtSegments (resolveChapters/generateChapters). That seam is the whole split.
- `parseTranscriptImport` + `buildImportedContentItem` (input-handler.service.ts:311-341)
  already turn a story-transcript file into content+srtSegments without Whisper.
- Publish seam post-PR-B: publish-types/store/ipc; `publish-set-fields` currently copies a
  whitelist of keys with NO per-field validation (publish-ipc.ts:104-140).
- channelId is dead today (all 44 live selections have null) but the mapping exists:
  userData/analytics/channels.json maps each channel to its prompt set(s); read via
  analyticsStore.listChannels(); already used this way at insights-prompt.ts:115.
- Thumbnails: NO image handling exists anywhere in app or extension ("thumbnail" hits are
  the prompt-set thumbnail-TEXT field). thumbnailPath is greenfield.
- Disk layout: /Volumes/Callisto/Movies/FCPX/<weekMonday>/ with files/<sessionDate>/
  (editor project), complete/<slot> - <label>.mov (final exports, week-scoped; slot =
  optional channel letter + number: none=Telltale, u=Unfiltered, f=Fireside),
  thumbnails/<slot> - youtube-thumbnail.png.

## 2. Phase 1 spec — publish data model

Fields on ChosenMetadata (same record, per ITEM-ID-PLAN §3.4): channelId (seeded from the
job's prompt_set via channels.json, operator-overridable, must be a known id, override is
sticky); publishAt (ISO-8601 WITH explicit offset, ≥15 min future, ≤2 years out, null
clears) + publishAtSetAt provenance; thumbnailPath (absolute, exists, PNG/JPEG by
extension AND magic bytes, ≤2 MiB — YouTube's hard limit; ≥1280x720 hard, non-16:9 warn
and store; RE-VERIFIED at use time — Callisto is external) + thumbnailMeta {bytes, width,
height, mime}; isPodcast (strict boolean, default false, NEVER absent — the
_is_compilation lesson); transcriptRef (Phase 2, below).

Channel derivation: new pure electron/services/publish/channel-routing.ts
resolveChannelForPromptSet — one match → channel; zero → null + reason naming the prompt
set (NOT default-to-Telltale); two+ → throw (config error).

UI: one Publish panel in the reports detail pane above Titles (channel picker + "from
prompt set X", schedule with zone, thumbnail preview + Change/Clear with proposal, podcast
checkbox). Thumbnail proposal from the .mov's slot:
<week>/thumbnails/<slot> - youtube-thumbnail.png IF it exists — always preview + Confirm,
never pre-applied (slot numbers drift, see Q5). Image preview via main-process
publish-read-thumbnail returning a downscaled dataUrl (do NOT relax webSecurity).

IPC: extend publish-set-fields with a PER-FIELD VALIDATOR TABLE replacing the blanket
key-copy (Q7 — non-negotiable, same PR); new publish-set-thumbnail /
publish-propose-thumbnail / publish-read-thumbnail / publish-resolve-channel.

publishAt's YouTube constraint (settable only while private + never-published) is
deliberately NOT enforced in Phase 1 — that's a Phase-3/4 gate at the API call; Phase 1
stores intent and records publishAtSetAt so the calendar can explain stale schedules.

## 3. Phase 2 spec — transcript reuse (two-source)

### 3.0 THE FINDING THAT RESHAPES THE PREMISE
Measured on the ONE week with both artifacts (all six stories, transcript durationSeconds
vs ffprobe of the matching .mov): drift = −36.9s, −35.0s, +42.5s, −125.2s (−21.3%),
−10.3s, −220.3s (−23.4%). Consequences: (1) chapters from the editor transcript are
impossible — the two-source design is the only correct one, confirmed; (2) drift is NOT
"~57s of ad inserts" — it is dominated by FCPX TRIMMING, up to 23% of a story. Content
fields generated from the editor transcript will sometimes describe material Owen
deliberately cut. Design response: surface the drift number at link time and on the
report; warn past ±10%; never auto-refuse (the operator knows what he cut). See Q1.

### transcriptRef
{kind:'acs-story', path, sourceSession, projectFolder, storyNumber, storySlug, storyTitle,
durationSeconds, wordCount, linkedAt, via:'exact-title'|'label-match'|'manual'} — identity
alongside the path so a broken link can say what it lost. Resolution is three-state:
ok / missing / changed (file exists but sourceSession/storySlug/wordCount disagree —
session re-exported → BLOCKS the run and asks re-confirm; silent reuse prohibited).

### Link UX — hint then confirm, at the Inputs page (before generation, required decision)
Candidates come purely from the .mov's own path: every story in every
<week>/files/*/<session>_edits.json. MEASURED on all 40 live final exports:
17 exact-title matches (43%), 13 label matches after stripping the slot prefix (33%,
Owen renumbers slots per-channel), 1 ambiguous, 10 none (renames, one-story-becomes-two-
videos splits, podcast compilations). 76% hint rate ⇒ auto-linking would be wrong ~1 in 4
⇒ operator confirmation required, never silent. Per-item row next to the chapters toggle:
radio [Link "<story>" (session, match kind) + drift line] / [Pick a different story…
(week → all projects → file browser, one dialog, progressive scope)] / [Final export only].
When candidates exist the choice is REQUIRED (Start Queue refuses naming the item); when
none exist the row self-resolves showing the searched path. Drift >±10% flips to warning
style ("Link anyway (14% shorter)"). New module
electron/services/metadata/editor-transcript-link.ts (metadata/, not publish/):
findCandidates / probeDrift / resolveRef + three IPC channels.

### Missing fuel — two fixes, both recommended
(a) PR 1: export_stories (editor_export.py:1690-1706) ALSO emits transcripts when the
sidecar exists (export_transcripts already exists — it's a call, not new math); modal copy
becomes "FCPXML + transcripts". (b) The picker offers "Export it now" for a candidate
story with no exported transcript (one editor:export with output:'transcripts').

### Generation-time split
ContentItem gains contentSource? {text, origin:'editor-story-transcript', ref, driftSec,
driftPct}. One resolver contentTextOf(item) in the generator; the four
summarizeTranscript call sites switch to it; resolveChapters/generateChapters UNTOUCHED
(they already read only srtSegments = final export's Whisper). Threading mirrors
chapterFlags exactly: inputs.ts → generate-metadata {inputTranscripts: {[path]:
TranscriptRef|null}} → runTranscription → processVideo(…, ref?) → Whisper as today + if
ref: resolveRef → parseTranscriptImport → contentSource.text. Compilation mode: per-input
refs allowed, no special case.

### No-link = a DECLARED MODE, not a fallback
Behavior identical to today (everything from final export's Whisper — never wrong, only
ad-polluted). Not a fallback because: (1) when candidates exist the path is CHOSEN, not
defaulted into; (2) the choice is recorded in the report on BOTH branches; (3) the
consequence is stated where output is read ("Content fields generated from the final
export's transcript — includes any sponsor reads"); (4) a declared link whose file is
missing/changed FAILS the run — it never quietly runs final-only.

### Report records (content_provenance, written in writeItemToJob, ALWAYS present)
{content_fields: 'editor-story-transcript'|'final-export-whisper', timed_fields:
'final-export-whisper', transcript_ref|null, final_duration_sec, transcript_duration_sec,
drift_sec, drift_pct, declared_at} + ItemProvenance shape-guard like ItemSource.
Report ref = immutable fact of the run; ChosenMetadata.transcriptRef = operator's durable
choice, seeded from provenance, carried forward on regeneration via the source_key prompt.

## 4. Open questions for Owen (each with recommendation)
- Q1 (highest): drift is trimming-dominated, up to −23%. Keep two-source, surface drift,
  warn >±10%, never auto-refuse; revisit after ~10 linked videos. QUESTION: in the −21%
  and −23% cases, was the cut material off-topic (fine) or on-topic (a problem)?
- Q2: one story → two videos (live examples). Allow many-to-one refs; picker says "already
  linked to 1 other item". No time-window refinement now.
- Q3: story transcripts exist for 1 week in 8 → PR 1 first, before any CS-side work.
- Q4: publishAt's YouTube constraints enforced at Phase 3/4, not Phase 1.
- Q5: thumbnail slot renumbering (13/40) → always preview+confirm, never pre-apply.
- Q6: 44 null channelIds → seed lazily on next open from prompt_set; no guessing
  migration; unmapped prompt sets stay null with a reason.
- Q7: publish-set-fields per-field validator table in the same PR as the new fields.
- Q8: podcast compilations have no story and never will → final-only is correct and
  permanent; no special case.

## 5. Implementation order
PR 1 editor emits story transcripts with fcpxml (unblocker, smallest) →
PR 2 Phase-1 fields + validation + IPC (no UI) →
PR 3 Phase-1 UI (Publish panel) →
PR 4 Phase-2 link plumbing (stored + shown, nothing consumes it; acceptance: candidate
finder over all 40 live .movs must return exactly 17/13/1/10 — returning something for
all 40 is the failure this test catches) →
PR 5 generation split + provenance (acceptance: linked vs unlinked runs of the same video
must have byte-identical chapters while titles/description differ — if chapters move, the
split leaked) →
PR 6 carry-forward on regenerate (transcriptRef + channelId + thumbnailPath + isPodcast;
NOT publishAt — a schedule is about one upload). May fold into ITEM-ID-PLAN PR C.
