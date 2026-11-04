export interface AttendanceSession {
  id?: string;
  joinedAt: string | null;
  leftAt: string | null;
}

export interface MeetingAttendance {
  provider: 'meet' | 'teams' | 'zoom';
  meetingId: string;
  fetchedAt: string;
  participants: Array<{
    id: string;
    name: string;
    email?: string;
    identityKind: 'signed_in' | 'anonymous' | 'phone' | 'unknown';
    sessions: AttendanceSession[];
  }>;
}

export function validAttendanceTime(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

export function assertMeetConferenceName(name: string): void {
  if (!/^conferenceRecords\/[A-Za-z0-9_-]+$/.test(name)) throw new Error('Invalid Google Meet conference record');
}

export function zoomMeetingPathId(uuid: string): string {
  const encoded = encodeURIComponent(uuid);
  return uuid.startsWith('/') || uuid.includes('//') ? encodeURIComponent(encoded) : encoded;
}
