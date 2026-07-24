import React, { useEffect, useState } from 'react';
import { api, useNav } from './nav';

interface Insights {
  summary?: string;
  actionItems?: Array<{ text: string; owner?: string; assignee?: string; isCommitment?: boolean }>;
  decisions?: Array<{ text: string }>;
  blockers?: Array<{ text: string }>;
  contradictions?: Array<{ text: string }>;
}

export default function MeetingDetailPage({ meetingId }: { meetingId: string }) {
  const { pop, popAll } = useNav();
  const [meeting, setMeeting] = useState<any>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api().getMeeting?.(meetingId)
      .then((m: any) => setMeeting(m))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [meetingId]);

  const insights: Insights = meeting?.insights || {};
  const when = meeting?.date ? new Date(meeting.date) : null;

  const doDelete = async () => {
    await api().deleteMeeting?.(meetingId);
    popAll();
  };

  return (
    <>
      <div className="pp-drillhead">
        <button className="pp-back" aria-label="Back" onClick={pop}>←</button>
        <div className="pp-drilltitle">{meeting?.title || 'Meeting'}</div>
        <span />
      </div>
      <div className="pp-body" style={{ paddingTop: 4 }}>
        {!loaded && <div className="pp-meta" style={{ textAlign: 'center', padding: 20 }}>Loading…</div>}
        {loaded && !meeting && <div className="pp-meta" style={{ textAlign: 'center', padding: 20 }}>Meeting not found.</div>}
        {meeting && (
          <>
            <div className="pp-card">
              <div className="pp-meta">
                {when && !Number.isNaN(when.getTime())
                  ? when.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) +
                    ' · ' + when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
                  : null}
                {meeting.attendees?.length ? ` · ${meeting.attendees.length} attendee${meeting.attendees.length === 1 ? '' : 's'}` : ''}
              </div>
              {insights.summary && (
                <div style={{ fontSize: 12.5, color: 'var(--slate-700)', lineHeight: 1.55, marginTop: 8 }}>
                  {insights.summary}
                </div>
              )}
              {!insights.summary && meeting.transcript && (
                <div className="pp-meta" style={{ marginTop: 8 }}>Transcribed — insights not extracted yet.</div>
              )}
            </div>

            {(insights.actionItems?.length || 0) > 0 && (
              <>
                <div className="pp-seclabel">Action items</div>
                <div className="pp-listcard">
                  {insights.actionItems!.map((ai, i) => (
                    <div key={i} className="pp-setrow" style={{ cursor: 'default' }}>
                      <div className="pp-grow">
                        <div style={{ fontSize: 12.5, color: 'var(--navy)', lineHeight: 1.4 }}>{ai.text}</div>
                        {(ai.owner || ai.assignee) && (
                          <div className="pp-rowsub">
                            {ai.owner || ai.assignee}{ai.isCommitment ? ' · commitment' : ''}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {(insights.decisions?.length || 0) > 0 && (
              <>
                <div className="pp-seclabel">Decisions</div>
                <div className="pp-listcard">
                  {insights.decisions!.map((d, i) => (
                    <div key={i} className="pp-setrow" style={{ cursor: 'default' }}>
                      <div style={{ fontSize: 12.5, color: 'var(--navy)', lineHeight: 1.4 }}>{d.text}</div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {(insights.blockers?.length || 0) > 0 && (
              <>
                <div className="pp-seclabel">Blockers</div>
                <div className="pp-listcard">
                  {insights.blockers!.map((b, i) => (
                    <div key={i} className="pp-setrow" style={{ cursor: 'default' }}>
                      <div style={{ fontSize: 12.5, color: 'var(--navy)', lineHeight: 1.4 }}>{b.text}</div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {(insights.contradictions?.length || 0) > 0 && (
              <>
                <div className="pp-seclabel">Contradictions flagged</div>
                <div className="pp-listcard">
                  {insights.contradictions!.map((c, i) => (
                    <div key={i} className="pp-setrow" style={{ cursor: 'default' }}>
                      <div style={{ fontSize: 12.5, color: 'var(--pp-amber-ink)', lineHeight: 1.4 }}>{c.text}</div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {meeting.transcript && (
              <button
                className="pp-btn pp-solid"
                onClick={() => api().openReviewWindow?.(meetingId)}
              >
                Open full review
              </button>
            )}

            <div className="pp-row" style={{ justifyContent: 'center', paddingTop: 4 }}>
              {confirmDelete ? (
                <span className="pp-row" style={{ gap: 10 }}>
                  <span className="pp-meta">Delete this meeting?</span>
                  <button className="pp-quiet-action" style={{ color: 'var(--red)' }} onClick={doDelete}>Yes, delete</button>
                  <button className="pp-quiet-action" onClick={() => setConfirmDelete(false)}>Cancel</button>
                </span>
              ) : (
                <button className="pp-quiet-action" style={{ color: 'var(--red)' }} onClick={() => setConfirmDelete(true)}>
                  Delete meeting
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
