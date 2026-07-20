# Transcript Import Format (AutoCutStudio → ContentStudio)

The contract for the per-story transcript JSON that AutoCutStudio exports and
ContentStudio imports (Inputs page → **Import Transcript**). One file per story.
Importing creates a project named `story.title`, populates the transcript, and
runs metadata generation **without invoking Whisper**.

Parser/converter: `transcript-import.service.ts`. The parser is deliberately
tolerant — only `words` (with text) is strictly required; everything else has a
fallback. It also accepts AutoCutStudio's native `<session>_transcript.json`
sidecar field names as aliases, so you can emit close to what you already have.

## Canonical shape

```jsonc
{
  "formatVersion": 1,               // int; provenance only. (alias: schemaVersion)
  "producer": "AutoCutStudio",      // provenance only
  "sourceSession": "2026-07-15",    // session this story was sliced from. (alias: session)
                                    //   REQUIRED for the future round-trip (split points → ACS)

  "story": {
    "number": 2,                    // ordering / filename
    "title": "Jack Posobiec",       // → project name  (fallback: derived from filename)
    "slug": "jack-posobiec",        // filename / round-trip key
    "startSeconds": 5400.0          // OPTIONAL: story's offset on the session-global
                                    //   timeline. Only needed if timebase="session"
                                    //   or you want split points mapped back to session time.
  },

  "language": "en",                 // OPTIONAL, default "en"
  "durationSeconds": 3600.0,        // OPTIONAL, default = last word end
  "timebase": "story",              // "story" (default, 0-based) | "session" (global, rebased on import)

  "speakers": [                     // OPTIONAL; derived from words[].speaker if omitted. (alias: tracks)
    { "id": "mic",    "label": "Mic" },
    { "id": "screen", "label": "Screen audio" }
  ],

  "words": [                        // REQUIRED, non-empty
    { "speaker": "mic", "text": "hello", "start": 0.0, "end": 0.32, "confidence": 0.94 }
    // speaker → references speakers[].id   (alias: track)
    // start/end → seconds, story-local 0-based unless timebase="session"  (aliases: timelineStart/timelineEnd, then fileStart/fileEnd)
    // confidence → OPTIONAL 0..1  (alias: prob)
  ],

  "splitSuggestions": []            // OPTIONAL; normally absent on import. See round-trip below.
}
```

## What ContentStudio does with each field

| Field | Use in CS |
|---|---|
| `story.title` | Project/job name and output `.txt` filename (via a `title` on the ContentItem). |
| `words[]` | Grouped into `SRTSegment`s (sentence / speaker-change / pause / size caps) → drives summarization, metadata, and chapters. |
| `words[].speaker` + `speakers[]` | Attribution preserved on every segment (`SRTSegment.speaker`/`speakerLabel`) and shown to the AI as screenplay-style labels at speaker changes (`Mic: … / Screen audio: …`). Single-speaker files get plain text, no labels. |
| `start`/`end` | Converted to SRT `HH:MM:SS,mmm`; power chapter timestamps. |
| `sourceSession`, `story.number/slug`, `startSeconds` | Carried on the project (`ContentItem.importMeta`) for the future split-point round-trip; not used by metadata today. |
| `confidence`, `language`, `durationSeconds`, `formatVersion`, `producer` | Carried as provenance; not required by metadata. |

## Notes / gaps to design around

- **Word times are story-local 0-based** by default. AutoCutStudio's sidecar
  words are session-global — set `timebase: "session"` (and ideally
  `story.startSeconds`) and CS rebases to 0 on import, or subtract the offset in
  the exporter and keep `timebase: "story"`.
- **Speaker ids**: prefer stable semantic ids (`mic`, `screen`) if the splitter
  can assign them (ACS infers "screen" via a `'screen' in filename` test today).
  Positional ids (`t0`/`t1`) also work — labels just come through less pretty.
- **Sentence segmentation is NOT required** — CS derives segments from word
  timings + punctuation. Send an optional explicit segmentation only if you ever
  want to override CS's grouping (not currently consumed).
- The transcript may have **gaps** (ACS drops words in cut/silent regions); CS
  handles gaps fine (they just start new segments).

## Round-trip (LATER — not wired yet)

`splitSuggestions` is the shape CS will **emit back** once the subject-drift
split feature runs against an imported story. Story-local timestamps; add
`story.startSeconds` to convert to session time on the ACS side.

```jsonc
{
  "formatVersion": 1,
  "producer": "ContentStudio",
  "sourceSession": "2026-07-15",
  "story": { "number": 2, "slug": "jack-posobiec", "startSeconds": 5400.0 },
  "splitSuggestions": [
    { "index": 1, "startSeconds": 0.0,    "timestamp": "0:00:00", "label": "Cold open — Posobiec intro" },
    { "index": 2, "startSeconds": 3720.0, "timestamp": "1:02:00", "label": "Shift to immigration segment",
      "rationale": "Topic drifts from personal history to policy" }
  ]
}
```
