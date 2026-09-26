"""Subject-break probability map: whole transcript as snap state, one yes/no per sentence.

usage: submap.py <transcript.json> <out.json> [--limit N] [--batch N] [--variant NAME]
"""
import argparse, json, re, sys, time

from ollama_snap import OllamaSnap, choice

MODEL = "qwen3.5:9b-bf16"


def srt_sec(s: str) -> float:
    h, m, rest = s.split(":")
    sec, ms = rest.split(",")
    return int(h) * 3600 + int(m) * 60 + int(sec) + int(ms) / 1000


def load_segments(path):
    t = json.load(open(path))
    if "segments" in t:
        segs = t["segments"]
    else:
        segs = t["contentItems"][0]["srtSegments"]
    out = []
    for s in segs:
        text = " ".join(s["text"].split())
        if text:
            out.append((srt_sec(s["start"]), srt_sec(s["end"]), text))
    return out


def sentences(segs, min_words=4):
    """Split the joined caption text into sentences. Each sentence's time is its start
    segment's start plus its character fraction through that segment (an estimate: whisper
    base gives no word timings)."""
    text, spans = "", []  # spans: (char_start, char_end, seg_start, seg_end)
    for a, b, t in segs:
        if text:
            text += " "
        spans.append((len(text), len(text) + len(t), a, b))
        text += t

    def time_at(ci):
        for cs, ce, a, b in spans:
            if cs <= ci < ce or ci < cs:
                if ci < cs:
                    return a
                return a + (b - a) * (ci - cs) / max(1, ce - cs)
        return spans[-1][3]

    raw = []
    for m in re.finditer(r"[^.!?]+(?:[.!?]+[\"')\]]*|$)", text):
        s = m.group(0).strip()
        if s:
            raw.append((m.start() + (len(m.group(0)) - len(m.group(0).lstrip())), s))
    # fold very short sentences ("Okay.", "Yeah.") into the sentence that follows
    merged, pend = [], None
    for ci, s in raw:
        if pend:
            ci, s = pend[0], pend[1] + " " + s
            pend = None
        if len(s.split()) < min_words:
            pend = (ci, s)
            continue
        merged.append((ci, s))
    if pend:
        merged.append(pend)
    return text, [{"i": k, "t": round(time_at(ci), 2), "text": s} for k, (ci, s) in enumerate(merged)]


VARIANTS = {
    "subject": (
        'Right after the words "{prev}", the speaker says "{cur}". '
        "With this sentence the video moves on to a new subject: a different topic, story, "
        "clip or source, rather than continuing the one before it."
    ),
    "section": (
        'The sentence "{cur}" is the first sentence of a new section of the video, and the '
        'sentence just before it, "{prev}", is the last sentence of a different section. '
        "(A section is a stretch about one subject, story, clip, ad or aside; returning to an "
        "earlier subject after an aside also starts a new section.)"
    ),
}


CHOICES = {
    "pair": (
        'Two consecutive sentences from the video above.\nSentence 1: "{prev}"\nSentence 2: "{cur}"\n'
        "Does sentence 2 stay in the same section as sentence 1, or does a new section of the video begin at sentence 2?",
        ["Same section: sentence 2 continues the subject, story, clip or aside that sentence 1 is part of",
         "New section: sentence 2 begins a different subject, story, clip, ad or aside, or returns to an earlier subject"],
    ),
}


WINDOWED = {
    "window": (
        'Two stretches of the video above, back to back.\nBEFORE: "{before}"\nAFTER: "{after}"\n'
        "Are BEFORE and AFTER about the same subject, or has the video moved to a different subject at the start of AFTER?",
        ["Same subject: AFTER carries on with what BEFORE is about",
         "Different subject: AFTER is about a different topic, story, clip, ad or aside than BEFORE"],
    ),
}


def window(sents, i, words):
    """~`words` words of whole sentences ending just before sentence i, and starting at it."""
    before, n = [], 0
    for s in reversed(sents[:i]):
        before.insert(0, s["text"]); n += len(s["text"].split())
        if n >= words: break
    after, n = [], 0
    for s in sents[i:]:
        after.append(s["text"]); n += len(s["text"].split())
        if n >= words: break
    return clip(" ".join(before), words * 9), clip(" ".join(after), words * 9)


def clip(s, n=300):
    return s if len(s) <= n else s[: n - 1] + "…"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("transcript")
    ap.add_argument("out")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--num-ctx", type=int, default=32768)
    ap.add_argument("--variant", default="subject")
    ap.add_argument("--window-words", type=int, default=100)
    a = ap.parse_args()

    segs = load_segments(a.transcript)
    text, sents = sentences(segs)
    tmpl = VARIANTS.get(a.variant)
    qs = sents[1:]  # sentence 0 starts the video; nothing to break from
    if a.limit:
        qs = qs[: a.limit]
    print(f"{len(segs)} segments, {len(sents)} sentences, {len(text.split())} words; asking {len(qs)}", file=sys.stderr)
    o = OllamaSnap(MODEL, a.num_ctx)
    t0 = time.time()
    n_tok, prime_ms = o.prime(text)
    print(f"  prime {n_tok} tokens {prime_ms/1000:.1f}s", file=sys.stderr)
    for k, s in enumerate(qs):
        prev = sents[s["i"] - 1]["text"]
        if a.variant in WINDOWED:
            q, opts = WINDOWED[a.variant]
            before, after = window(sents, s["i"], a.window_words)
            probs, mass = choice(o, text, q.format(before=before, after=after), opts)
            p = probs[1]
        elif a.variant in CHOICES:
            q, opts = CHOICES[a.variant]
            probs, mass = choice(o, text, q.format(prev=clip(prev), cur=clip(s["text"])), opts)
            p = probs[1]
        else:
            p, mass, _, _ = o.yesno(text, tmpl.format(prev=clip(prev), cur=clip(s["text"])))
        s["p"], s["mass"] = round(p, 5), round(mass, 4)
        if (k + 1) % 100 == 0:
            print(f"  {k+1}/{len(qs)}  {time.time()-t0:.1f}s", file=sys.stderr)

    wall = time.time() - t0
    json.dump({"transcript": a.transcript, "variant": a.variant, "words": len(text.split()),
               "duration": segs[-1][1], "wall_s": round(wall, 1), "prime_ms": prime_ms, "prime_tokens": n_tok, "model": MODEL, "sentences": sents}, open(a.out, "w"), indent=1)
    print(f"done in {wall:.1f}s", file=sys.stderr)


if __name__ == "__main__":
    main()
