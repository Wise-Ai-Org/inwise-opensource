import React, { useEffect, useRef, useState } from 'react';
import { api } from './nav';
import './WorkBrain.css';

type Project = { id: string; name: string; description: string };
const workTypes = ['task', 'decision', 'blocker', 'risk', 'update'];
const localDay = (date: Date) => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
export default function WorkBrain({ onClose }: { onClose: () => void }) {
  const [connected, setConnected] = useState(false), [org, setOrg] = useState('');
  const [code, setCode] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]), [meetings, setMeetings] = useState<any[]>([]);
  const [meetingId, setMeetingId] = useState(''), [projectId, setProjectId] = useState(''), [workType, setWorkType] = useState('update');
  const [title, setTitle] = useState(''), [summary, setSummary] = useState(''), [references, setReferences] = useState('');
  const [reviewed, setReviewed] = useState(false), [shared, setShared] = useState(false);
  const [observedOn, setObservedOn] = useState(localDay(new Date()));
  const id = useRef(crypto.randomUUID()), alive = useRef(true), dialog = useRef<HTMLDivElement>(null), previousFocus = useRef<HTMLElement | null>(null);
  const selected = meetings.find(m => m._id === meetingId);
  const message = (e: any) => String(e?.message || e || 'Try again.').replace(/^Error invoking remote method '[^']+': Error: /, '');
  const load = async () => {
    const status = await api().workBrainStatus(); if (!alive.current) return;
    setConnected(!!status.connected); setOrg(status.organisationName || 'Your organisation');
    if (status.connected) {
      const [catalogue, local] = await Promise.all([api().workBrainCatalogue(), api().getMeetings()]);
      if (!alive.current) return; setProjects(catalogue.projects || []); setMeetings(local || []);
    }
  };
  useEffect(() => {
    alive.current = true;
    previousFocus.current = document.activeElement as HTMLElement; dialog.current?.focus();
    load().catch(e => alive.current && setError(message(e)));
    return () => { alive.current = false; previousFocus.current?.focus(); };
  }, []);
  useEffect(() => {
    if (!code) return;
    let stopped = false, inflight = false;
    const timer = setInterval(async () => {
      if (inflight) return; inflight = true;
      try { const result = await api().workBrainPoll(); if (!stopped && result.state === 'connected') { setCode(''); await load(); } }
      catch (e) { if (!stopped) { setCode(''); setError(message(e)); } }
      finally { inflight = false; }
    }, 3000);
    return () => { stopped = true; clearInterval(timer); };
  }, [code]);
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn(); } catch (e) { setError(message(e)); } finally { if (alive.current) setBusy(false); } };
  const change = () => { setReviewed(false); setShared(false); id.current = crypto.randomUUID(); };
  const submit = () => run(async () => {
    if (!reviewed || !title.trim() || !summary.trim()) throw new Error('Review the exact text before sharing.');
    await api().workBrainShare({ contributionId: id.current, projectId: projectId || null, workType, title: title.trim(), orgSummary: summary.trim(), observedOn, relatedWorkItems: references.split(',').map(x=>x.trim()).filter(Boolean), reviewedAt: new Date().toISOString() }, meetingId || undefined);
    setShared(true);
  });
  return <div className="wb-backdrop"><div className="wb-panel" role="dialog" aria-modal="true" aria-labelledby="wb-title" tabIndex={-1} ref={dialog} onKeyDown={e=>{
    if(e.key==='Escape'&&!busy){e.stopPropagation();onClose();}
    if(e.key==='Tab'){const nodes=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, textarea, a[href]')||[]);const first=nodes[0],last=nodes[nodes.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&(document.activeElement===last||document.activeElement===dialog.current)){e.preventDefault();first?.focus();}}
  }}>
    <header><h2 id="wb-title">Org’s work brain</h2><button className="pp-quiet-action" aria-label="Close org connection" disabled={busy} onClick={onClose}>✕</button></header>
    <p>Contribute useful work context. Audio, transcripts and private meeting details stay on this device.</p>
    {error && <div className="wb-error" role="alert">{error}</div>}
    {!connected ? <><p>Sign in on the web, check the matching code, and approve this device. Connecting never shares a meeting automatically.</p>
      {code ? <div role="status"><strong className="wb-code">{code}</strong><p>Check this code on the web page. Waiting for your approval…</p></div> : <button className="wb-primary" disabled={busy} onClick={()=>run(async()=>{const r=await api().workBrainConnect();setCode(r.verificationCode);})}>{busy?'Opening…':'Connect your organisation'}</button>}
    </> : <><div className="wb-connected">Connected to {org}<button className="pp-link" disabled={busy} onClick={()=>run(async()=>{await api().workBrainDisconnect();setConnected(false);setProjects([]);setMeetings([]);})}>Disconnect</button></div>
      <p className="wb-meta">Disconnect stops future contributions. Updates you already shared remain in the organisation.</p>
      <fieldset disabled={busy}>
      <label>Private source meeting<select value={meetingId} onChange={e=>{setMeetingId(e.target.value);change();}}><option value="">Choose local context (optional)</option>{meetings.map(m=><option key={m._id} value={m._id}>{m.title || 'Untitled meeting'}</option>)}</select></label>
      {selected && <details><summary>Private context — never included in the contribution</summary><p>{typeof selected.summary==='string'?selected.summary:'Use this meeting’s insights to write a safe org update.'}</p><p>{(selected.decisions||[]).slice(0,5).map((d:any)=>typeof d==='string'?d:d.text||d.title||'').join(' · ')}</p></details>}
      <label>Project<select value={projectId} onChange={e=>{setProjectId(e.target.value);change();}}><option value="">Unassigned — don’t guess</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <p className="wb-meta">Only projects explicitly marked for organisation-wide visibility appear here. Private or unclassified projects are excluded.</p>
      <label>Work type<select value={workType} onChange={e=>{setWorkType(e.target.value);change();}}>{workTypes.map(t=><option key={t}>{t}</option>)}</select></label>
      <label>Observed on<input type="date" value={observedOn} onChange={e=>{setObservedOn(e.target.value);change();}} /></label>
      <label>Shared title<input maxLength={140} value={title} onChange={e=>{setTitle(e.target.value);change();}} /></label>
      <label>Summary everyone in the org may see<textarea rows={4} maxLength={2000} value={summary} onChange={e=>{setSummary(e.target.value);change();}} placeholder="Write the useful work update. Remove quotes, personal details and confidential context." /></label>
      <label>Related work IDs, separated by commas<input value={references} onChange={e=>{setReferences(e.target.value);change();}} placeholder="PLAT-42, EPIC-12" /></label>
      <label className="wb-review"><input type="checkbox" checked={reviewed} onChange={e=>setReviewed(e.target.checked)}/>I reviewed this exact title, summary, date, project and work references. They are safe for the whole org.</label>
      </fieldset>
      <button className="wb-primary" disabled={busy||!reviewed||!title.trim()||!summary.trim()||shared} onClick={submit}>{busy?'Sharing…':shared?'Shared':'Share reviewed context'}</button>
      {shared && <p role="status">Shared successfully. Your transcript was not sent.</p>}
      <button className="pp-link" disabled={busy} onClick={()=>run(async()=>{await api().workBrainOpen();})}>Open org’s work brain ↗</button>
    </>}
  </div></div>;
}
