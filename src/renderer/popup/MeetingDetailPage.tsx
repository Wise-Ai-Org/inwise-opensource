import AttendanceDetails from '../components/AttendanceDetails';
import React, { useEffect, useState } from 'react';
import { api, useNav } from './nav';
import JiraMappingModal from '../views/communications/JiraMappingModal';
import UploadTranscriptSheet from './UploadTranscriptSheet';
import ActionItemsEditor from './ActionItemsEditor';
import { buildMeetingSlackRecap } from './slack-recap';
import { retrySavedRecording } from './recording-recovery';

interface Insights {
  summary?: string;
  analysisStatus?: string;
  actionItems?: Array<{ text: string; owner?: string; assignee?: string; isCommitment?: boolean }>;
  decisions?: Array<{ text: string }>;
  blockers?: Array<{ text: string }>;
  contradictions?: Array<{ text: string }>;
}

export default function MeetingDetailPage({ meetingId }: { meetingId: string }) {
  const { pop, popAll } = useNav();
  const [meeting, setMeeting] = useState<any>(null);
  const [people, setPeople] = useState<any[]>([]);
  useEffect(() => { api().getPeople?.().then((rows: any[]) => setPeople(rows || [])).catch(() => {}); }, []);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState('');
  const [attendanceBusy, setAttendanceBusy] = useState(false);
  const [attendanceError, setAttendanceError] = useState('');
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

  useEffect(() => {
    const onMeeting = (updated: any) => {
      if (updated?._id === meetingId) setMeeting(updated);
    };
    api().on?.('meeting:new', onMeeting);
    return () => api().off?.('meeting:new', onMeeting);
  }, [meetingId]);

  const retryRecording = async () => {
    setRetrying(true);
    setRetryError('');
    try {
      await retrySavedRecording(meetingId, meeting);
    } catch (error: any) {
      setRetryError(error.message);
    } finally { setRetrying(false); }
  };

  // Resolve only known contact aliases; invite addresses do not prove attendance.
  const invitees = new Map<string, { name: string; addresses: string[] }>();
  for (const raw of meeting?.attendees || []) {
    const address = String(raw).trim();
    if (!address) continue;
    const key = address.toLowerCase();
    const matches = people.filter(person => [person.name, person.email, ...(person.altNames || []), ...(person.altEmails || [])]
      .some(alias => typeof alias === 'string' && alias.trim().toLowerCase() === key));
    const person = matches.length === 1 ? matches[0] : null;
    const identity = person?._id ? `person:${person._id}` : `address:${key}`;
    const entry: { name: string; addresses: string[] } = invitees.get(identity) || { name: person?.name || address, addresses: [] };
    if (!entry.addresses.some(value => value.toLowerCase() === key)) entry.addresses.push(address);
    invitees.set(identity, entry);
  }
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
      const result = await api().slackPostOllieNote?.(
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
                {invitees.size ? ` · ${invitees.size} invited` : ''}
              </div>
              {invitees.size > 0 && (
                <details className="pp-meta" style={{ marginTop: 8 }}>
                  <summary>Invitees and attendance</summary>
                  {Array.from(invitees.entries()).map(([key, person]) => (
                    <div key={key} style={{ marginTop: 6 }}>
                      {person.name}{person.addresses.length > 1 ? ` (invited with ${person.addresses.length} emails: ${person.addresses.join(', ')})` : ''}
                    </div>
                  ))}
                  <div style={{ marginTop: 8 }}>Calendar invitations do not confirm who joined. Attendance has not been verified.</div>
                </details>
              )}
              {(meeting.sourceMetadata?.attendance || meeting.sourceMetadata?.meetConferenceRecord || meeting.sourceMetadata?.teamsMeeting || meeting.sourceMetadata?.zoomUuid) && (
                <details className="pp-meta" style={{ marginTop: 10 }}>
                  <summary>Participants and join sessions</summary>
                  {meeting.sourceMetadata?.attendance && <AttendanceDetails attendance={meeting.sourceMetadata.attendance} />}
                  <button className="pp-btn pp-ghost" disabled={attendanceBusy} onClick={async () => {
                    setAttendanceBusy(true); setAttendanceError('');
                    try {
                      const result = await api().refreshMeetingAttendance(meetingId);
                      if (result?.ok) setMeeting((current: any) => ({ ...current, sourceMetadata: { ...current.sourceMetadata, attendance: result.attendance } }));
                      else setAttendanceError(result?.error || 'Attendance is unavailable.');
                    } catch { setAttendanceError('Could not refresh attendance.'); }
                    finally { setAttendanceBusy(false); }
                  }}>{attendanceBusy ? 'Fetching attendance…' : 'Refresh attendance'}</button>
                  {attendanceError && <div role="status">{attendanceError}</div>}
                </details>
              )}
              {(meeting.status === 'needs_review' || insights.analysisStatus === 'needs_review') && (
                <div className="pp-meta" style={{ color: 'var(--amber)', marginTop: 5 }}>Some audio or transcript segments need review.</div>
              )}
              {['transcribing', 'processing'].includes(meeting.status) && (
                <div className="pp-meta" role="status" style={{ marginTop: 10 }}>
                  Recording saved in Meetings. {meeting.status === 'transcribing' ? 'Transcribing audio…' : 'Preparing insights…'}
                </div>
              )}
              {meeting.status === 'error' && (
                <div role="alert" style={{ marginTop: 10 }}>
                  <div className="pp-meta">{meeting.recordingFailure?.message || 'Processing failed. Open this recording to retry.'}</div>
                  <button className="pp-btn pp-solid" disabled={retrying || meeting.recordingFailure?.retryable === false} onClick={retryRecording}>
                    {retrying ? 'Retrying…' : 'Retry processing'}
                  </button>
                </div>
              )}
              {meeting.recordingRecovery && <button className="pp-btn pp-ghost" onClick={() => api().exportRecording(meetingId).then((r: any) => { if (r?.error) setRetryError(r.error); }).catch(() => setRetryError('Could not export audio. The saved original is unchanged.'))}>Export saved audio</button>}
              {meeting.status === 'transcribed' && !insights.summary && <button className="pp-btn pp-solid" disabled={retrying} onClick={retryRecording}>{retrying ? 'Processing…' : 'Generate insights'}</button>}
              {retryError && <div role="alert" className="pp-meta">{retryError}</div>}
              {insights.summary && (
                <div style={{ fontSize: 13, color: 'var(--slate-700)', lineHeight: 1.55, marginTop: 8 }}>
                  {insights.summary}
                </div>
              )}
              {!insights.summary && meeting.transcript && (
                <div className="pp-meta" style={{ marginTop: 8 }}>Transcribed — insights not extracted yet.</div>
              )}
              {!meeting.transcript && !['recording', 'transcribing', 'processing'].includes(meeting.status) && (
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
              <ActionItemsEditor
                meetingId={meetingId}
                items={insights.actionItems as any[]}
                inviteeNames={Array.from(invitees.values()).map((person) => person.name)}
                onMeetingUpdated={setMeeting}
              />
            )}

            {(insights.decisions?.length || 0) > 0 && (
              <>
                <div className="pp-seclabel">Decisions</div>
                <div className="pp-listcard">
                  {insights.decisions!.map((d, i) => (
                    <div key={i} className="pp-setrow" style={{ cursor: 'default' }}>
                      <div style={{ fontSize: 13, color: 'var(--navy)', lineHeight: 1.4 }}>{d.text}</div>
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
                      <div style={{ fontSize: 13, color: 'var(--navy)', lineHeight: 1.4 }}>{b.text}</div>
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
                      <div style={{ fontSize: 13, color: 'var(--pp-amber-ink)', lineHeight: 1.4 }}>{c.text}</div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {meeting.transcript && meeting.status === 'processed' && (
              <button
                className="pp-btn pp-solid"
                onClick={() => api().openReviewWindow?.(meetingId)}
              >
                {meeting.reviewedAt ? 'New items to review' : 'Open full review'}
              </button>
            )}

            {meeting.status === 'reviewed' && (
              <div className="pp-row" style={{ justifyContent: 'center', gap: 8, padding: '4px 0' }}>
                <span className="pp-meta">
                  Reviewed{meeting.reviewedAt ? ` Â· ${new Date(meeting.reviewedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}` : ''}
                </span>
                <button className="pp-quiet-action" onClick={() => api().openReviewWindow?.(meetingId)}>Review again</button>
              </div>
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
