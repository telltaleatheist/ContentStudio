"""Subject segmentation on the snap harness (stock llama.cpp, one engine for everything).

  1. outline   the model writes the sections of the transcript, in order (generation, thinking off)
  2. assign    snap labels every sentence with the outline item it belongs to (choice, A..Z)
  3. segment   Viterbi over those log-probabilities; any item may follow any other, with a flat
               cost per switch (the granularity dial). Boundaries are where the item changes.
  4. plugs     a fixed "ad / self-promotion" item rides in every outline; each stretch assigned to
               it is confirmed by a snap yes/no, and a rejected stretch is re-segmented without it.
"""
from __future__ import annotations

import math
import time

import httpx

from snap.decide import Decider
from snap.engine import Engine
from snap.labels import MAX_OPTIONS
from snap.schema import DecideRequest

ENGINE_URL = "http://127.0.0.1:8481"
PLUG = "An ad, sponsor read or self-promotion (Patreon, merch, a book, asking viewers to subscribe or support)"
MAX_ITEMS = MAX_OPTIONS - 1  # 25 outline items + the plug item = 26 letters
BATCH = 64  # sentences per snap request (each request primes the shared transcript once)


def clip(s: str, n: int) -> str:
    return s if len(s) <= n else s[: n - 1] + "…"


class Segmenter:
    def __init__(self, url: str = ENGINE_URL):
        self.url = url
        self.engine = Engine(url, timeout_s=1800)
        self.decider = Decider(self.engine)

    # 1 ---------------------------------------------------------------------------------------
    def outline(self, text: str, max_items: int = MAX_ITEMS) -> list[str]:
        msg = ("Here is a transcript of a video.\n\n" + text + "\n\n"
               "List the sections of this video in the order they happen. A new section starts wherever "
               "the video moves to a different subject, story, clip, ad or aside. Write one short, specific "
               f"label per line (at most {max_items} lines), with no numbering and nothing else.")
        r = httpx.post(f"{self.url}/v1/chat/completions", timeout=1800, json={
            "messages": [{"role": "user", "content": msg}],
            "temperature": 0, "max_tokens": 1000,
            "chat_template_kwargs": {"enable_thinking": False}})
        r.raise_for_status()
        content = r.json()["choices"][0]["message"]["content"]
        lines = [l.strip(" -*•\t") for l in content.splitlines()]
        items, seen = [], set()
        for l in lines:
            if l and l.lower() not in seen:
                items.append(l); seen.add(l.lower())
        items = items[:max_items]
        if len(items) < 2:
            raise RuntimeError(f"outline came back with {len(items)} items: {content[:300]!r}")
        return items

    # 2 ---------------------------------------------------------------------------------------
    def assign(self, text: str, sents: list[str], items: list[str]) -> list[list[float]]:
        """log P(item | sentence), one snap choice question per sentence."""
        options = {f"section {k + 1}": item for k, item in enumerate(items)}
        names = list(options)
        out: list[list[float]] = []
        for b in range(0, len(sents), BATCH):
            questions = {}
            for i in range(b, min(len(sents), b + BATCH)):
                prev = sents[i - 1] if i else "(start of the video)"
                questions[f"s{i}"] = {
                    "type": "choice",
                    "instructions": (f'Sentence from the transcript above: "{clip(sents[i], 300)}"\n'
                                     f'(The sentence just before it: "{clip(prev, 200)}")\n'
                                     "Which section of the video is this sentence part of?"),
                    "options": options}
            resp = self.decider.decide(DecideRequest(state=text, questions=questions))
            for i in range(b, min(len(sents), b + BATCH)):
                probs = resp.answers[f"s{i}"].probabilities
                out.append([math.log(max(probs[n], 1e-12)) for n in names])
        return out

    def yesno(self, text: str, statement: str) -> float:
        resp = self.decider.decide(DecideRequest(state=text, questions={"q": {"type": "yesno", "instructions": statement}}))
        return resp.answers["q"].p

    # 4 ---------------------------------------------------------------------------------------
    def confirm_plugs(self, text: str, sents: list[str], L: list[list[float]], plug: int, pen: float):
        L = [row[:] for row in L]
        checked, verdicts = set(), []
        while True:
            path = viterbi(L, pen)
            todo = [r for r in runs(path, plug) if r not in checked]
            if not todo:
                return path, verdicts
            for a, b in todo:
                passage = clip(" ".join(sents[a:b]), 700)
                p = self.yesno(text, f'Passage from the transcript above: "{passage}"\nIn this passage the speaker '
                                     "is advertising or promoting something: a sponsor, their own Patreon, merch, a "
                                     "book, or asking viewers to subscribe, follow or support them.")
                checked.add((a, b)); verdicts.append((a, b, p))
                if p < 0.5:
                    for i in range(a, b):
                        L[i][plug] = -1e9

    def run(self, sents: list[str], pen: float = 20.0, plugs: bool = True) -> dict:
        text = "\n".join(sents)
        t0 = time.time()
        items = self.outline(text)
        t1 = time.time()
        if plugs:
            items = items + [PLUG]
        L = self.assign(text, sents, items)
        t2 = time.time()
        if plugs:
            path, verdicts = self.confirm_plugs(text, sents, L, len(items) - 1, pen)
        else:
            path, verdicts = viterbi(L, pen), []
        return {"items": items, "logp": L, "path": path, "plug_verdicts": verdicts,
                "outline_s": round(t1 - t0, 1), "assign_s": round(t2 - t1, 1), "total_s": round(time.time() - t0, 1)}


# 3 -------------------------------------------------------------------------------------------
def viterbi(L: list[list[float]], switch_pen: float) -> list[int]:
    """Best item per sentence; any item may follow any other at a flat cost per switch."""
    n, m = len(L), len(L[0])
    dp = list(L[0])
    back: list[list[int]] = []
    for i in range(1, n):
        best_j = max(range(m), key=lambda k: dp[k])
        best_v = dp[best_j] - switch_pen
        row, nd = [], []
        for j in range(m):
            if dp[j] >= best_v:
                nd.append(dp[j] + L[i][j]); row.append(j)
            else:
                nd.append(best_v + L[i][j]); row.append(best_j)
        dp = nd
        back.append(row)
    j = max(range(m), key=lambda k: dp[k])
    path = [j]
    for i in range(n - 2, -1, -1):
        j = back[i][j]
        path.append(j)
    return path[::-1]


def runs(path: list[int], j: int) -> list[tuple[int, int]]:
    out, i = [], 0
    while i < len(path):
        if path[i] == j:
            k = i
            while k < len(path) and path[k] == j:
                k += 1
            out.append((i, k)); i = k
        else:
            i += 1
    return out


def boundaries(path: list[int]) -> list[int]:
    return [i for i in range(1, len(path)) if path[i] != path[i - 1]]
