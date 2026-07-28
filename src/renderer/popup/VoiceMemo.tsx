import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, fmtTime, useNav } from './nav';

// ── Shared bits ──────────────────────────────────────────────────────────────

export function MicGlyph({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" stroke="none" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
      <path d="M12 18v3" />
    </svg>
  );
}

const KIND_LABEL: Record<string, string> = { task: 'Task', agenda: 'Agenda', note: 'Note' };

function KindPill({ kind }: { kind: string }) {
  return <span className={`vm-kind vm-kind-${kind}`}>{KIND_LABEL[kind] || kind}</span>;
}

interface MeetingCandidate { id: string; title: string; when: string }

function candidateLabel(c: MeetingCandidate): string {
  const d = new Date(c.when);
  if (Number.isNaN(d.getTime())) return c.title;
  return `${c.title} — ${d.toLocaleDateString([], { weekday: 'short' })} ${fmtTime(d)}`;
}

// ── Review item state ────────────────────────────────────────────────────────

interface DedupMatch {
  candidateTaskId: string;
  candidateTitle: string;
  wasDone: boolean;
  confidence: number;
  retrievalScore: number;
  model: string;
}

interface ReviewItem {
  id: number;
  kind: 'task' | 'agenda' | 'note';
  checked: boolean;
  text: string;            // task title / agenda point / note body
  details: string;
  owner: string;
  dueDate: string;         // YYYY-MM-DD or ''
  priority: 'low' | 'medium' | 'high';
  suggestedPriority: 'low' | 'medium' | 'high';
  priorityReason: string | null;
  targetMeetingId: string; // '' = none
  /** Ask-band match found for this spoken task, awaiting a yes/no here. */
  match?: DedupMatch | null;
  /** null = unanswered, 'same'/'reopen' = merge on apply, 'new' = keep separate. */
  matchChoice?: 'same' | 'reopen' | 'new' | null;
}

function toReviewItems(raw: any[]): ReviewItem[] {
  return (raw || []).map((it, i) => ({
    id: i,
    kind: it.kind,
    checked: true,
    text: it.kind === 'task' ? it.title : it.text,
    details: it.details || '',
    owner: it.owner || '',
    dueDate: it.dueDate ? String(it.dueDate).slice(0, 10) : '',
    priority: it.suggestedPriority || 'medium',
    suggestedPriority: it.suggestedPriority || 'medium',
    priorityReason: it.priorityReason || null,
    targetMeetingId: it.targetMeetingId || '',
    match: null,
    matchChoice: null,
  }));
}

// ── Capture → review page ────────────────────────────────────────────────────

type Phase = 'recording' | 'transcribing' | 'sorting' | 'review' | 'error';

const MAX_SECONDS = 300; // whisper time stays bounded; five minutes is a memo, not a meeting

export function VoiceCapturePage() {
  const { pop } = useNav();
  const [phase, setPhase] = useState<Phase>('recording');
  const [seconds, setSeconds] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const [sortNotice, setSortNotice] = useState<string | null>(null);
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [candidates, setCandidates] = useState<MeetingCandidate[]>([]);
  const [people, setPeople] = useState<string[]>([]);
  const [userName, setUserName] = useState('');
  const [applying, setApplying] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef(0);
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);
  const stoppingRef = useRef(false);
  const memoRef = useRef<{ transcript: string; audioPath: string | null; durationSec: number }>({ transcript: '', audioPath: null, durationSec: 0 });

  const cleanupAudio = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    try { recorderRef.current?.state !== 'inactive' && recorderRef.current?.stop(); } catch { /* already stopped */ }
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
  }, []);

  const startCapture = useCallback(async () => {
    setPhase('recording');
    setSeconds(0);
    setErrorMsg('');
    stoppingRef.current = false;
    chunksRef.current = [];
    try {
      const config = await api().getConfig?.().catch(() => ({}));
      const deviceId = config?.micDeviceId;
      const constraint = deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : true;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: constraint as any });
      streamRef.current = stream;

      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        barsRef.current.forEach((bar, i) => {
          if (!bar) return;
          const v = data[Math.floor((i / barsRef.current.length) * data.length)] / 255;
          bar.style.height = `${Math.max(5, Math.round(v * 42))}px`;
        });
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();

      const mr = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      recorderRef.current = mr;
      mr.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.start(250);

      startedAtRef.current = Date.now();
      timerRef.current = setInterval(() => {
        const s = Math.floor((Date.now() - startedAtRef.current) / 1000);
        setSeconds(s);
        if (s >= MAX_SECONDS) finishRecording();
      }, 250);
    } catch (e: any) {
      cleanupAudio();
      setErrorMsg(e?.message || 'Could not access the microphone.');
      setPhase('error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finishRecording = useCallback(async () => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    const durationSec = Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000));
    const mr = recorderRef.current;
    cancelAnimationFrame(rafRef.current);
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    setPhase('transcribing');
    try {
      if (mr && mr.state !== 'inactive') {
        const stopped = new Promise<void>(resolve => { mr.onstop = () => resolve(); });
        mr.stop();
        await stopped;
      }
      streamRef.current?.getTracks().forEach(t => t.stop());
      audioCtxRef.current?.close().catch(() => {});

      // webm/opus → 16 kHz mono 16-bit WAV, the shape whisper.cpp expects.
      const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
      const arrayBuffer = await blob.arrayBuffer();
      const decodeCtx = new AudioContext({ sampleRate: 16000 });
      const decoded = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
      decodeCtx.close();
      const pcm = decoded.getChannelData(0);
      const samples = new Int16Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) {
        samples[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767)));
      }
      const dataLength = samples.length * 2;
      const wav = new ArrayBuffer(44 + dataLength);
      const view = new DataView(wav);
      const write = (off: number, str: string) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
      write(0, 'RIFF'); view.setUint32(4, 36 + dataLength, true);
      write(8, 'WAVE'); write(12, 'fmt '); view.setUint32(16, 16, true);
      view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
      view.setUint16(32, 2, true); view.setUint16(34, 16, true);
      write(36, 'data'); view.setUint32(40, dataLength, true);
      new Int16Array(wav, 44).set(samples);

      const res = await api().transcribeVoiceMemo?.(new Uint8Array(wav), durationSec);
      if (!res?.ok) {
        setErrorMsg(res?.error === 'no_speech'
          ? "Didn't catch any speech — try again a little closer to the mic."
          : `Transcription failed: ${res?.error || 'unknown error'}. Check Settings › Transcription.`);
        setPhase('error');
        return;
      }
      memoRef.current = { transcript: res.transcript, audioPath: res.audioPath || null, durationSec };

      setPhase('sorting');
      const a = api();
      const [calEvents, peopleRows, config] = await Promise.all([
        a.getCalendarEvents?.().catch(() => []) ?? [],
        a.getPeople?.().catch(() => []) ?? [],
        a.getConfig?.().catch(() => ({})) ?? {},
      ]);
      const horizon = Date.now() + 14 * 86400000;
      const cands: MeetingCandidate[] = (calEvents || [])
        .filter((e: any) => {
          const t = new Date(e.startTime).getTime();
          return !Number.isNaN(t) && t > Date.now() - 3600000 && t < horizon;
        })
        .sort((x: any, y: any) => new Date(x.startTime).getTime() - new Date(y.startTime).getTime())
        .slice(0, 20)
        .map((e: any) => ({ id: e.id, title: e.title || e.summary || 'Untitled', when: new Date(e.startTime).toISOString() }));
      const names = (peopleRows || []).map((p: any) => p?.name).filter(Boolean);
      setCandidates(cands);
      setPeople(names);
      setUserName(config?.userName || '');

      const sorted = await a.classifyVoiceMemo?.(res.transcript, {
        userName: config?.userName || '',
        peopleNames: names,
        meetings: cands,
      });
      if (sorted?.ok && sorted.items?.length) {
        const reviewed = toReviewItems(sorted.items);
        setItems(reviewed);
        setSortNotice(null);
        // Ask-band matches ride back with the extracted items so the confirm
        // renders right here rather than as a separate pending record.
        const taskItems = reviewed
          .filter(i => i.kind === 'task')
          .map(i => ({ id: i.id, title: i.text, details: i.details }));
        if (taskItems.length) {
          a.dedupMatchVoiceItems?.(taskItems)
            .then((res: any) => {
              if (!res?.ok || !res.matches?.length) return;
              const byId = new Map<number, DedupMatch>(res.matches.map((m: any) => [m.itemId, m]));
              setItems(list => list.map(i => (byId.has(i.id) ? { ...i, match: byId.get(i.id)! } : i)));
            })
            .catch(() => { /* dedup is best-effort here; apply-time still runs */ });
        }
      } else {
        setItems(toReviewItems([{ kind: 'note', text: res.transcript }]));
        setSortNotice(sorted?.error === 'no_api_key'
          ? 'Connect an AI key in Settings › AI provider and Wiser can sort notes into tasks and agenda points. Kept the whole note for now.'
          : "Wiser couldn't sort this one — kept the whole note so nothing is lost.");
      }
      setPhase('review');
    } catch (e: any) {
      setErrorMsg(e?.message || 'Processing failed.');
      setPhase('error');
    }
  }, []);

  useEffect(() => {
    startCapture();
    return cleanupAudio;
  }, [startCapture, cleanupAudio]);

  const cancel = () => { cleanupAudio(); pop(); };

  const patch = (id: number, p: Partial<ReviewItem>) =>
    setItems(list => list.map(it => (it.id === id ? { ...it, ...p } : it)));

  const checkedCount = items.filter(i => i.checked).length;

  const apply = async () => {
    if (!checkedCount || applying) return;
    setApplying(true);
    try {
      const payload = items.filter(i => i.checked).map(i => {
        if (i.kind === 'task') {
          const merging = i.match && (i.matchChoice === 'same' || i.matchChoice === 'reopen');
          return {
            kind: 'task', title: i.text.trim(), details: i.details,
            owner: i.owner || null, dueDate: i.dueDate || null, priority: i.priority,
            mergeIntoTaskId: merging ? i.match!.candidateTaskId : null,
            reopen: i.matchChoice === 'reopen',
            matchConfidence: i.match?.confidence ?? null,
          };
        }
        if (i.kind === 'agenda') {
          const target = candidates.find(c => c.id === i.targetMeetingId);
          return { kind: 'agenda', text: i.text.trim(), targetMeetingId: i.targetMeetingId || null, targetTitle: target?.title || null };
        }
        return { kind: 'note', text: i.text.trim() };
      }).filter(i => (i as any).title || (i as any).text);
      const res = await api().applyVoiceMemo?.({ ...memoRef.current, items: payload });
      if (res?.ok) pop();
      else {
        setSortNotice(`Couldn't save: ${res?.error || 'unknown error'}`);
        setApplying(false);
      }
    } catch (e: any) {
      setSortNotice(`Couldn't save: ${e?.message || 'unknown error'}`);
      setApplying(false);
    }
  };

  const mmss = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

  // ── Recording / processing states ──
  if (phase !== 'review') {
    return (
      <div className="vm-page">
        <div className="vm-sheethead">
          <div className="vm-sheettitle">Voice note</div>
          <button className="pp-quiet-action" style={{ fontSize: 13 }} onClick={cancel}>Cancel</button>
        </div>
        <div className="vm-wiser">
          <span className="vm-owl">🦉</span>
          <p>Say tasks, agenda points, or stray thoughts in any order — I'll sort them for you to check.</p>
        </div>
        <div className="vm-reczone">
          {phase === 'recording' && (
            <>
              <div className="vm-wave" aria-hidden>
                {Array.from({ length: 12 }, (_, i) => (
                  <span key={i} ref={el => { barsRef.current[i] = el; }} />
                ))}
              </div>
              <div className="vm-timer">{mmss}</div>
              <button className="vm-stop" aria-label="Finish recording" onClick={finishRecording}>
                <span className="vm-stop-square" />
              </button>
              <div className="pp-meta">Tap to finish</div>
            </>
          )}
          {(phase === 'transcribing' || phase === 'sorting') && (
            <>
              <span className="pp-pulse" style={{ width: 14, height: 14 }} />
              <div className="pp-meta" style={{ fontSize: 12.5 }}>
                {phase === 'transcribing' ? 'Transcribing on this computer…' : 'Wiser is sorting what you said…'}
              </div>
            </>
          )}
          {phase === 'error' && (
            <>
              <div className="pp-meta" style={{ fontSize: 12.5, textAlign: 'center', padding: '0 24px', color: 'var(--red)' }}>{errorMsg}</div>
              <div className="pp-row" style={{ gap: 8 }}>
                <button className="pp-btn pp-ghost" onClick={cancel}>Close</button>
                <button className="pp-btn pp-solid" onClick={startCapture}>Try again</button>
              </div>
            </>
          )}
        </div>
        <div className="vm-privacy"><b>Transcribed on this computer.</b> Audio never leaves your machine.</div>
      </div>
    );
  }

  // ── Review state ──
  return (
    <div className="vm-page">
      <div className="vm-sheethead">
        <div className="vm-sheettitle">Here's what I heard</div>
        <button className="pp-quiet-action" style={{ fontSize: 13 }} onClick={cancel}>Back</button>
      </div>
      <div className="vm-review">
        {sortNotice && <div className="pp-banner"><div className="pp-grow pp-banner-text">{sortNotice}</div></div>}
        {items.map(item => {
          // The reason caption belongs to the suggestion; an override replaces it.
          const reason = item.priority === item.suggestedPriority && item.priorityReason
            ? `${item.priority[0].toUpperCase() + item.priority.slice(1)} — ${item.priorityReason.replace(/^(low|medium|high)\s*[—–-]\s*/i, '')}. `
            : '';
          return (
            <div key={item.id} className={`vm-card ${item.checked ? '' : 'vm-dropped'}`}>
              <div className="vm-cardtop">
                <button
                  className={`vm-cbx ${item.checked ? 'vm-on' : ''}`}
                  aria-label={item.checked ? 'Drop this item' : 'Keep this item'}
                  onClick={() => patch(item.id, { checked: !item.checked })}
                >
                  {item.checked ? '✓' : ''}
                </button>
                <KindPill kind={item.kind} />
              </div>
              {item.kind === 'note' ? (
                <textarea
                  className="vm-text"
                  rows={Math.min(4, Math.max(1, Math.ceil(item.text.length / 46)))}
                  value={item.text}
                  onChange={e => patch(item.id, { text: e.target.value })}
                />
              ) : (
                <input className="vm-text" value={item.text} onChange={e => patch(item.id, { text: e.target.value })} />
              )}
              {item.kind === 'task' && (
                <>
                  <div className="vm-fields">
                    <select
                      className="vm-select"
                      value={item.owner}
                      onChange={e => patch(item.id, { owner: e.target.value })}
                    >
                      <option value="">Owner: unassigned</option>
                      {userName && <option value={userName}>{userName} (me)</option>}
                      {people.filter(n => n !== userName).map(n => <option key={n} value={n}>{n}</option>)}
                      {item.owner && item.owner !== userName && !people.includes(item.owner) && (
                        <option value={item.owner}>{item.owner}</option>
                      )}
                    </select>
                    <input
                      type="date"
                      className="vm-select vm-slim"
                      value={item.dueDate}
                      onChange={e => patch(item.id, { dueDate: e.target.value })}
                    />
                  </div>
                  <div className="vm-prio" role="group" aria-label="Priority">
                    {(['low', 'medium', 'high'] as const).map(p => (
                      <button
                        key={p}
                        className={item.priority === p ? 'vm-on' : ''}
                        onClick={() => patch(item.id, { priority: p })}
                      >
                        {p === 'medium' ? 'Med' : p[0].toUpperCase() + p.slice(1)}
                      </button>
                    ))}
                  </div>
                  {item.match && (
                    <div
                      className="pp-card"
                      style={{ marginTop: 8, padding: '9px 11px' }}
                      data-testid="vm-dedup-confirm"
                    >
                      <div className="pp-row" style={{ gap: 6 }}>
                        <span className={`pp-chip ${item.match.wasDone ? 'pp-amber' : 'pp-teal'}`}>
                          {item.match.wasDone ? 'This looks done' : 'Might be the same task'}
                        </span>
                        <span className="pp-grow" />
                        <span className="pp-meta">{Math.round(item.match.confidence)}% sure</span>
                      </div>
                      <div className="pp-title-sm" style={{ fontSize: 12.5, marginTop: 5 }}>
                        {item.match.candidateTitle}
                      </div>
                      <div className="pp-row" style={{ marginTop: 8, gap: 8 }}>
                        <button
                          className={`pp-btn ${item.matchChoice === 'same' || item.matchChoice === 'reopen' ? 'pp-solid' : 'pp-ghost'}`}
                          style={{ flex: 1, padding: '5px 0' }}
                          onClick={() => patch(item.id, { matchChoice: item.match!.wasDone ? 'reopen' : 'same' })}
                        >
                          {item.match.wasDone ? 'Reopen and merge' : 'Same task'}
                        </button>
                        <button
                          className={`pp-btn ${item.matchChoice === 'new' ? 'pp-solid' : 'pp-ghost'}`}
                          style={{ flex: 1, padding: '5px 0' }}
                          onClick={() => patch(item.id, { matchChoice: 'new' })}
                        >
                          {item.match.wasDone ? 'Start a new task' : 'New task'}
                        </button>
                      </div>
                      <div className="pp-meta" style={{ marginTop: 7, fontSize: 11 }}>
                        Matched using your key · {item.match.model}
                      </div>
                    </div>
                  )}
                  <div className="vm-fate">
                    {reason}
                    {item.match && (item.matchChoice === 'same' || item.matchChoice === 'reopen')
                      ? `Joins “${item.match.candidateTitle}” instead of making a second card.`
                      : 'Goes to your Tasks tab.'}
                  </div>
                </>
              )}
              {item.kind === 'agenda' && (
                <>
                  <div className="vm-fields">
                    <select
                      className="vm-select"
                      value={item.targetMeetingId}
                      onChange={e => patch(item.id, { targetMeetingId: e.target.value })}
                    >
                      <option value="">No meeting — keep as a note</option>
                      {candidates.map(c => <option key={c.id} value={c.id}>{candidateLabel(c)}</option>)}
                    </select>
                  </div>
                  <div className="vm-fate">
                    {item.targetMeetingId
                      ? "Added to that meeting's agenda card."
                      : 'No meeting picked — kept as a note with this memo.'}
                  </div>
                </>
              )}
              {item.kind === 'note' && (
                <div className="vm-fate">Kept with this memo — it lists in Meetings under today. Stays on this machine.</div>
              )}
            </div>
          );
        })}
      </div>
      <div className="vm-cta">
        <button className="pp-btn pp-ghost" onClick={cancel} disabled={applying}>Discard</button>
        <button className="pp-btn pp-solid" style={{ flex: 1 }} onClick={apply} disabled={!checkedCount || applying}>
          {applying ? 'Adding…' : `Add ${checkedCount} item${checkedCount === 1 ? '' : 's'}`}
        </button>
      </div>
      <div className="vm-privacy"><b>Sorted with your own AI key.</b> Only the transcript text was sent, never audio.</div>
    </div>
  );
}

// ── Memo detail (the timeline row doubles as the transcript viewer) ──────────

export function VoiceMemoDetailPage({ memoId }: { memoId: string }) {
  const { pop } = useNav();
  const [memo, setMemo] = useState<any | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api().getMeeting?.(memoId)
      .then((m: any) => setMemo(m || null))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [memoId]);

  const when = memo ? new Date(memo.date) : null;
  const items: any[] = memo?.voiceMemo?.items || [];

  return (
    <>
      <div className="pp-drillhead">
        <button className="pp-back" aria-label="Back" onClick={pop}>‹</button>
        <div className="pp-drilltitle">Voice note</div>
        <span />
      </div>
      <div className="pp-body">
        {loaded && !memo && <div className="pp-meta" style={{ textAlign: 'center', padding: '24px 0' }}>This voice note is gone.</div>}
        {memo && (
          <>
            <div className="pp-meta" style={{ padding: '0 2px' }}>
              {when && !Number.isNaN(when.getTime()) ? `${when.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })} · ${fmtTime(when)}` : ''}
              {memo.duration ? ` · ${Math.max(1, Math.round(memo.duration / 60))} min` : ''}
            </div>
            {items.length > 0 && (
              <>
                <div className="pp-seclabel">What was added</div>
                {items.map((it, i) => (
                  <div key={i} className="pp-card" style={{ padding: '10px 12px' }}>
                    <div className="pp-row" style={{ alignItems: 'flex-start' }}>
                      <KindPill kind={it.kind} />
                      <div className="pp-grow">
                        <div className="pp-title-sm">{it.kind === 'task' ? it.title : it.text}</div>
                        <div className="pp-meta" style={{ marginTop: 2 }}>
                          {it.kind === 'task' && [
                            it.owner ? `Owner: ${it.owner}` : null,
                            it.dueDate ? `Due ${new Date(it.dueDate).toLocaleDateString([], { month: 'short', day: 'numeric' })}` : null,
                            it.priority ? `${it.priority[0].toUpperCase() + it.priority.slice(1)} priority` : null,
                          ].filter(Boolean).join(' · ')}
                          {it.kind === 'agenda' && (it.targetTitle ? `Agenda for ${it.targetTitle}` : 'Agenda item')}
                          {it.kind === 'note' && 'Kept with this memo'}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </>
            )}
            <div className="pp-seclabel">Transcript</div>
            <div className="pp-card" style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--slate-700)', whiteSpace: 'pre-wrap' }}>
              {memo.transcript || 'No transcript.'}
            </div>
            <div className="pp-meta" style={{ textAlign: 'center', padding: '4px 0 8px' }}>
              Recorded and transcribed on this computer.
            </div>
          </>
        )}
      </div>
    </>
  );
}
