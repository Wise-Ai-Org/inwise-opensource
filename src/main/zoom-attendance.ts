import { getValidZoomToken } from './zoom-oauth';
import { MeetingAttendance, validAttendanceTime, zoomMeetingPathId } from './meeting-attendance';

export async function fetchZoomAttendance(uuid: string, deps: {
  getToken?: () => Promise<string>; fetchFn?: typeof fetch;
} = {}): Promise<MeetingAttendance> {
  const token = await (deps.getToken ?? getValidZoomToken)();
  const fetchFn = deps.fetchFn ?? fetch;
  const result: MeetingAttendance = { provider: 'zoom', meetingId: uuid, fetchedAt: new Date().toISOString(), participants: [] };
  const seen = new Set<string>();
  let pageToken = '';
  do {
    if (pageToken && seen.has(pageToken)) throw new Error('Zoom returned a repeated attendance pagination token');
    if (pageToken) seen.add(pageToken);
    const url = new URL(`https://api.zoom.us/v2/past_meetings/${zoomMeetingPathId(uuid)}/participants`);
    url.search = new URLSearchParams({ page_size: '300', ...(pageToken ? { next_page_token: pageToken } : {}) }).toString();
    const response = await fetchFn(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`Zoom attendance is unavailable (HTTP ${response.status}). This requires an eligible host account and meeting:read:list_past_participants permission.`);
    const data = await response.json() as any;
    for (const participant of data.participants || []) {
      // Names alone are not identity. Preserve separate guests when Zoom supplies no stable identity.
      const id = participant.participant_user_id || participant.user_email || participant.id || participant.user_id || `guest-${result.participants.length}`;
      const existing = result.participants.find(item => item.id === String(id));
      const session = { joinedAt: validAttendanceTime(participant.join_time), leftAt: validAttendanceTime(participant.leave_time) };
      if (existing) existing.sessions.push(session);
      else result.participants.push({
        id: String(id), name: participant.name || participant.user_email || 'Unknown participant',
        email: participant.user_email || undefined,
        identityKind: participant.user_email || participant.participant_user_id ? 'signed_in' : 'unknown', sessions: [session],
      });
    }
    pageToken = data.next_page_token || '';
  } while (pageToken);
  return result;
}
