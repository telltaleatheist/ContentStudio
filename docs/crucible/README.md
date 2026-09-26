# docs/crucible

The build notes of the Crucible migration (CRUCIBLE-MIGRATION-PLAN.md, LEDGER #193–#208), one
file per phase: `P1.md` (registry, probe, Servers pane), `P2.md` (the one transport), `P3.md`
(lanes, parking, the in-flight ledger), `P5.md` (ASR), `P7.md` (denoise), `P8a.md` (the pure
chaptering service), `P8b.md` (chaptering wired into the pipeline, the editor's Stories and the
in-queue split), `P8c.md` (stories by 45-second junctions, #212; the chapters | stories pick, #213),
`stories-and-tags.md` (#205's two rulings). `reference/` holds the Python the snap chaptering port
was checked against, and `chapter-splitter.ts`, the stories grain's method spec (read-only).

## Launching the app in development without touching Owen's data

`electron/main.ts` pins userData with `app.setPath`, so Chromium's `--user-data-dir` has no
effect, and a plain `npm start` runs on the real folder (`~/Library/Application
Support/contentstudio`): its settings, routing, Crucible registry, OAuth tokens, publish records
and analytics. Two agents did exactly that by mistake during the migration.

A development run can name another folder with **`CONTENTSTUDIO_USER_DATA`**
(`electron/user-data-path.ts`):

```sh
CONTENTSTUDIO_USER_DATA=/tmp/cs-agent-userdata npm start
```

- It is honoured **only when the app is not packaged** (`app.isPackaged` false). A packaged
  build always runs on its own folder and logs that it ignored the variable.
- It must be an **absolute path**; a relative one is refused by name at boot.
- The first line of the log says which folder the run is on (`[Boot] userData: …`), either way.
- The folder starts empty: the app seeds its store defaults and prompt sets there, and has no
  Crucible server registered until one is added (or auto-connected from `~/.crucible/pairing`).

Use it for every app launch an agent or a test makes. The CLIs (`scripts/generate-metadata-cli.js`,
`tools/*`) do not launch the app; they read the real registry and routing read-only and keep
their own in-flight ledger file beside it (docs/crucible/P3.md, "CLIs").
