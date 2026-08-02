import React, { useEffect, useState } from 'react';
import { api, useNav } from './nav';
import JiraMappingModal from '../views/communications/JiraMappingModal';
import UploadTranscriptSheet from './UploadTranscriptSheet';
import { buildMeetingSlackRecap } from './slack-recap';

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
  const [jiraConnected, setJiraConnected] = useState(false);
  const [mappingOpen, setMappingOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [slackConnected, setSlackConnected] = useState(false);
  const [slackChannels, setSlackChannels] = useState<Array<{ id: string; name: string }>>([]);
  const [slackChannelId, setSlackChannelId] = useState('');
  const [slackSending, setSlackSending] = useState(false);
  const [slackResult, setSlackResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    api().getMeeting?.(meetingId)
      .then((m: any) => setMeeting(m))
      .catch(() => {})
      .finally(() => setLoaded(true));
    api().jiraStatus?.()
      .then((s: any) => setJiraConnected(!!(s?.connected || s?.isConnected)))
      .catch(() => {});
    api().slackStatus?.()
      .then(async (s: any) => {
        const connected = !!s?.connected && s?.threadCapable !== false;
        setSlackConnected(connected);
        if (!connected) return;
        const result = await api().slackListWriteChannels?.();
        if (!result?.ok) return;
        const channels = result.channels ?? [];
        setSlackChannels(channels);
        setSlackChannelId(channels[0]?.id ?? '');
      })
      .catch(() => {});
  }, [meetingId]);

  const insights: Insights = meeting?.insights || {};
  const when = meeting?.date ? new Date(meeting.date) : null;

  const doDelete = async () => {
    await api().deleteMeeting?.(meetingId);
    popAll();
  };

  const postRecapToSlack = async () => {
    if (!meeting || !slackChannelId) return;
    setSlackSending(true);
    setSlackResult(null);
    try {
      const result = await api().slackPostWiserNote?.(
        slackChannelId,
        buildMeetingSlackRecap(meeting),
      );
      setSlackResult(result?.ok
        ? { ok: true, message: 'Recap posted to Slack.' }
        : { ok: false, message: result?.error || 'Could not post the recap.' });
    } catch (error: any) {
      setSlackResult({ ok: false, message: error.message });
    } finally {
      setSlackSending(false);
    }
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
              {!meeting.transcript && meeting.status !== 'recording' && (
                <div style={{ marginTop: 10 }}>
                  <div className="pp-meta" style={{ lineHeight: 1.5 }}>
                    No transcript was captured for this meeting. If notes or a transcript exist elsewhere, add them here.
                  </div>
                  <button className="pp-btn pp-ghost" style={{ marginTop: 8, padding: '6px 14px' }} onClick={() => setUploadOpen(true)}>
                    Upload transcript for this meeting
                  </button>
                </div>
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

            {jiraConnected && (insights.actionItems?.length || 0) > 0 && (
              <button className="pp-btn pp-ghost" onClick={() => setMappingOpen(true)}>
                Map action items to Jira
              </button>
            )}

            {slackConnected && insights.summary && (
              <>
                <div className="pp-seclabel">Share to Slack</div>
                <div className="pp-card">
                  {slackChannels.length > 0 ? (
                    <>
                      <div className="pp-meta" style={{ marginBottom: 8 }}>
                        Posts the summary, decisions, action items, and blockers. The transcript is not sent.
                      </div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <select
                          className="form-input"
                          aria-label="Slack write channel"
                          value={slackChannelId}
                          onChange={(event) => setSlackChannelId(event.target.value)}
                          style={{ flex: 1, minWidth: 0 }}
                        >
                          {slackChannels.map((channel) => (
                            <option key={channel.id} value={channel.id}>#{channel.name}</option>
                          ))}
                        </select>
                        <button
                          className="pp-btn pp-solid"
                          style={{ width: 'auto', margin: 0, whiteSpace: 'nowrap' }}
                          disabled={slackSending || !slackChannelId}
                          onClick={postRecapToSlack}
                        >
                          {slackSending ? 'Posting…' : 'Post recap'}
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="pp-meta">Choose at least one write channel in Settings → Slack.</div>
                  )}
                  {slackResult && (
                    <div
                      className="pp-meta"
                      role="status"
                      style={{ marginTop: 8, color: slackResult.ok ? 'var(--teal)' : 'var(--red)' }}
                    >
                      {slackResult.message}
                    </div>
                  )}
                </div>
              </>
            )}

            <UploadTranscriptSheet
              open={uploadOpen}
              onClose={() => setUploadOpen(false)}
              attachTo={meeting.title}
              onUpload={async ({ content }) => {
                const updated = await api().attachTranscriptToMeeting?.(meetingId, content);
                if (updated) setMeeting(updated);
                setUploadOpen(false);
              }}
            />

            {mappingOpen && (
              <JiraMappingModal
                isOpen={mappingOpen}
                onClose={() => setMappingOpen(false)}
                actionItems={(insights.actionItems || []).map(ai => ({ text: ai.text, owner: ai.owner || ai.assignee }))}
                meetingTitle={meeting.title}
                meetingId={meetingId}
                onComplete={() => { /* receipts feed picks up the writes */ }}
              />
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
