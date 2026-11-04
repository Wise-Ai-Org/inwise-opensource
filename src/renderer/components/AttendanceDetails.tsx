import React from 'react';
import type { MeetingAttendance } from '../../main/meeting-attendance';

function time(value: string | null): string {
  return value ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Not provided';
}

export default function AttendanceDetails({ attendance }: { attendance: MeetingAttendance }) {
  return <div style={{ fontSize: 12, lineHeight: 1.6, marginTop: 10 }}>
    <div style={{ fontWeight: 600 }}>Joined according to {attendance.provider === 'meet' ? 'Google Meet' : attendance.provider === 'teams' ? 'Teams' : 'Zoom'}</div>
    {attendance.participants.length === 0 && <div>The service returned no participant records. This does not prove nobody joined.</div>}
    {attendance.participants.map((participant, index) => <div key={`${participant.id}-${index}`} style={{ marginTop: 8 }}>
      <div>{participant.name}{participant.email ? ` (${participant.email})` : ''}</div>
      {participant.identityKind === 'anonymous' || participant.identityKind === 'phone' || participant.identityKind === 'unknown'
        ? <div style={{ color: 'var(--slate-500)' }}>Identity is not verified against the invitation.</div> : null}
      {participant.sessions.map((session, sessionIndex) => <div key={session.id || sessionIndex} style={{ color: 'var(--slate-500)' }}>
        Joined: {time(session.joinedAt)}. Left: {time(session.leftAt)}.
      </div>)}
      {!participant.sessions.length && <div>Join and leave times were not provided.</div>}
    </div>)}
    <div style={{ color: 'var(--slate-500)', marginTop: 8 }}>Fetched {time(attendance.fetchedAt)}. Names alone do not confirm which email address a participant used.</div>
  </div>;
}
