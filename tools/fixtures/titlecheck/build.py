import json, glob, os, re, collections
OUT='/private/tmp/claude-501/-Volumes-Callisto-Projects-ContentStudio/0492e18e-5106-42dc-96fa-6be73f4a94b0/scratchpad/titlecheck'
CS='/Volumes/Callisto/ContentStudio/.contentstudio'
A=os.path.expanduser('~/Library/Application Support/contentstudio')
LOGS=[os.path.expanduser('~/Library/Logs/contentstudio/main.old.log'), os.path.expanduser('~/Library/Logs/contentstudio/main.log')]
chans={c['channelId']:c for c in json.load(open(f'{A}/analytics/channels.json'))}
set2chan={ps:c['name'] for c in chans.values() for ps in c['promptSets']}
stats=collections.Counter()

class Store:
    def __init__(s): s.rows={}; s.order=[]
    def add(s, text, source_file, video, flags=(), **extra):
        if not isinstance(text,str) or not text.strip(): return
        r=s.rows.get(text)
        if r is None:
            r={'text':text,'source_file':source_file,'video':video,'flagged_by':[]}
            s.rows[text]=r; s.order.append(text)
        else:
            r['n_occurrences']=r.get('n_occurrences',1)+1
            if not r.get('video') and video: r['video']=video
        for f in flags:
            if f not in r['flagged_by']: r['flagged_by'].append(f)
        for k,v in extra.items():
            if v is None: continue
            if isinstance(v,list):
                cur=r.setdefault(k,[])
                for x in v:
                    if x not in cur: cur.append(x)
            elif k not in r: r[k]=v
    def write(s, path):
        with open(path,'w') as f:
            for t in s.order: f.write(json.dumps(s.rows[t],ensure_ascii=False)+'\n')
        return len(s.order)

CH=Store(); DE=Store()
titles_rows=[]; title_index={}
sel={}
for f in glob.glob(f'{A}/publish/selections/items/*.json'):
    d=json.load(open(f)); sel[d['itemId']]=(f,d)

def chain_afters(it):
    """list of (record, afterstate-getter) oldest..newest; after of record i = before of next record that changed that field, else current."""
    recs=list(it.get('scrubbed_earlier',[]))+([it['scrubbed']] if 'scrubbed' in it else [])
    return recs

def current(it, field):
    if field=='chapters': return [c.get('title') for c in it.get('chapters') or []]
    return it.get(field)

for f in sorted(glob.glob(f'{CS}/metadata/*.json')):
    job=json.load(open(f))
    for it in job['items']:
        video=it.get('_title') or os.path.basename(it.get('source_path',''))
        chan=set2chan.get(it.get('_prompt_set'))
        recs=chain_afters(it)
        for i,rec in enumerate(recs):
            for field,v in rec['fields'].items():
                if not v.get('changed'): 
                    # scrub saw it and kept it: mark the current text as scrub_kept (only for newest record)
                    continue
                before=v['before']
                after=None
                for later in recs[i+1:]:
                    lv=later['fields'].get(field,{})
                    if lv.get('changed'): after=lv['before']; break
                if after is None: after=current(it,field)
                store=CH if field=='chapters' else DE
                if isinstance(before,list):
                    for j,b in enumerate(before):
                        a=after[j] if isinstance(after,list) and j<len(after) else None
                        if a is not None and a!=b:
                            stats[f'scrub_changed_{field}']+=1
                            store.add(b,f,video,['scrub_changed'],after_scrub=a,field=field,channel=chan,scrub_at=rec['at'],scrub_model=rec['model'])
                            store.add(a,f,video,['scrub_output'],before_scrub=b,field=field,channel=chan)
                        else:
                            store.add(b,f,video,['scrub_kept'],field=field,channel=chan)
                else:
                    if after!=before:
                        stats[f'scrub_changed_{field}']+=1
                        store.add(before,f,video,['scrub_changed'],after_scrub=after,field=field,channel=chan,scrub_at=rec['at'],scrub_model=rec['model'])
                        store.add(after,f,video,['scrub_output'],before_scrub=before,field=field,channel=chan)
        if recs:
            last=recs[-1]
            for field,v in last['fields'].items():
                if not v.get('changed'):
                    cur=current(it,field)
                    store=CH if field=='chapters' else DE
                    for t in (cur if isinstance(cur,list) else [cur]):
                        store.add(t,f,video,['scrub_kept'],field=field,channel=chan)
        for c in it.get('chapters') or []:
            CH.add(c.get('title'),f,video,[],field='chapters',channel=chan,timestamp=c.get('timestamp'))
        for fld in ('description','description_hook'):
            DE.add(it.get(fld),f,video,[],field=fld,channel=chan)
        for o in it.get('description_options') or []:
            DE.add(o,f,video,[],field='description_options',channel=chan)
        # owen's edits
        s=sel.get(it['item_id'])
        sd=s[1] if s else {}
        for k,newt in (sd.get('chapterEdits') or {}).items():
            m=re.match(r'^(\S+) - (.*)$',k,re.S); old=m.group(2) if m else k
            CH.add(old,s[0],video,['owen_edited_from'],owen_edited_to=newt,field='chapters',channel=chan)
            CH.add(newt,s[0],video,['owen_edited_to'],owen_edited_from=old,field='chapters',channel=chan)
        if sd.get('descriptionOverride'):
            DE.add(sd['descriptionOverride'],s[0],video,['owen_override'],field='description',channel=chan)
        if it.get('titles'):
            titles_rows.append({'video':video,'channel':chan or (chans.get(sd.get('channelId'),{}).get('name')),
                'candidates':it['titles'],'chosen':sd.get('chosenTitles') or None,
                'title_edits':sd.get('titleEdits') or None,'youtube_video_id':sd.get('videoId'),
                'publish_status':sd.get('status'),'item_id':it['item_id'],'source_file':f,'created_at':job.get('created_at')})

# cli-cache
for f in sorted(glob.glob(f'{CS}/cli-cache/*.chapters.json')):
    d=json.load(open(f)); video=os.path.basename(d.get('sourceLabel','')) or os.path.basename(f)
    for w in d.get('warnings',[]):
        m=re.search(r'is titled "(.*)", (?:and it|which it) (.*?); the model',w)
        if m:
            reason='narrates_actor' if 'covering the subject' in m.group(2) else 'ungrounded_name'
            CH.add(m.group(1),f,video,['judge_warned'],judge_reasons=[m.group(2)],judge_kind=[reason],field='chapters')
            stats['judge_warnings_clicache']+=1
    for c in (d.get('result') or {}).get('chapters',[]):
        CH.add(c.get('title'),f,video,[],field='chapters',timestamp=c.get('timestamp'))

# logs
title2video={t:r['video'] for t,r in CH.rows.items()}
for L in LOGS:
    for line in open(L,errors='replace'):
        if 'is titled "' not in line: continue
        m=re.search(r'is titled "(.*)", (?:and it|which it) (.*?); the model',line)
        if not m: continue
        reason='narrates_actor' if 'covering the subject' in m.group(2) else 'ungrounded_name'
        CH.add(m.group(1),L,title2video.get(m.group(1)),['judge_warned'],judge_reasons=[m.group(2)],judge_kind=[reason],field='chapters',logged_at=line[1:24])
        stats['judge_warnings_log']+=1

n_ch=CH.write(f'{OUT}/chapters.jsonl'); n_de=DE.write(f'{OUT}/descriptions.jsonl')
def flagcount(S):
    c=collections.Counter()
    for r in S.rows.values():
        if not r['flagged_by']: c['(unflagged)']+=1
        for x in r['flagged_by']: c[x]+=1
    return c

# AB
vids={}
for f in glob.glob(f'{A}/analytics/UC*/videos.json'):
    for v in json.load(open(f)): vids[v['videoId']]=v
gen_by_vid={r['youtube_video_id']:r for r in titles_rows if r['youtube_video_id']}
ab=[]
for f in sorted(glob.glob(f'{A}/analytics/UC*/ab-tests.json')):
    for x in json.load(open(f)):
        if not x.get('winner'): continue
        v=vids.get(x['videoId'],{})
        g=gen_by_vid.get(x['videoId'])
        row={'channel':chans[x['channelId']]['name'],'channel_id':x['channelId'],'video_id':x['videoId'],
             'variants':[{'title':t,'watchTimeSharePct':s,'isWinner':t==x['winner']} for t,s in zip(x['variants'],x['shares'])],
             'winner':x['winner'],'liftPct':x.get('liftPct'),'decidedAt':x.get('decidedAt'),'method':x.get('method'),
             'current_title':(v.get('titleHistory') or [{}])[-1].get('title'),'publishedAt':v.get('publishedAt'),
             'durationSec':v.get('durationSec'),'format':v.get('format'),
             'contentstudio_generated':bool(g),'source':f}
        if g: row['contentstudio_candidates_n']=len(g['candidates']); row['contentstudio_item_id']=g['item_id']
        ab.append(row)
with open(f'{OUT}/ab.jsonl','w') as fo:
    for r in ab: fo.write(json.dumps(r,ensure_ascii=False)+'\n')
for r in titles_rows:
    if r['youtube_video_id'] and any(a['video_id']==r['youtube_video_id'] for a in ab):
        a=next(a for a in ab if a['video_id']==r['youtube_video_id']); r['ab_winner']=a['winner']
with open(f'{OUT}/titles.jsonl','w') as fo:
    for r in titles_rows: fo.write(json.dumps(r,ensure_ascii=False)+'\n')

print('chapters',n_ch,flagcount(CH)); print('descriptions',n_de,flagcount(DE))
print('titles rows',len(titles_rows),'with chosen',sum(1 for r in titles_rows if r['chosen']),'with ytid',sum(1 for r in titles_rows if r['youtube_video_id']),'with ab',sum(1 for r in titles_rows if r.get('ab_winner')), 'cands',sum(len(r['candidates']) for r in titles_rows))
print('ab',len(ab),collections.Counter(a['channel'] for a in ab),'generated',sum(a['contentstudio_generated'] for a in ab))
print(stats)
print('judge kinds',collections.Counter(k for r in CH.rows.values() for k in r.get('judge_kind',[])))
print('judge warned with video',sum(1 for r in CH.rows.values() if 'judge_warned' in r['flagged_by'] and r['video']))
print('scrub items',sum(1 for f in glob.glob(f'{CS}/metadata/*.json') for it in json.load(open(f))['items'] if 'scrubbed' in it))
