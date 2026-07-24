import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, fmtTime, sameDay, useNav } from './nav';
import { useReview } from './PopupShell';
import TranscriptUploadModal from '../views/communications/TranscriptUploadModal';

interface MeetingRow {
  _id: string;
  title: string;
  date: string | number;
  attendees: string[];
  hasInsights: boolean;
  actionItemCount: number;
  status: string;
  source: 'db' | 'calendar';
  calendarEventId?: string;
  durationMin?: number;
}

interface LiveEvent { id: string; title: string; attendees?: string[] }

interface Briefing {
  greeting?: string;
  topTasks?: Array<{ title: string }>;
  overdueCommitments?: Array<{ text?: string; who?: string }>;
  totalTasks?: number;
}

// ── Pre-record bottom sheet ──────────────────────────────────────────────────

function RecordSheet({ liveEvent, onClose, onStarted }: {
  liveEvent: LiveEvent | null;
  onClose: () => void;
  onStarted: () => void;
}) {
  const [title, setTitle] = useState('');
  const [linkedEvent, setLinkedEvent] = useState<LiveEvent | null>(liveEvent);
  const [people, setPeople] = useState<Array<{ _id: string; name: string }>>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [audioOk, setAudioOk] = useState<boolean | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    api().getPeople?.().then((rows: any[]) => {
      setPeople((rows || []).filter(p => p?.name).slice(0, 8).map(p => ({ _id: p._id, name: p.name })));
    }).catch(() => {});
    api().getAudioHealth?.().then((h: any) => {
      if (h && typeof h === 'object') setAudioOk(!(h.micSilent || h.systemSilent || h.error));
    }).catch(() => setAudioOk(null));
  }, []);

  const togglePerson = (name: string) =>
    setChosen(c => (c.includes(name) ? c.filter(n => n !== name) : [...c, name]));

  const start = async () => {
    setStarting(true);
    const finalTitle =
      (linkedEvent ? linkedEvent.title : title.trim()) ||
      (chosen.length ? `Meeting with ${chosen.join(', ')}` : 'Recorded conversation');
    try {
      await api().startRecording?.(finalTitle, linkedEvent?.id);
      onStarted();
    } finally {
      setStarting(false);
      onClose();
    }
  };

  return (
    <>
      <div className="pp-sheet-backdrop" onClick={onClose} />
      <div className="pp-sheet" role="dialog" aria-label="Record a meeting">
        <div className="pp-sheet-handle" />
        <div className="pp-title-sm" style={{ fontSize: 15 }}>Record a meeting</div>

        {liveEvent && (
          <div className="pp-banner">
            <div className="pp-grow pp-banner-text">Looks like: {liveEvent.title}</div>
            {linkedEvent ? (
              <button className="pp-link" onClick={() => setLinkedEvent(null)}>Unlink</button>
            ) : (
              <button className="pp-link" onClick={() => setLinkedEvent(liveEvent)}>Link it</button>
            )}
          </div>
        )}

        {!linkedEvent && (
          <div className="pp-search">
            <input
              autoFocus
              placeholder="What is this meeting about?"
              value={title}
              onChange={e => setTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') start(); }}
            />
          </div>
        )}

        {people.length > 0 && (
          <div>
            <div className="pp-seclabel" style={{ paddingLeft: 2 }}>Who's this with? (optional)</div>
            <div className="pp-row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
              {people.map(p => (
                <button
                  key={p._id}
                  className={`pp-chip ${chosen.includes(p.name) ? 'pp-teal' : ''}`}
                  onClick={() => togglePerson(p.name)}
                >
                  {chosen.includes(p.name) ? `${p.name} ✕` : `+ ${p.name}`}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="pp-row" style={{ gap: 8, marginTop: 4 }}>
          <button className="pp-btn pp-ghost" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
          <button className="pp-btn pp-solid" style={{ flex: 2 }} onClick={start} disabled={starting}>
            ● {starting ? 'Starting…' : 'Start recording'}
          </button>
        </div>

        {audioOk !== null && (
          <div className="pp-row" style={{ justifyContent: 'center', gap: 6 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: audioOk ? 'var(--green)' : 'var(--amber)', flex: 'none' }} />
            <span className="pp-meta">{audioOk ? 'Mic and system audio healthy' : 'Audio needs attention — check Settings'}</span>
          </div>
        )}
      </div>
    </>
  );
}

// ── Meetings tab ─────────────────────────────────────────────────────────────

export default function MeetingsTab() {
  const { push } = useNav();
  const review = useReview();
  const [meetings, setMeetings] = useState<MeetingRow[]>([]);
  const [calendarConnected, setCalendarConnected] = useState(true);
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [briefingDismissed, setBriefingDismissed] = useState(false);
  const [selectedDay, setSelectedDay] = useState<Date>(new Date());
  const [liveEvent, setLiveEvent] = useState<LiveEvent | null>(null);
  const [liveDismissed, setLiveDismissed] = useState(false);
  const [recording, setRecording] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    try {
      const a = api();
      const [dbMeetings, calEvents, config, calendars] = await Promise.all([
        a.getMeetings?.() ?? [],
        a.getCalendarEvents?.() ?? [],
        a.getConfig?.() ?? {},
        a.listCalendars?.().catch(() => []) ?? [],
      ]);

      const anyCalendar =
        (Array.isArray(calendars) && calendars.some((c: any) => c.enabled !== false)) ||
        !!(config?.googleIcsUrl || config?.outlookIcsUrl);
      setCalendarConnected(anyCalendar);

      const fromDb: MeetingRow[] = (dbMeetings || []).map((m: any) => ({
        _id: m._id || m.id,
        title: m.title,
        date: m.date,
        attendees: m.attendees || [],
        hasInsights: !!(m.insights?.summary || m.insights?.actionItems?.length),
        actionItemCount: m.insights?.actionItems?.length || 0,
        status: m.status,
        source: 'db' as const,
        calendarEventId: m.calendarEventId,
        durationMin: m.duration ? Math.round(m.duration / 60) : undefined,
      }));

      const dbCalIds = new Set(fromDb.map(m => m.calendarEventId).filter(Boolean));
      const fromCal: MeetingRow[] = (calEvents || [])
        .filter((e: any) => !dbCalIds.has(e.id))
        .map((e: any) => ({
          _id: e.id,
          title: e.title || e.summary || 'Untitled',
          date: e.startTime,
          attendees: e.attendees || [],
          hasInsights: false,
          actionItemCount: 0,
          status: 'pending',
          source: 'calendar' as const,
        }));

      setMeetings([...fromDb, ...fromCal]);
    } catch { /* keep whatever we had */ }
    finally { setLoaded(true); }
  }, []);

  useEffect(() => {
    reload();
    const a = api();
    a.getBriefing?.().then((b: any) => { if (b) setBriefing(b); }).catch(() => {});
    a.welcomeBackLiveMeeting?.().then((m: any) => { if (m) setLiveEvent({ id: m.id, title: m.title }); }).catch(() => {});

    const onStatus = (p: any) => {
      if (p?.status === 'recording' || p?.status === 'processing') setRecording(p.status === 'recording');
      if (p?.status === 'done' || p?.status === 'error') { setRecording(false); reload(); }
    };
    const onNew = () => reload();
    a.on?.('recording:status', onStatus);
    a.on?.('meeting:new', onNew);
    a.on?.('calendar:events', onNew);
    return () => {
      a.off?.('recording:status', onStatus);
      a.off?.('meeting:new', onNew);
      a.off?.('calendar:events', onNew);
    };
  }, [reload]);

  const week = useMemo(() => {
    const days: Date[] = [];
    const today = new Date();
    const monday = new Date(today);
    monday.setDate(today.getDate() - ((today.getDay() + 6) % 7)); // Monday of this week
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      days.push(d);
    }
    return days;
  }, []);

  const meetingsWithDates = useMemo(
    () => meetings
      .map(m => ({ ...m, when: new Date(m.date) }))
      .filter(m => !Number.isNaN(m.when.getTime())),
    [meetings],
  );

  const dayHasMeetings = (d: Date) => meetingsWithDates.some(m => sameDay(m.when, d));
  const dayMeetings = meetingsWithDates
    .filter(m => sameDay(m.when, selectedDay))
    .sort((a, b) => a.when.getTime() - b.when.getTime());

  const isToday = sameDay(selectedDay, new Date());
  const pendingByMeetingTitle = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of review.approvals) {
      const t = row.pending.meetingTitle;
      if (t) map.set(t, (map.get(t) || 0) + 1);
    }
    return map;
  }, [review.approvals]);

  const handleUpload = async (data: { title: string; content: string; date: string }) => {
    await api().createMeetingFromTranscript?.(data);
    reload();
  };

  if (loaded && !calendarConnected && meetingsWithDates.length === 0) {
    return (
      <div className="pp-body">
        <div className="pp-empty">
          <div className="pp-empty-art">
            <span className="pp-blob1" /><span className="pp-blob2" />
            <span className="pp-glyph">✕</span>
          </div>
          <h3>Calendar is not connected</h3>
          <button
            className="pp-link"
            style={{ fontSize: 13 }}
            onClick={() => push({ kind: 'settings-section', section: 'calendar', title: 'Calendar' })}
          >
            Connect now
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="pp-body">
      <div className="pp-datestrip">
        {week.map(d => {
          const selected = sameDay(d, selectedDay);
          return (
            <button key={d.toDateString()} className={`pp-day ${selected ? 'pp-selected' : ''}`} onClick={() => setSelectedDay(d)}>
              <span className="pp-dow">{d.toLocaleDateString([], { weekday: 'short' })}</span>
              <span className="pp-dom">{d.getDate()}</span>
              <span className={`pp-dot ${dayHasMeetings(d) ? '' : 'pp-off'}`} />
            </button>
          );
        })}
      </div>

      {briefing && !briefingDismissed && ((briefing.topTasks?.length || 0) > 0 || (briefing.overdueCommitments?.length || 0) > 0) && (
        <div className="pp-card" style={{ background: 'var(--pp-teal-tint)', borderColor: 'var(--pp-teal-line)' }}>
          <div className="pp-row">
            <div className="pp-grow">
              <div className="pp-title-sm">{briefing.greeting || 'Morning briefing'}</div>
              <div className="pp-meta" style={{ marginTop: 2 }}>
                {[
                  briefing.topTasks?.length ? `${briefing.topTasks.length} top task${briefing.topTasks.length === 1 ? '' : 's'} today` : null,
                  briefing.overdueCommitments?.length ? `${briefing.overdueCommitments.length} overdue commitment${briefing.overdueCommitments.length === 1 ? '' : 's'}` : null,
                  review.count > 0 ? `${review.count} to review` : null,
                ].filter(Boolean).join(' · ')}
              </div>
            </div>
            <button className="pp-quiet-action" aria-label="Dismiss briefing" onClick={() => setBriefingDismissed(true)}>✕</button>
          </div>
        </div>
      )}

      <div className="pp-row" style={{ justifyContent: 'space-between' }}>
        <span className="pp-seclabel" style={{ padding: '0 4px' }}>
          {isToday ? 'Today' : selectedDay.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}
        </span>
        <span className="pp-row" style={{ gap: 8 }}>
          <button className="pp-btn pp-ghost" style={{ padding: '6px 12px' }} onClick={() => setUploadOpen(true)}>Upload</button>
          {recording ? (
            <button className="pp-btn pp-solid" style={{ padding: '6px 12px', background: 'var(--red)' }} onClick={() => api().stopRecording?.()}>
              ■ Stop
            </button>
          ) : (
            <button className="pp-btn pp-solid record-btn" style={{ padding: '6px 12px' }} onClick={() => setSheetOpen(true)}>
              ● Record
            </button>
          )}
        </span>
      </div>

      {liveEvent && !liveDismissed && !recording && (
        <div className="pp-banner">
          <span className="pp-recdot" />
          <div className="pp-grow pp-banner-text">{liveEvent.title} looks live — start recording?</div>
          <button className="pp-link" onClick={async () => {
            await api().startRecording?.(liveEvent.title, liveEvent.id);
            setLiveDismissed(true);
          }}>Start</button>
          <button className="pp-quiet-action" aria-label="Dismiss" onClick={() => setLiveDismissed(true)}>✕</button>
        </div>
      )}

      {dayMeetings.length === 0 && loaded && (
        <div className="pp-meta" style={{ textAlign: 'center', padding: '28px 0' }}>
          No meetings {isToday ? 'today' : 'this day'}.
        </div>
      )}

      {dayMeetings.map(m => {
        const pendingCount = pendingByMeetingTitle.get(m.title) || 0;
        const clickable = m.source === 'db';
        return (
          <div
            key={m._id}
            className={`pp-card meeting-card ${clickable ? 'pp-clickable' : ''}`}
            onClick={clickable ? () => push({ kind: 'meeting', id: m._id, title: m.title }) : undefined}
            role={clickable ? 'button' : undefined}
          >
            <div className="pp-row">
              <div className="pp-timecol">
                {fmtTime(m.when)}
                {m.durationMin ? <><br />{m.durationMin}m</> : null}
              </div>
              <div className="pp-grow">
                <div className="pp-title-sm">{m.title}</div>
                <div className="pp-meta" style={{ marginTop: 3, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {m.source === 'db' && m.hasInsights && <span className="pp-chip pp-teal">Recorded</span>}
                  {m.source === 'db' && !m.hasInsights && <span className="pp-chip">{m.status === 'recording' ? 'Recording…' : 'Processing'}</span>}
                  {m.actionItemCount > 0 && <span className="pp-chip">{m.actionItemCount} action item{m.actionItemCount === 1 ? '' : 's'}</span>}
                  {pendingCount > 0 && (
                    <button
                      className="pp-chip pp-amber"
                      onClick={e => { e.stopPropagation(); push({ kind: 'review', focus: 'approvals' }); }}
                    >
                      {pendingCount} approval{pendingCount === 1 ? '' : 's'} waiting
                    </button>
                  )}
                  {m.source === 'calendar' && <span style={{ fontSize: 11.5 }}>Not started · will auto-join</span>}
                </div>
              </div>
              {clickable && <span className="pp-chevron">›</span>}
            </div>
          </div>
        );
      })}

      {sheetOpen && (
        <RecordSheet
          liveEvent={liveEvent}
          onClose={() => setSheetOpen(false)}
          onStarted={() => setRecording(true)}
        />
      )}

      <TranscriptUploadModal isOpen={uploadOpen} onClose={() => setUploadOpen(false)} onUpload={handleUpload} />
    </div>
  );
}
