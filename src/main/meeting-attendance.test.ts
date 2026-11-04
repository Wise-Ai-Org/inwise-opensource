import * as assert from 'node:assert/strict';
import { fetchMeetAttendance } from './meet-api';
import { fetchTeamsAttendance } from './teams-api';
import { fetchZoomAttendance } from './zoom-attendance';
import { zoomMeetingPathId } from './meeting-attendance';

function response(body: any, status = 200): Response {
  return { ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body } as Response;
}
const token = async () => 'test-token';
const conference = { name: 'conferenceRecords/c1', space: 'spaces/s1', title: 'Call', startedAt: '2026-11-02T10:00:00Z', endedAt: '2026-11-02T11:00:00Z' };
const meeting = { eventId: 'event1', title: 'Call', joinWebUrl: 'https://teams.microsoft.com/l/meetup-join/test', startedAt: conference.startedAt, endedAt: conference.endedAt };

async function run() {
  const calls: string[] = [];
  const meet = await fetchMeetAttendance(conference, { getToken: token, fetchFn: (async (raw: any) => {
    const url = new URL(String(raw)); calls.push(url.pathname);
    if (url.pathname.endsWith('/participants')) return response({ participants: [{ name: `${conference.name}/participants/p1`, signedinUser: { displayName: 'Silent guest', user: 'users/u1' } }] });
    if (!url.searchParams.has('pageToken')) return response({ participantSessions: [{ name: 's1', startTime: '2026-11-02T10:01:00Z', endTime: '2026-11-02T10:10:00Z' }], nextPageToken: 'next' });
    return response({ participantSessions: [{ name: 's2', startTime: '2026-11-02T10:12:00Z', endTime: '2026-11-02T10:50:00Z' }] });
  }) as typeof fetch });
  assert.equal(meet.participants[0].sessions.length, 2, 'rejoins are preserved');
  assert.equal(meet.participants[0].name, 'Silent guest');
  assert.ok(calls.every(url => !url.includes('transcript')), 'attendance does not require a transcript');
  await assert.rejects(fetchMeetAttendance({ ...conference, name: 'conferenceRecords/c1/../../bad' }, { getToken: token }), /Invalid/);

  const teams = await fetchTeamsAttendance(meeting, { getToken: token, fetchFn: (async (raw: any) => {
    const url = String(raw);
    if (url.includes('/onlineMeetings?')) return response({ value: [{ id: 'online1' }] });
    if (url.endsWith('/attendanceReports')) return response({ value: [
      { id: 'yesterday', meetingStartDateTime: '2026-11-01T10:00:00Z', meetingEndDateTime: '2026-11-01T11:00:00Z' },
      { id: 'today', meetingStartDateTime: conference.startedAt, meetingEndDateTime: conference.endedAt },
    ] });
    assert.ok(url.includes('/attendanceReports/today/'), 'select the matching recurring occurrence');
    return response({ value: [{ id: 'p1', identity: { id: 'user1', displayName: 'Alice' }, emailAddress: 'alice@example.com', attendanceIntervals: [{ joinDateTime: conference.startedAt, leaveDateTime: conference.endedAt }] }] });
  }) as typeof fetch });
  assert.equal(teams.participants[0].email, 'alice@example.com');
  await assert.rejects(fetchTeamsAttendance(meeting, { getToken: token, fetchFn: (async (url: any) =>
    response({ value: String(url).includes('/onlineMeetings?') ? [{ id: 'online1' }] : [] })) as typeof fetch }), /No attendance report/);

  const zoom = await fetchZoomAttendance('/uuid//', { getToken: token, fetchFn: (async (raw: any) => {
    const url = new URL(String(raw));
    assert.ok(url.pathname.includes('%252Fuuid%252F%252F'), 'special UUID is double encoded');
    const start = url.searchParams.has('next_page_token') ? '2026-11-02T10:20:00Z' : conference.startedAt;
    return response({ participants: [{ participant_user_id: 'u1', name: 'Alice', user_email: 'alice@example.com', join_time: start, leave_time: conference.endedAt }], next_page_token: url.searchParams.has('next_page_token') ? '' : 'next' });
  }) as typeof fetch });
  assert.equal(zoom.participants.length, 1);
  assert.equal(zoom.participants[0].sessions.length, 2);
  assert.equal(zoomMeetingPathId('abc=='), 'abc%3D%3D', 'ordinary UUID is encoded once');
  await assert.rejects(fetchZoomAttendance('id', { getToken: token, fetchFn: (async () => response({}, 403)) as typeof fetch }), /permission/);
  console.log('meeting-attendance: all tests passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
