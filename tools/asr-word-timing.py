"""Usage: python3 tools/asr-word-timing.py <whisper.cpp sidecar> <crucible sidecar> <limit seconds>

(b) Word timing, Crucible (qwen3-asr-1.7b + qwen3-aligner) vs whisper.cpp -ml 1, plan §8.3.

Both sidecars are the editor's own (transcribe.py: same extraction, same VAD compaction, same
map_words); words are compared per track in FILE seconds over the stretch both cover
(fileStart < LIMIT). Tokens are matched by difflib on a normalised spelling (letters/digits,
lower case); each matched pair gives |dstart| and |dend|. Agreement = matched / whisper words
and matched / crucible words. The frame is the session's frameSeconds (the cut quantum).
"""
import json, sys, difflib, re, statistics
old = json.load(open(sys.argv[1]))
new = json.load(open(sys.argv[2]))
LIMIT = float(sys.argv[3])
frame = old['frameSeconds']
norm = lambda t: re.sub(r'[^0-9a-z]+', '', t.lower())
FILL = re.compile(r'^(um+|uh+|ah+|er+|hmm+|mm+)$')


def pct(xs, p):
    xs = sorted(xs)
    if not xs:
        return None
    k = (len(xs) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def runs(words, min_reps=10, max_unit=15):
    texts = [w['text'].strip().lower() for w in words]
    n_runs = 0
    for n in range(2, max_unit + 1):
        i = 0
        while i + 2 * n <= len(texts):
            reps = 1
            while i + (reps + 1) * n <= len(texts) and texts[i:i + n] == texts[i + reps * n:i + (reps + 1) * n]:
                reps += 1
            if reps >= min_reps:
                n_runs += 1
                i += reps * n
            else:
                i += 1
    return n_runs


report = {'frameSeconds': frame, 'limitSeconds': LIMIT, 'tracks': {}}
allds, allde = [], []
for t in old['tracks']:
    tid = t['id']
    ow = [w for w in old['words'] if w['track'] == tid and w['fileStart'] < LIMIT]
    nw = [w for w in new['words'] if w['track'] == tid and w['fileStart'] < LIMIT]
    ow = [w for w in ow if norm(w['text'])]
    nw = [w for w in nw if norm(w['text'])]
    sm = difflib.SequenceMatcher(a=[norm(w['text']) for w in ow], b=[norm(w['text']) for w in nw], autojunk=False)
    ds, de = [], []
    for blk in sm.get_matching_blocks():
        for k in range(blk.size):
            a, b = ow[blk.a + k], nw[blk.b + k]
            ds.append(b['fileStart'] - a['fileStart'])
            de.append(b['fileEnd'] - a['fileEnd'])
    ads, ade = [abs(x) for x in ds], [abs(x) for x in de]
    allds += ads
    allde += ade
    report['tracks'][tid] = {
        'label': t['label'], 'whisperWords': len(ow), 'crucibleWords': len(nw), 'matched': len(ds),
        'agreementOfWhisper': round(len(ds) / max(1, len(ow)), 4), 'agreementOfCrucible': round(len(ds) / max(1, len(nw)), 4),
        'fillers': {'whisper': sum(1 for w in ow if FILL.match(norm(w['text']))), 'crucible': sum(1 for w in nw if FILL.match(norm(w['text'])))},
        'dStartSigned': {'median': round(statistics.median(ds), 4) if ds else None, 'mean': round(statistics.mean(ds), 4) if ds else None},
        'dEndSigned': {'median': round(statistics.median(de), 4) if de else None, 'mean': round(statistics.mean(de), 4) if de else None},
        'absStart': {'median': round(pct(ads, .5), 4), 'p90': round(pct(ads, .9), 4), 'p99': round(pct(ads, .99), 4)},
        'absEnd': {'median': round(pct(ade, .5), 4), 'p90': round(pct(ade, .9), 4), 'p99': round(pct(ade, .99), 4)},
        'shareStartOverFrame': round(sum(1 for x in ads if x > frame) / max(1, len(ads)), 4),
        'shareEndOverFrame': round(sum(1 for x in ade if x > frame) / max(1, len(ade)), 4),
        'repetitionRunsSurviving': {'whisper': runs(ow), 'crucible': runs(nw)},
    }
report['all'] = {
    'matched': len(allds),
    'absStart': {'median': round(pct(allds, .5), 4), 'p90': round(pct(allds, .9), 4), 'p99': round(pct(allds, .99), 4)},
    'absEnd': {'median': round(pct(allde, .5), 4), 'p90': round(pct(allde, .9), 4), 'p99': round(pct(allde, .99), 4)},
    'shareStartOverFrame': round(sum(1 for x in allds if x > frame) / max(1, len(allds)), 4),
    'shareEndOverFrame': round(sum(1 for x in allde if x > frame) / max(1, len(allde)), 4),
    'passRule': 'p90 |d| <= 1 frame and median |d| < half a frame (plan §8.3)',
}
a = report['all']
a['pass'] = bool(a['absStart']['p90'] <= frame and a['absEnd']['p90'] <= frame and a['absStart']['median'] < frame / 2 and a['absEnd']['median'] < frame / 2)
print(json.dumps(report, indent=1))
