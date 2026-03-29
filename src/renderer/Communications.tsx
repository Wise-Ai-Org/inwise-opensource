import React, { useState, useEffect } from 'react';
import MiniCalendar from './MiniCalendar';

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

interface CalendarEvent {
  id: string;
  title: string;
  startTime: string;
  endTime: string;
  meetingLink?: string;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatDuration(seconds: number) {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  return m > 0 ? `${m}m` : `${seconds}s`;
}

function toDateKey(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function MeetingDetail({ meeting, onClose }: { meeting: Meeting; onClose: () => void }) {
  return (
    <div className="detail-panel">
      <div className="detail-header">
        <div>
          <div className="detail-title">{meeting.title}</div>
          <div className="detail-date">{formatDate(meeting.date)} · {formatTime(meeting.date)}{meeting.duration ? ` · ${formatDuration(meeting.duration)}` : ''}</div>
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
                  <div style={{ flex: 1 }}>
                    <div>{item.text}</div>
                    {(item.owner || item.due_date) && (
                      <div style={{ marginTop: 2, fontSize: 11, color: 'var(--slate-500)' }}>
                        {item.owner && <span>{item.owner}</span>}
                        {item.owner && item.due_date && <span> · </span>}
                        {item.due_date && <span>Due {item.due_date}</span>}
                      </div>
                    )}
                  </div>
                  <span className={`badge badge-${item.priority === 'high' ? 'red' : item.priority === 'low' ? 'teal' : 'amber'}`} style={{ flexShrink: 0 }}>
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
  const [calEvents, setCalEvents] = useState<CalendarEvent[]>([]);
  const [selected, setSelected] = useState<Meeting | null>(null);
  const [selectedDate, setSelectedDate] = useState(new Date());

  const loadMeetings = async () => {
    const data = await (window as any).inwiseAPI.getMeetings();
    setMeetings(data || []);
  };

  const loadCalEvents = async () => {
    const data = await (window as any).inwiseAPI.getCalendarEvents();
    setCalEvents(data || []);
  };

  useEffect(() => {
    loadMeetings();
    loadCalEvents();
    (window as any).inwiseAPI.on('meeting:new', loadMeetings);
    (window as any).inwiseAPI.on('calendar:events', (events: CalendarEvent[]) => setCalEvents(events));
  }, []);

  const openMeeting = async (id: string) => {
    const full = await (window as any).inwiseAPI.getMeeting(id);
    setSelected(full);
  };

  // Build event date set for calendar dots
  const eventDates = new Set<string>([
    ...calEvents.map(e => toDateKey(e.startTime)),
    ...meetings.map(m => toDateKey(m.date)),
  ]);

  const selectedKey = toDateKey(selectedDate.toISOString());

  // Filter to selected date or show all if nothing specific
  const filteredCalEvents = calEvents.filter(e => toDateKey(e.startTime) === selectedKey);
  const filteredMeetings = meetings.filter(m => toDateKey(m.date) === selectedKey);
  const showingAll = filteredCalEvents.length === 0 && filteredMeetings.length === 0;

  const displayCalEvents = showingAll ? calEvents.slice(0, 10) : filteredCalEvents;
  const displayMeetings = showingAll ? meetings : filteredMeetings;

  return (
    <>
      <div className="page-header">
        <div className="page-title">Communications</div>
        <div className="page-subtitle">
          {showingAll
            ? `${meetings.length} recorded · ${calEvents.length} upcoming`
            : `${formatDate(selectedDate.toISOString())}`}
        </div>
      </div>
      <div className="comm-layout">
        {/* Left: mini calendar */}
        <div className="comm-sidebar">
          <MiniCalendar
            selectedDate={selectedDate}
            onSelectDate={setSelectedDate}
            eventDates={eventDates}
          />
        </div>

        {/* Right: meeting list */}
        <div className="comm-list">
          {displayCalEvents.length === 0 && displayMeetings.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">📅</div>
              <div className="empty-state-title">No meetings on this day</div>
              <div style={{ fontSize: 13 }}>Select another date or connect your calendar in Settings.</div>
            </div>
          ) : (
            <>
              {/* Upcoming from calendar */}
              {displayCalEvents.length > 0 && (
                <div className="comm-section">
                  <div className="comm-section-label">Upcoming</div>
                  {displayCalEvents.map(event => (
                    <div key={event.id} className="meeting-card upcoming">
                      <div className="meeting-card-header">
                        <div className="meeting-title">{event.title}</div>
                        <div className="meeting-date">{formatTime(event.startTime)}</div>
                      </div>
                      <div className="meeting-meta">
                        <span className="badge">{formatDate(event.startTime)}</span>
                        {event.meetingLink && (
                          <span
                            className="badge badge-teal"
                            style={{ cursor: 'pointer' }}
                            onClick={() => (window as any).inwiseAPI.openExternal(event.meetingLink)}
                          >
                            Join meeting ↗
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Recorded meetings */}
              {displayMeetings.length > 0 && (
                <div className="comm-section">
                  <div className="comm-section-label">Recorded</div>
                  {displayMeetings.map(m => (
                    <div key={m.id} className="meeting-card" onClick={() => openMeeting(m.id)}>
                      <div className="meeting-card-header">
                        <div className="meeting-title">{m.title}</div>
                        <div className="meeting-date">{formatTime(m.date)}</div>
                      </div>
                      <div className="meeting-meta">
                        <span className={`badge${m.status === 'completed' ? ' badge-teal' : ''}`}>
                          {m.status === 'completed' ? '✓ Processed' : m.status}
                        </span>
                        {m.action_item_count! > 0 && (
                          <span className="badge badge-teal">{m.action_item_count} action{m.action_item_count !== 1 ? 's' : ''}</span>
                        )}
                        {m.blocker_count! > 0 && (
                          <span className="badge badge-red">{m.blocker_count} blocker{m.blocker_count !== 1 ? 's' : ''}</span>
                        )}
                        {m.duration > 0 && <span className="badge">{formatDuration(m.duration)}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {selected && <MeetingDetail meeting={selected} onClose={() => setSelected(null)} />}
    </>
  );
}
