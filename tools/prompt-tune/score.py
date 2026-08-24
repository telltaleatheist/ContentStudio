#!/usr/bin/env python3
"""Hard checks over the harness outputs; prints a per-video, per-model grid.

PLAIN-TEXT FORMATS since 2026-08-24 (the no-JSON refactor): a chapters-stage1 answer is one
verbatim opening sentence per line; a description-candidate answer is the hook, a blank line,
the body. Titles answers are one title per line (the traced titles prompt may still be the
old JSON group call — `titles-group-STALE` — so the titles reader accepts both shapes).
Output files keep the .json extension for continuity but hold whatever the model wrote.
"""
import json, re, glob, os, sys

HARNESS = os.path.dirname(os.path.abspath(__file__))
PROMPTS = os.path.join(HARNESS, 'out', 'prompts')
OUTPUTS = os.path.join(HARNESS, 'out', 'outputs')

PROMOS = ["god's people", 'patreon', 'firesidewatch', 'owenmorgan.com', 'cult archive',
          'understanding jehovah', 'merch']
NARRATOR = [r'\bthe speaker\b', r'\bthe host\b', r'\bthe narrator\b', r'\bthis channel\b',
            r'\bthe creator\b', r'\bwe examine\b', r'\bwe debunk\b', r'\bI debunk\b', r'\bI dismantle\b']
LEAK_NAMES = ['gene bailey', 'ziklag', 'satanic temple']  # prompt example names that must not leak

LIST_MARKER = re.compile(r'^\s*(?:[-*•]\s+|\d{1,3}[.)]\s+)')

def read_lines(raw):
    return [LIST_MARKER.sub('', l).strip() for l in raw.split('\n') if LIST_MARKER.sub('', l).strip()]

def transcript_for(video):
    p = open(os.path.join(PROMPTS, f'{video}--chapters-stage1.txt' if video.startswith('f') else '')).read()
    m = re.search(r'TRANSCRIPT:\n(.*?)\n\nThe video moves through', p, re.S)
    return m.group(1) if m else ''

def promo_hits(text):
    t = text.lower()
    return [p for p in PROMOS if p in t]

def narrator_hits(text):
    return [pat for pat in NARRATOR if re.search(pat, text, re.I)]

def title_case_score(t):
    words = [w for w in re.findall(r"[A-Za-z][A-Za-z'’-]*", t)]
    if len(words) < 3: return 0.0
    caps = sum(1 for w in words[1:] if w[0].isupper())
    return caps / max(1, len(words) - 1)

VIDEO_KEYS = {'f3': 'f3-intelligent-design', 'f1': 'f1-ten-commandments'}
rows = []
for path in sorted(glob.glob(os.path.join(OUTPUTS, '*.json'))):
    base = os.path.basename(path)[:-5]
    vid, stage, model = base.split('--')
    raw = open(path).read().strip()
    raw = re.sub(r'^```(json)?\s*|\s*```$', '', raw)
    raw = re.sub(r'<think>.*?</think>', '', raw, flags=re.S).strip()
    notes = []
    verdict = 'OK'

    if stage == 'chapters-stage1':
        quotes = read_lines(raw)
        if not quotes:
            rows.append((vid, stage, model, 'FAIL', 'no boundary lines at all')); continue
        tx_norm = ' '.join(transcript_for(VIDEO_KEYS[vid]).split())
        unmapped = [q[:40] for q in quotes if ' '.join(q.split()) not in tx_norm]
        short = [q for q in quotes if len(q.split()) < 6]
        leaks = [n for n in LEAK_NAMES for q in quotes if n in q.lower()]
        notes.append(f"n={len(quotes)}")
        if unmapped: verdict='WARN'; notes.append(f"unmappable_quotes={len(unmapped)}")
        if short: verdict='WARN'; notes.append(f"under_6_words={len(short)}")
        if leaks: verdict='FAIL'; notes.append(f"EXAMPLE_LEAK={leaks}")
    elif stage == 'description-candidate':
        m = re.search(r'\n\s*\n', raw)
        if not m:
            rows.append((vid, stage, model, 'FAIL', 'no blank line between hook and body')); continue
        hook = raw[:m.start()].replace('\n', ' ').strip()
        body = raw[m.end():].strip()
        if not hook or not body:
            rows.append((vid, stage, model, 'FAIL', 'empty hook or body around the blank line')); continue
        notes.append(f"hook_len={len(hook)}")
        if len(hook) > 157: verdict='WARN'; notes.append('hook>157')
        if not hook.rstrip().endswith(('.', '!', '?')): verdict='WARN'; notes.append('hook: no terminal punct')
        wc = len(body.split())
        notes.append(f"body_words={wc}")
        if not (60 <= wc <= 200): verdict='WARN'; notes.append('body outside 60-200')
        whole = f'{hook} {body}'
        if promo_hits(whole): verdict='FAIL'; notes.append(f"PROMO={promo_hits(whole)}")
        if narrator_hits(whole): verdict='WARN'; notes.append(f"narrator={narrator_hits(whole)}")
        if 'http' in body: verdict='FAIL'; notes.append('contains link')
    elif stage == 'titles':
        # Accept both shapes: plain lines (current) and the stale group call's JSON object.
        titles = None
        if raw.lstrip().startswith('{'):
            try:
                titles = json.loads(re.sub(r',(\s*[}\]])', r'\1', raw)).get('titles')
            except Exception:
                titles = None
        if titles is None:
            titles = read_lines(raw)
        if not titles:
            rows.append((vid, stage, model, 'FAIL', 'no titles at all')); continue
        notes.append(f"n={len(titles)}")
        over70 = [t for t in titles if len(t) > 70]
        colons = [t for t in titles if ':' in t]
        questions = [t for t in titles if t.strip().endswith('?')]
        digits = [t for t in titles if re.search(r'\d', t)]
        titlecase = [t for t in titles if title_case_score(t) > 0.6]
        promo = [t for t in titles if promo_hits(t)]
        if over70: notes.append(f">70ch={len(over70)}")
        if colons: verdict='WARN'; notes.append(f"colons={len(colons)}")
        if questions: verdict='WARN'; notes.append(f"questions={len(questions)}")
        if digits: notes.append(f"digits={len(digits)}")
        if titlecase: verdict='WARN'; notes.append(f"TitleCase={len(titlecase)}")
        if promo: verdict='FAIL'; notes.append(f"PROMO={len(promo)}")
    else:
        rows.append((vid, stage, model, 'FAIL', f'unknown stage "{stage}"')); continue
    rows.append((vid, stage, model, verdict, '; '.join(notes)))

order = {'chapters-stage1':0,'description-candidate':1,'titles':2}
morder = {'haiku':0,'sonnet':1,'opus':2}
rows.sort(key=lambda r: (r[0], order.get(r[1],9), morder.get(r[2],9)))
cur = None
for vid, stage, model, verdict, notes in rows:
    if (vid,stage) != cur:
        cur = (vid,stage); print(f"\n== {vid} / {stage}")
    print(f"  {model:7s} {verdict:5s} {notes}")
