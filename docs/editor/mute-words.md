# Mute words (LEDGER #226)

Owen, 2026-09-26: "find every use of the word 'fuck' and mute it by using the tool i applied in
this file … i use the R tool to highlight the section and hit V. i want to do it on the master
timeline, not inside the compound clips." Then: "maybe it should be a modal. 'mute words'. and
i can pick words to mute, including harsher words … and/or optionally mute all bad words in the
first 3 minutes of the video but leave some of the others."

## What Owen sees

- **Processing modal** (click a new project): a **Mute words** row with a one-line summary
  ("F-word everywhere; all swearing in the first 3:00") and a **Mute words…** button. If the
  project has no saved choice, the line shows the choice saved last time; pressing **Process**
  keeps that choice for this project.
- **Right-click a project ▸ Mute words…**: the same modal. **Save** keeps the choice for the
  project. **Save and apply to the exported timeline** re-mutes the master timeline the project
  already exported (it needs a transcript and an existing export; otherwise the modal says which
  one is missing).
- **The modal**: one row per word group (F-word, Harsh words, General swearing) plus **Your
  words** (typed, commas between them, `*` at either end is a wildcard). Each row is **Off /
  Everywhere / First m:ss only**, and **Show words** lists exactly what the group covers. Below:
  **Mute all swearing in the first [3] minutes**.
- **File ▸ Export…**: the chooser says what Mute words will do for this project. The result
  says how many words were found, how many were muted, how many mutes were written on how many
  clips, and lists every word that was not muted with its time and why.

## The rules

- The groups live in ONE data file, `editor-backend/core/mute_words.json`. The modal shows that
  file (through the main process) and the Python pass matches with it.
- A word is in a group when it contains one of the group's `contains` stems, or equals one of its
  `exact` words (or one of its hyphen parts: "dumb-ass"). Punctuation and case are ignored.
- The **opening window** is measured on the exported master timeline, what viewers hear from
  0:00, after cuts. In a story export every story counts from its own start. Inside the window,
  a word is muted if its group is Everywhere or First-only, or if "all swearing" is ticked (then
  every group and Your words, including groups set to Off). After the window, only Everywhere.
- **Padding**: `MUTE_PAD_SECONDS = 0.05` (50 ms) each side of the aligned word, in
  `core/word_mutes.py`. **Owen's number to tune.** Mutes that touch or overlap merge into one.
  Each mute is clamped to its clip's own source range.

## Where the mutes land

The master timeline is `<session> master.fcpxml` in the zip, built by
`core/compound_generators/master_project_generator.py:792-853`. Its audio is on two connected
`<ref-clip>`s per spine clip: lane -1, the CAM compound (every mic), `:805`; and lane -2, the SSB
compound (screen and game audio), `:817`. The mutes go on those ref-clips, never inside a
compound `<media>`. A mic word goes on lane -1 and a screen-audio word on lane -2.

Owen's sample is a `<clip>`, so FCP wrote `<audio-channel-source srcCh="1, 2"
role="dialogue.dialogue-1"><mute start="15918331/720000s" duration="436401/720000s"/>`, after the
clip's media children, in the clip's source time. A `<ref-clip>` has no audio-channel-source.
The FCPXML 1.14 DTD gives it `audio-role-source` for the same job: after anchored clips and
markers, before filters. So on the master timeline the pass writes:

    <ref-clip ref="r2" lane="-1" srcEnable="audio" …>
        <audio-role-source role="dialogue.dialogue-1">
            <mute start="N/720000s" duration="M/720000s"/>
        </audio-role-source>
    </ref-clip>

The times are in the ref-clip's source time, which is the compound's own timeline (the domain of
its `start`). The pass writes FCP's unreduced `/720000s` numbers. A `<clip>` in the sample's shape
gets the sample's exact form; the offline check rebuilds Owen's mute from a word.

## Order of operations (the choice, and why)

The mutes are written **when the master timeline is exported**, as the last edit to the tree:
after cuts, stories, reorder and the mic-mute split, just before the file is saved. Nothing is
written at processing time.

- The word times do not exist when processing writes the zip. The transcript comes after.
- Only the finished timeline knows two things: which clip pieces survive, and where a word sits
  from 0:00 (the opening window).
- The zip is never touched, same rule as every other export.
- "Save and apply" runs the same pass on an export already on disk (`cli/mute_words.py`). It
  first removes the earlier mutes. The pipeline writes no other `<mute>`, so running Apply again
  gives the same file.

How a word gets placed (`cli/word_mute_pass.py`), never by a linear offset:

1. The word's span in its source file (`fileStart`/`fileEnd` from the Qwen3 aligner) grows by
   the padding.
2. File time maps to the master timeline through that file's segment table. That table is
   `ManifestBuilder.leaves`, every auto-editor segment kept. A word that spans an auto-editor cut
   lands on both sides. A word auto-editor removed maps to nothing and is reported.
3. Timeline time maps to each carrying clip's source time through the pristine master spine.
   The carrying clip is found by the media file it can be heard playing, the same way the
   mic-mute pass finds it.
4. On the exported tree, each clip gets the part of the target inside its own source range. A
   word in a section Owen cut lands nowhere and is listed as cut. A word inside a stretch the
   mic-mute pass already switched off is listed as such.

## Refusals (loud, by name)

- **The project has Mute words on but no transcript.** The export refuses and says to transcribe
  or turn Mute words off.
- **Apply is asked for with no exported timeline yet.** Apply refuses and says to export.
- **The export is older than the zip.** Apply refuses and says to export again.
- **A saved choice is broken.** It is refused by name and never replaced by the default.
- **Mute words is off or nothing is picked.** The export says so in its result.

## Files

`editor-backend/core/mute_words.json` (the word lists), `core/word_mutes.py` (matching, rule,
numbers), `cli/word_mute_pass.py` (placement), `cli/mute_words.py` (Apply),
`cli/editor_export.py` (calls the pass on both FCPXML exports; `STORIES_EVENT_SUFFIX`),
`electron/services/editor/mute-words.ts` (word list and saved choice), `editor-ipc.ts`
(`editor:mute-words-*`), `python-service.ts` (`muteWordsApply`, `wordMutes` passed through),
`preload.ts`, the frontend host/adapter/service, `mute-words-modal/`,
`project-setup-modal`, `project-sidebar`, `export-modals`, `editor.component`.
Per project: `<cleanName>_mute-words.json` in the project folder. Remembered default:
`<userData>/config/mute-words-default.json`.

Checked by `npm run check:mutes` (`tools/word-mute-checks.js` + `tools/word-mute-driver.py`,
50 checks, synthetic data, run on the editor's own Python). Nothing was run live.

## HANDOFF

Open for Owen:

1. **Does FCP accept `audio-role-source` + `mute` on a compound ref-clip, and does it read like
   R+V?** The DTD allows it, but Owen's sample was a plain clip. One real export imported into a
   scratch library settles it. If FCP wants something else (for example the ref-clip's own
   role-source with a different role name), only `write_mutes` / `_container` change.
2. **The lane -1 mute takes out everything in that clip for the moment of the word.** That is
   every mic and the sound-effects lane, since the CAM compound mixes them under one role. A
   guest's word mutes the host too for ~0.6 s. Per-mic muting would have to happen inside the
   compound, which Owen ruled out.
3. **Padding is 50 ms each side.** It is Owen's to tune (`MUTE_PAD_SECONDS`).
4. **Word lists.** The Harsh words and General swearing lists are a first pass. Edit
   `mute_words.json`. It is plain data, and the modal shows every word in it.
5. **Importing the zip's own `master.fcpxml`** (without exporting) gets no mutes. The mutes only
   go into exported timelines. If Owen imports the zip directly, that path needs a decision.
6. **um/uh**: not built. The seam is a separate word set in `mute_words.json` (for example
   `"fillerWords"`) matched by the same `word_matches`. Removal is a cut, not a mute, so it is a
   different pass.
7. **A word heard on two tracks is counted twice.** For example, mic bleed transcribed on the
   screen track. The mutes still merge.
