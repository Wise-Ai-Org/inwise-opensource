import React from 'react';

export interface LiveMeetingInfo {
  id: string;
  title: string;
  startTime: number;
  endTime: number;
  attendees: string[];
}

interface Props {
  meeting: LiveMeetingInfo;
  onStartRecording: () => void;
  onDismiss: () => void;
}

const TEAL = '#0d9488';
const TEAL_HOVER = '#14b8a6';
const INK = '#0f172a';
const MUTED = '#64748b';
const BORDER = '#e2e8f0';
const BANNER_BG = '#ecfeff';

/**
 * "This looks like your meeting with {attendee or title} — want me to start recording?"
 *
 * Rendered at the top of Home when the app is opened mid-scheduled-meeting (US-008).
 * Prefers a human attendee name for the subject; falls back to the event title.
 */
function describeSubject(meeting: LiveMeetingInfo): string {
  const nonEmpty = (meeting.attendees || []).map(a => (a || '').trim()).filter(Boolean);
  if (nonEmpty.length > 0) return nonEmpty[0];
  return meeting.title || 'your meeting';
}

export default function LiveMeetingBanner({ meeting, onStartRecording, onDismiss }: Props) {
  const subject = describeSubject(meeting);
  return (
    <div
      data-testid="live-meeting-banner"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 16px',
        background: BANNER_BG,
        borderBottom: `1px solid ${BORDER}`,
        fontSize: 13,
        color: INK,
      }}
    >
      <span aria-hidden style={{ color: TEAL, fontSize: 14, lineHeight: 1 }}>●</span>
      <span style={{ flex: 1, lineHeight: 1.5 }}>
        This looks like your meeting with <strong>{subject}</strong> — want me to start recording?
      </span>
      <button
        data-testid="live-meeting-banner-start"
        onClick={onStartRecording}
        style={{
          background: TEAL,
          color: '#fff',
          border: 'none',
          borderRadius: 6,
          padding: '6px 14px',
          fontSize: 12,
          fontWeight: 600,
          cursor: 'pointer',
        }}
        onMouseEnter={e => (e.currentTarget.style.background = TEAL_HOVER)}
        onMouseLeave={e => (e.currentTarget.style.background = TEAL)}
      >
        Start recording
      </button>
      <button
        data-testid="live-meeting-banner-dismiss"
        onClick={onDismiss}
        style={{
          background: 'transparent',
          color: MUTED,
          border: `1px solid ${BORDER}`,
          borderRadius: 6,
          padding: '6px 12px',
          fontSize: 12,
          fontWeight: 500,
          cursor: 'pointer',
        }}
      >
        Not now
      </button>
    </div>
  );
}
