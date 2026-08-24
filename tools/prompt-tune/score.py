#!/usr/bin/env python3
"""Hard checks over the harness outputs; prints a per-video, per-model grid."""
import json, re, glob, os, sys

HARNESS = os.path.dirname(os.path.abspath(__file__))
PROMPTS = os.path.join(HARNESS, 'out', 'prompts')
OUTPUTS = os.path.join(HARNESS, 'out', 'outputs')

PROMOS = ["god's people", 'patreon', 'firesidewatch', 'owenmorgan.com', 'cult archive',
          'understanding jehovah', 'merch']
NARRATOR = [r'\bthe speaker\b', r'\bthe host\b', r'\bthe narrator\b', r'\bthis channel\b',
            r'\bthe creator\b', r'\bwe examine\b', r'\bwe debunk\b', r'\bI debunk\b', r'\bI dismantle\b']
LEAK_NAMES = ['gene bailey', 'ziklag', 'satanic temple']  # prompt example names that must not leak

def load(path):
    raw = open(path).read().strip()
    raw = re.sub(r'^```(json)?\s*|\s*```$', '', raw)
    try:
        return json.loads(raw), None
    except Exception as e:
        # tolerate repairs the pipeline itself applies
        try:
            fixed = re.sub(r',(\s*[}\]])', r'\1', raw)
            return json.loads(fixed), 'trailing-comma repaired'
        except Exception:
            return None, f'UNPARSEABLE: {e}'

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
    data, err = load(path)
    notes = []
    verdict = 'OK'
    if err and data is None:
        rows.append((vid, stage, model, 'FAIL', err[:60])); continue
    if err: notes.append(err)

    if stage == 'chapters-stage1':
        ch = data.get('chapters')
        if not isinstance(ch, list):
            rows.append((vid, stage, model, 'FAIL', 'no chapters array')); continue
        tx = transcript_for(VIDEO_KEYS[vid])
        tx_norm = ' '.join(tx.split())
        unmapped = [c['label'][:30] for c in ch if ' '.join(str(c.get('first_sentence','')).split()) not in tx_norm]
        badlen = [c['label'][:30] for c in ch if not (35 <= len(str(c.get('label',''))) <= 90)]
        leaks = [n for n in LEAK_NAMES for c in ch if n in str(c.get('label','')).lower()]
        promo_labeled = any('plug' in str(c.get('label','')).lower() or 'promotion' in str(c.get('label','')).lower() for c in ch)
        narr = [h for c in ch for h in narrator_hits(str(c.get('label','')))]
        notes.append(f"n={len(ch)}")
        if unmapped: verdict='WARN'; notes.append(f"unmappable_quotes={len(unmapped)}")
        if badlen: notes.append(f"label_len_off={len(badlen)}")
        if leaks: verdict='FAIL'; notes.append(f"EXAMPLE_LEAK={leaks}")
        if narr: verdict='WARN'; notes.append(f"narrator={narr}")
        notes.append('plug-chapter:' + ('yes' if promo_labeled else 'no'))
    elif stage == 'description-hook':
        hook = str(data.get('hook',''))
        if not hook: rows.append((vid, stage, model, 'FAIL', 'no hook')); continue
        if len(hook) > 157: verdict='WARN'; notes.append(f"len={len(hook)}>157")
        else: notes.append(f"len={len(hook)}")
        if promo_hits(hook): verdict='FAIL'; notes.append(f"PROMO={promo_hits(hook)}")
        if narrator_hits(hook): verdict='WARN'; notes.append(f"narrator={narrator_hits(hook)}")
        if not hook.rstrip().endswith(('.', '!', '?')): verdict='WARN'; notes.append('no terminal punct')
    elif stage == 'description-body':
        body = str(data.get('body',''))
        if not body: rows.append((vid, stage, model, 'FAIL', 'no body')); continue
        wc = len(body.split())
        notes.append(f"words={wc}")
        if not (60 <= wc <= 200): verdict='WARN'; notes.append('outside 60-200')
        if promo_hits(body): verdict='FAIL'; notes.append(f"PROMO={promo_hits(body)}")
        if narrator_hits(body): verdict='WARN'; notes.append(f"narrator={narrator_hits(body)}")
        if 'http' in body: verdict='FAIL'; notes.append('contains link')
    elif stage == 'titles':
        titles = data.get('titles')
        if not isinstance(titles, list):
            rows.append((vid, stage, model, 'FAIL', f"no titles array (keys={list(data.keys())[:6]})")); continue
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
    rows.append((vid, stage, model, verdict, '; '.join(notes)))

order = {'chapters-stage1':0,'description-hook':1,'description-body':2,'titles':3}
morder = {'haiku':0,'sonnet':1,'opus':2}
rows.sort(key=lambda r: (r[0], order.get(r[1],9), morder.get(r[2],9)))
cur = None
for vid, stage, model, verdict, notes in rows:
    if (vid,stage) != cur:
        cur = (vid,stage); print(f"\n== {vid} / {stage}")
    print(f"  {model:7s} {verdict:5s} {notes}")
