"""Fixtures for tools/chaptering-checks.js, produced by the REFERENCE code itself.

The TypeScript port (electron/services/metadata/chaptering/) is checked against what
segment.py and submap.py actually do, not against a reading of them. This script lifts the
pure functions out of the two reference files by their source (so nothing here restates
them, and the files' own imports -- httpx, snap, ollama_snap -- are never needed), runs them
over seeded inputs, and writes the inputs and outputs as JSON:

  viterbi.json    segment.py viterbi() / boundaries() over random and adversarial matrices
  plugs.json      segment.py Segmenter.confirm_plugs() with a scripted yes/no
  sentences.json  submap.py sentences() over synthetic captions and a real whisper slice

usage: python3 docs/crucible/reference/make_fixtures.py <real transcript.json> <out dir>
"""
from __future__ import annotations

import ast
import json
import math
import random
import re
import sys
import textwrap
from pathlib import Path

HERE = Path(__file__).parent


def lift(path: Path, names: list[str], cls: str | None = None) -> dict:
    """Exec the named top-level (or class-level) functions of a reference file, alone."""
    tree = ast.parse(path.read_text())
    body = tree.body
    if cls:
        body = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == cls).body
    src = path.read_text().splitlines()
    ns: dict = {"re": re, "math": math}
    for node in body:
        if isinstance(node, ast.FunctionDef) and node.name in names:
            code = "\n".join(src[node.lineno - 1 - len(node.decorator_list): node.end_lineno])
            exec(textwrap.dedent(code), ns)
    missing = [n for n in names if n not in ns]
    if missing:
        raise SystemExit(f"{path.name}: no function {missing}")
    return ns


seg = lift(HERE / "segment.py", ["viterbi", "runs", "boundaries", "clip"])
plug_ns = lift(HERE / "segment.py", ["confirm_plugs"], cls="Segmenter")
sub = lift(HERE / "submap.py", ["srt_sec", "sentences"])


def viterbi_cases(rng: random.Random) -> list[dict]:
    cases = []
    for k in range(40):
        n = rng.choice([1, 2, 3, 7, 20, 64, 150])
        m = rng.choice([1, 2, 3, 5, 12, 26])
        cost = rng.choice([0.0, 2.0, 5.0, 20.0, 30.0, 45.0])
        # A piecewise "true" item with noisy rows, like a real assign matrix.
        L, cur = [], rng.randrange(m)
        for i in range(n):
            if rng.random() < 0.08:
                cur = rng.randrange(m)
            w = [rng.random() ** 3 for _ in range(m)]
            w[cur] += rng.choice([0.5, 2.0, 8.0])
            z = sum(w)
            L.append([math.log(max(x / z, 1e-12)) for x in w])
        cases.append({"L": L, "cost": cost})
    # Exact ties: Python's max() keeps the FIRST maximum.
    cases.append({"L": [[0.0, 0.0], [0.0, 0.0], [0.0, 0.0]], "cost": 1.0})
    cases.append({"L": [[-1.0, -1.0, -1.0], [-2.0, -1.0, -1.0], [-1.0, -1.0, -2.0]], "cost": 0.5})
    # Rows floored at ln(1e-12), and a -1e9 rejected column (confirm_plugs' mark).
    cases.append({"L": [[math.log(1e-12), 0.0, -1e9]] * 4 + [[0.0, math.log(1e-12), -1e9]] * 4, "cost": 20.0})
    for c in cases:
        path = seg["viterbi"](c["L"], c["cost"])
        c["path"] = path
        c["boundaries"] = seg["boundaries"](path)
    return cases


def plug_cases(rng: random.Random) -> list[dict]:
    out = []
    for k in range(24):
        n, m = rng.choice([(30, 4), (60, 5), (120, 6)])
        plug = m - 1
        L, cur = [], 0
        for i in range(n):
            if rng.random() < 0.12:
                cur = rng.randrange(m)
            w = [0.02] * m
            w[cur] = 1.0
            if rng.random() < 0.1:
                w[plug] += 0.6  # the ad column leaning in a little, the §0a trap
            z = sum(w)
            L.append([math.log(x / z) for x in w])
        verdict_seed = rng.random()

        class FakeSelf:
            asked: list = []

            def yesno(self, text, statement):
                # The passage is quoted, never indexed: recover the unit range from its tokens.
                ids = [int(x) for x in re.findall(r"\bu(\d+)\b", statement)]
                a, b = ids[0], ids[-1] + 1
                p = ((a * 7919 + b * 104729) % 1000) / 1000.0
                p = (p + verdict_seed) % 1.0
                self.asked.append([a, b, p])
                return p

        me = FakeSelf()
        me.asked = []
        sents = [f"u{i}" for i in range(n)]
        path, verdicts = _confirm(me, sents, L, plug)
        out.append({"L": L, "plug": plug, "cost": 20.0, "asked": me.asked, "path": path,
                    "verdicts": [[a, b, p] for a, b, p in verdicts]})
    return out


def _confirm(me, sents, L, plug):
    fn = plug_ns["confirm_plugs"]
    fn.__globals__.update({"viterbi": seg["viterbi"], "runs": seg["runs"], "clip": seg["clip"]})
    return fn(me, "", sents, L, plug, 20.0)


def srt(t: float) -> str:
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def sentence_cases(real: Path) -> list[dict]:
    synthetic = [
        [(0.0, 4.0, "Hello there. This is the first real sentence of the video."),
         (4.0, 9.5, "Okay. Yeah. So the second one runs across"),
         (9.5, 12.0, "two captions, and ends here! Then a question? Sure."),
         (12.0, 20.0, "A caption with no terminal punctuation at all")],
        [(1.0, 2.0, "Mr. Smith went to Washington."), (2.0, 3.5, '"He said so." (Really.) And then...'),
         (3.5, 6.0, "   spaced    out   words   here.  "), (6.0, 6.0, ""), (6.0, 8.0, "Last words")],
        [(0.0, 1.0, "One."), (1.0, 2.0, "Two."), (2.0, 3.0, "Three."), (3.0, 9.0, "Four words at last.")],
    ]
    t = json.loads(real.read_text())
    segs = t["segments"] if "segments" in t else t["contentItems"][0]["srtSegments"]
    real_caps = [(sub["srt_sec"](s["start"]), sub["srt_sec"](s["end"]), " ".join(s["text"].split())) for s in segs[:60]]
    out = []
    for caps in synthetic + [[c for c in real_caps if c[2]]]:
        clean = [(a, b, " ".join(x.split())) for a, b, x in caps]
        clean = [c for c in clean if c[2]]
        _, sents = sub["sentences"](clean)
        out.append({"captions": [{"start": srt(a), "end": srt(b), "text": x} for a, b, x in caps],
                    "sentences": [{"t": s["t"], "text": s["text"]} for s in sents]})
    return out


def main() -> None:
    real, outdir = Path(sys.argv[1]), Path(sys.argv[2])
    outdir.mkdir(parents=True, exist_ok=True)
    rng = random.Random(199)
    (outdir / "viterbi.json").write_text(json.dumps(viterbi_cases(rng)))
    (outdir / "plugs.json").write_text(json.dumps(plug_cases(rng)))
    (outdir / "sentences.json").write_text(json.dumps(sentence_cases(real), indent=1))
    print(f"wrote {outdir}/viterbi.json, plugs.json, sentences.json")


if __name__ == "__main__":
    main()
