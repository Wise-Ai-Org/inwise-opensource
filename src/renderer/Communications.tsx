import React, { useState, useEffect } from 'react';

interface Meeting {
  id: string;
  title: string;
  date: string;
  duration: number;
  status: string;
  summary?: string;
  transcript?: string;
  action_item_count?: number;
  blocker_count?: number;
  decision_count?: number;
  actionItems?: any[];
  decisions?: any[];
  blockers?: any[];
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function formatDuration(seconds: number) {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function MeetingDetail({ meeting, onClose }: { meeting: Meeting; onClose: () => void }) {
  return (
    <div className="detail-panel">
      <div className="detail-header">
        <div>
          <div className="detail-title">{meeting.title}</div>
          <div className="detail-date">{formatDate(meeting.date)} · {formatDuration(meeting.duration)}</div>
        </div>
        <button className="detail-close" onClick={onClose}>✕</button>
      </div>
      <div className="detail-body">
        {meeting.summary && (
          <div>
            <div className="section-title">Summary</div>
            <div className="summary-text">{meeting.summary}</div>
          </div>
        )}

        {meeting.actionItems && meeting.actionItems.length > 0 && (
          <div>
            <div className="section-title">Action Items ({meeting.actionItems.length})</div>
            <div className="item-list">
              {meeting.actionItems.map((item: any) => (
                <div key={item.id} className="item-row">
                  <div className="item-row-dot" />
                  <div>
                    <div>{item.text}</div>
                    {(item.owner || item.due_date) && (
                      <div style={{ marginTop: 2, fontSize: 11, color: 'var(--slate-500)' }}>
                        {item.owner && <span>{item.owner}</span>}
                        {item.owner && item.due_date && <span> · </span>}
                        {item.due_date && <span>Due {item.due_date}</span>}
                      </div>
                    )}
                  </div>
                  <span className={`badge badge-${item.priority === 'high' ? 'red' : item.priority === 'low' ? 'teal' : 'amber'}`} style={{ marginLeft: 'auto', flexShrink: 0 }}>
                    {item.priority}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {meeting.decisions && meeting.decisions.length > 0 && (
          <div>
            <div className="section-title">Decisions ({meeting.decisions.length})</div>
            <div className="item-list">
              {meeting.decisions.map((d: any) => (
                <div key={d.id} className="item-row">
                  <div className="item-row-dot" style={{ background: 'var(--teal-light)' }} />
                  <div>
                    <div>{d.text}</div>
                    {d.rationale && <div style={{ fontSize: 12, color: 'var(--slate-500)', marginTop: 2 }}>{d.rationale}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {meeting.blockers && meeting.blockers.length > 0 && (
          <div>
            <div className="section-title">Blockers ({meeting.blockers.length})</div>
            <div className="item-list">
              {meeting.blockers.map((b: any) => (
                <div key={b.id} className="item-row">
                  <div className="item-row-dot" style={{ background: 'var(--red)' }} />
                  <div>{b.text}</div>
                  <span className="badge badge-red" style={{ marginLeft: 'auto', flexShrink: 0 }}>{b.severity}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {meeting.transcript && (
          <div>
            <div className="section-title">Transcript</div>
            <div className="transcript-box">{meeting.transcript}</div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Communications() {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [selected, setSelected] = useState<Meeting | null>(null);

  const load = async () => {
    const data = await (window as any).inwiseAPI.getMeetings();
    setMeetings(data || []);
  };

  useEffect(() => {
    load();
    (window as any).inwiseAPI.on('meeting:new', () => load());
  }, []);

  const openMeeting = async (id: string) => {
    const full = await (window as any).inwiseAPI.getMeeting(id);
    setSelected(full);
  };

  const statusLabel = (status: string) => {
    if (status === 'completed') return <><span className="status-dot completed" />{' '}Completed</>;
    if (status === 'recording') return <><span className="status-dot recording" />{' '}Recording</>;
    if (status === 'transcribed') return <><span className="status-dot processing" />{' '}Processing</>;
    return <><span className="status-dot" />{' '}{status}</>;
  };

  return (
    <>
      <div className="page-header">
        <div className="page-title">Communications</div>
        <div className="page-subtitle">{meetings.length} meeting{meetings.length !== 1 ? 's' : ''} recorded</div>
      </div>
      <div className="page-body">
        {meetings.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">🎙️</div>
            <div className="empty-state-title">No meetings yet</div>
            <div>Meetings you record will appear here. Press Ctrl+Shift+T to test.</div>
          </div>
        ) : (
          <div className="meeting-list">
            {meetings.map((m) => (
              <div key={m.id} className="meeting-card" onClick={() => openMeeting(m.id)}>
                <div className="meeting-card-header">
                  <div className="meeting-title">{m.title}</div>
                  <div className="meeting-date">{formatDate(m.date)}</div>
                </div>
                <div className="meeting-meta">
                  <span className="badge" style={{ fontSize: 11 }}>{statusLabel(m.status)}</span>
                  {m.action_item_count! > 0 && (
                    <span className="badge badge-teal">{m.action_item_count} action{m.action_item_count !== 1 ? 's' : ''}</span>
                  )}
                  {m.blocker_count! > 0 && (
                    <span className="badge badge-red">{m.blocker_count} blocker{m.blocker_count !== 1 ? 's' : ''}</span>
                  )}
                  {m.decision_count! > 0 && (
                    <span className="badge badge-amber">{m.decision_count} decision{m.decision_count !== 1 ? 's' : ''}</span>
                  )}
                  {m.duration > 0 && <span className="badge">{formatDuration(m.duration)}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {selected && <MeetingDetail meeting={selected} onClose={() => setSelected(null)} />}
    </>
  );
}
