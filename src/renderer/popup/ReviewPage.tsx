import React, { useEffect, useRef, useState } from 'react';
import { api, useNav } from './nav';
import { useReview } from './PopupShell';
import type { ApprovalItem, UnknownVoiceItem } from './useReviewItems';

const DISMISSED_SUGGESTIONS_KEY = 'pp-dismissed-suggested-people';

function loadDismissed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(DISMISSED_SUGGESTIONS_KEY) || '[]'));
  } catch {
    return new Set();
  }
}
function saveDismissed(s: Set<string>) {
  localStorage.setItem(DISMISSED_SUGGESTIONS_KEY, JSON.stringify([...s]));
}

// ── Approval card ────────────────────────────────────────────────────────────

function describeApproval(row: ApprovalItem): { chip: string; title: string; detail: string } {
  const pp = row.pending.pushParams;
  switch (pp.operation) {
    case 'create':
      return { chip: 'Jira · new task', title: `Create: "${pp.args.title}"`, detail: pp.args.description || '' };
    case 'update':
      return { chip: `Jira · update ${pp.args.issueKey}`, title: pp.args.updates.title || `Update ${pp.args.issueKey}`, detail: pp.args.updates.description || '' };
    case 'transition':
      return { chip: `Jira · ${pp.args.issueKey}`, title: `Move to ${pp.args.targetStatus}`, detail: '' };
    case 'comment':
      return { chip: `Jira · comment on ${pp.args.issueKey}`, title: 'Add comment', detail: pp.args.comment };
    default:
      return { chip: 'Jira', title: 'Pending write', detail: '' };
  }
}

function ApprovalCard({ row, onDone }: { row: ApprovalItem; onDone: () => void }) {
  const d = describeApproval(row);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [busy, setBusy] = useState(false);
  const pp = row.pending.pushParams;
  const editable = pp.operation === 'create' || pp.operation === 'comment';

  const startEdit = () => {
    setEditText(pp.operation === 'create' ? pp.args.title : pp.operation === 'comment' ? pp.args.comment : '');
    setEditing(true);
  };

  const act = async (fn: () => Promise<any>) => {
    setBusy(true);
    try { await fn(); onDone(); } finally { setBusy(false); }
  };

  const approve = () => act(() => api().sorApprove?.(row.pending._id));
  const approveEdited = () => act(() => {
    const overrides =
      pp.operation === 'create' ? { title: editText } :
      pp.operation === 'comment' ? { comment: editText } : {};
    return api().sorApprove?.(row.pending._id, overrides);
  });
  const reject = () => act(() => api().sorReject?.(row.pending._id));

  return (
    <div className="pp-card">
      <div className="pp-row" style={{ marginBottom: 6 }}>
        <span className="pp-chip pp-teal">{d.chip}</span>
        <span className="pp-grow" />
        {row.pending.meetingTitle && <span className="pp-meta">{row.pending.meetingTitle}</span>}
      </div>
      {editing ? (
        <div className="pp-search">
          <input autoFocus value={editText} onChange={e => setEditText(e.target.value)} />
        </div>
      ) : (
        <>
          <div className="pp-title-sm">{d.title}</div>
          {d.detail && (
            <div className="pp-meta" style={{ marginTop: 4, lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
              {d.detail}
            </div>
          )}
        </>
      )}
      <div className="pp-row" style={{ marginTop: 9, gap: 8 }}>
        {editing ? (
          <>
            <button className="pp-btn pp-solid" style={{ flex: 1, padding: '6px 0' }} disabled={busy || !editText.trim()} onClick={approveEdited}>
              Approve edited
            </button>
            <button className="pp-btn pp-ghost" style={{ flex: 1, padding: '6px 0' }} onClick={() => setEditing(false)}>Back</button>
          </>
        ) : (
          <>
            <button className="pp-btn pp-solid" style={{ flex: 1, padding: '6px 0' }} disabled={busy} onClick={approve}>Approve</button>
            {editable && <button className="pp-btn pp-ghost" style={{ flex: 1, padding: '6px 0' }} disabled={busy} onClick={startEdit}>Edit</button>}
            <button className="pp-btn pp-ghost pp-danger" style={{ flex: 1, padding: '6px 0' }} disabled={busy} onClick={reject}>Reject</button>
          </>
        )}
      </div>
    </div>
  );
}

// ── Unknown-voice card ───────────────────────────────────────────────────────

function UnknownVoiceCard({ voice, onDone }: { voice: UnknownVoiceItem; onDone: () => void }) {
  const [playing, setPlaying] = useState(false);
  const [customName, setCustomName] = useState('');
  const [naming, setNaming] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const play = async () => {
    if (playing) {
      audioRef.current?.pause();
      setPlaying(false);
      return;
    }
    try {
      const raw = await api().getVoicePrintAudio?.(voice._id);
      const bytes = raw?.data ? new Uint8Array(raw.data) : new Uint8Array(raw);
      const blob = new Blob([bytes], { type: 'audio/wav' });
      const audio = new Audio(URL.createObjectURL(blob));
      audioRef.current = audio;
      audio.onended = () => setPlaying(false);
      await audio.play();
      setPlaying(true);
    } catch {
      setPlaying(false);
    }
  };

  const assign = async (name: string) => {
    const clean = name.trim();
    if (!clean) return;
    audioRef.current?.pause();
    await api().renameVoicePrint?.(voice._id, clean);
    await api().addTrackedPeople?.([clean]).catch(() => {});
    onDone();
  };

  const dismiss = async () => {
    audioRef.current?.pause();
    await api().deleteVoicePrint?.(voice._id);
    onDone();
  };

  return (
    <div className="pp-card">
      <div className="pp-row" style={{ marginBottom: 6 }}>
        <span className="pp-chip pp-teal">Unknown voice</span>
        <span className="pp-grow" />
        <span className="pp-meta">{new Date(voice.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
      </div>
      <div className="pp-row">
        {voice.hasAudio && (
          <button className="pp-btn pp-ghost" style={{ padding: '6px 12px' }} onClick={play}>
            {playing ? '■ Stop' : '▶ Play clip'}
          </button>
        )}
        <div className="pp-grow pp-meta" style={{ lineHeight: 1.4 }}>
          Heard on a call{voice.candidates.length ? ` — likely one of: ${voice.candidates.join(', ')}` : ''}. Who is this?
        </div>
      </div>
      <div className="pp-row" style={{ gap: 6, marginTop: 9, flexWrap: 'wrap' }}>
        {voice.candidates.map(name => (
          <button key={name} className="pp-chip pp-teal" onClick={() => assign(name)}>{name}</button>
        ))}
        {naming ? (
          <span className="pp-search" style={{ flex: 1, minWidth: 120, padding: '4px 8px' }}>
            <input
              autoFocus
              placeholder="Type a name — Enter"
              value={customName}
              onChange={e => setCustomName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') assign(customName);
                if (e.key === 'Escape') setNaming(false);
              }}
            />
          </span>
        ) : (
          <button className="pp-chip" onClick={() => setNaming(true)}>Someone else…</button>
        )}
        <span className="pp-grow" />
        <button className="pp-quiet-action" onClick={dismiss}>Dismiss</button>
      </div>
    </div>
  );
}

// ── Review page ──────────────────────────────────────────────────────────────

export default function ReviewPage({ focus }: { focus?: 'approvals' | 'priorities' | 'people' | 'voices' }) {
  const { pop } = useNav();
  const review = useReview();
  const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<string>>(loadDismissed);
  const [prioritiesExpanded, setPrioritiesExpanded] = useState(false);
  const [prioritiesAccepted, setPrioritiesAccepted] = useState(false);
  const sectionRefs = {
    approvals: useRef<HTMLDivElement>(null),
    priorities: useRef<HTMLDivElement>(null),
    people: useRef<HTMLDivElement>(null),
    voices: useRef<HTMLDivElement>(null),
  };

  useEffect(() => {
    if (focus && review.loaded) {
      sectionRefs[focus]?.current?.scrollIntoView({ block: 'start' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, review.loaded]);

  const suggested = review.suggested.filter(s => !dismissedSuggestions.has(s.name));
  const topScored = review.scoredTasks.slice(0, prioritiesExpanded ? 10 : 3);
  const showPriorities = review.scoredTasks.length >= 2 && !prioritiesAccepted;

  const dismissSuggestion = (name: string) => {
    const next = new Set(dismissedSuggestions);
    next.add(name);
    setDismissedSuggestions(next);
    saveDismissed(next);
  };

  const addSuggested = async (name: string) => {
    await api().addTrackedPeople?.([name]);
    review.reload();
  };

  const bumpPriority = async (taskId: string, dir: 'up' | 'down') => {
    const order = ['low', 'medium', 'high', 'critical'];
    const all = await api().getTasks?.();
    const t = (all || []).find((x: any) => x._id === taskId);
    if (!t) return;
    const idx = Math.max(0, order.indexOf(t.priority || 'medium'));
    const next = order[Math.min(order.length - 1, Math.max(0, idx + (dir === 'up' ? 1 : -1)))];
    await api().updateTask?.(taskId, { priority: next });
    review.reload();
  };

  const total = review.approvals.length + suggested.length + review.unknownVoices.length;
  const empty = review.loaded && total === 0 && !showPriorities;

  return (
    <>
      <div className="pp-drillhead">
        <button className="pp-back" aria-label="Back" onClick={pop}>←</button>
        <div className="pp-drilltitle">Review{total > 0 ? ` (${total})` : ''}</div>
        <span />
      </div>
      <div className="pp-body" style={{ paddingTop: 4 }}>
        {empty && (
          <div className="pp-empty">
            <div className="pp-empty-art">
              <span className="pp-blob1" /><span className="pp-blob2" />
              <span className="pp-glyph">✓</span>
            </div>
            <h3>All clear</h3>
            <span className="pp-meta">Nothing waiting for your review.</span>
          </div>
        )}

        {review.approvals.length > 0 && (
          <div ref={sectionRefs.approvals} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="pp-seclabel">Waiting to sync — approve first</div>
            {review.approvals.map(row => (
              <ApprovalCard key={row.pending._id} row={row} onDone={review.reload} />
            ))}
          </div>
        )}

        {showPriorities && (
          <div ref={sectionRefs.priorities} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="pp-seclabel">Today's priority order</div>
            <div className="pp-card">
              {topScored.map((t, i) => (
                <div key={t._id} className="pp-row" style={{ padding: '5px 0', alignItems: 'flex-start' }}>
                  <b style={{ color: 'var(--navy)', fontSize: 12.5, width: 16, flex: 'none' }}>{i + 1}</b>
                  <div className="pp-grow">
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--navy)', lineHeight: 1.35 }}>{t.title}</div>
                    {t.priorityReasoning && <div className="pp-meta" style={{ lineHeight: 1.4 }}>{t.priorityReasoning}</div>}
                  </div>
                  {prioritiesExpanded && (
                    <span className="pp-row" style={{ gap: 2, flex: 'none' }}>
                      <button className="pp-quiet-action" title="Raise priority" onClick={() => bumpPriority(t._id, 'up')}>▲</button>
                      <button className="pp-quiet-action" title="Lower priority" onClick={() => bumpPriority(t._id, 'down')}>▼</button>
                    </span>
                  )}
                </div>
              ))}
              <div className="pp-row" style={{ marginTop: 9, gap: 8 }}>
                <button className="pp-btn pp-solid" style={{ flex: 1, padding: '6px 0' }} onClick={() => setPrioritiesAccepted(true)}>
                  Accept order
                </button>
                <button className="pp-btn pp-ghost" style={{ flex: 1, padding: '6px 0' }} onClick={() => setPrioritiesExpanded(e => !e)}>
                  {prioritiesExpanded ? 'Collapse' : 'Adjust'}
                </button>
              </div>
            </div>
          </div>
        )}

        {suggested.length > 0 && (
          <div ref={sectionRefs.people} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="pp-seclabel">People the AI keeps hearing</div>
            {suggested.map(s => (
              <div key={s.name} className="pp-card">
                <div className="pp-row" style={{ marginBottom: 6 }}>
                  <span className="pp-chip pp-teal">New person</span>
                  <span className="pp-grow" />
                  <span className="pp-meta">{s.meetingCount} meeting{s.meetingCount === 1 ? '' : 's'}</span>
                </div>
                <div className="pp-row">
                  <div className="pp-grow">
                    <div className="pp-title-sm">{s.name}</div>
                    {s.recentMeetings?.[0] && (
                      <div className="pp-meta" style={{ marginTop: 2 }}>Recently in "{s.recentMeetings[0].title}"</div>
                    )}
                  </div>
                  <button className="pp-link" onClick={() => addSuggested(s.name)}>Add</button>
                  <button className="pp-quiet-action" onClick={() => dismissSuggestion(s.name)}>Dismiss</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {review.unknownVoices.length > 0 && (
          <div ref={sectionRefs.voices} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="pp-seclabel">Unknown voices</div>
            {review.unknownVoices.map(v => (
              <UnknownVoiceCard key={v._id} voice={v} onDone={review.reload} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
