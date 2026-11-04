import * as assert from 'node:assert/strict';
import Datastore from '@seald-io/nedb';
import { __setMeetingsDbForTests, linkMeetConferenceToCalendarEvent } from './database';
import { parseMeetReference, resolveMeetConference } from './meet-api';
import { captureActiveMeetConferences, listAvailableMeetConferences, rememberMeetConference, savedMeetConferences } from './meet-conference-tracker';

const start = '2026-11-02T10:00:00Z';
const end = '2026-11-02T11:00:00Z';
const conference = { name: 'conferenceRecords/guest-call', space: 'spaces/space1', title: 'Standup', startedAt: start, endedAt: end };
function response(body: any, status = 200): Response {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) } as Response;
}

async function run() {
  assert.deepEqual(parseMeetReference('https://meet.google.com/abc-defg-hij?authuser=1'), { code: 'abc-defg-hij' });
  assert.deepEqual(parseMeetReference('https://meet.googleapis.com/v2/conferenceRecords/record1'), { record: 'conferenceRecords/record1' });
  for (const input of ['https://evil.example/abc-defg-hij', 'http://meet.google.com/abc-defg-hij', 'conferenceRecords/a/../../other', 'https://meet.google.com.evil.example/abc-defg-hij']) {
    assert.throws(() => parseMeetReference(input));
  }
  const calls: string[] = [];
  const resolved = await resolveMeetConference('https://meet.google.com/abc-defg-hij', {
    getToken: async () => 'token', fetchFn: (async (url: any) => {
      calls.push(String(url));
      return String(url).includes('/spaces/')
        ? response({ activeConference: { conferenceRecord: conference.name } })
        : response({ name: conference.name, space: conference.space, startTime: start });
    }) as typeof fetch,
  });
  assert.equal(resolved.name, conference.name);
  assert.equal(resolved.endedAt, '', 'active calls remain active until Google reports an end');
  assert.equal(calls.length, 2);
  await assert.rejects(resolveMeetConference('abc-defg-hij', { getToken: async () => 'token', fetchFn: (async () => response({})) as typeof fetch }),
    (error: any) => error.code === 'MEET_NO_ACTIVE_CONFERENCE');
  await assert.rejects(resolveMeetConference('conferenceRecords/denied', { getToken: async () => 'token', fetchFn: (async () => response({}, 403)) as typeof fetch }), /Google denied/);

  const db = new Datastore<any>();
  await db.loadDatabaseAsync();
  __setMeetingsDbForTests(db);
  await db.insertAsync({ _id: 'saved', calendarEventId: 'event1', attendees: ['alice@example.com'], sourceMetadata: { keep: true }, recordingRecovery: { audioPath: 'original.wav' } });
  const captured: string[] = [];
  let resolutions = 0;
  await captureActiveMeetConferences([
    { id: 'event1', title: 'Standup', startTime: start, endTime: end, meetingLink: 'https://meet.google.com/abc-defg-hij' },
    { id: 'tomorrow', title: 'Future', startTime: '2026-11-03T10:00:00Z', endTime: '2026-11-03T11:00:00Z', meetingLink: 'https://meet.google.com/abc-defg-hij' },
    { id: 'zoom', title: 'Other service', startTime: start, endTime: end, meetingLink: 'https://zoom.us/j/123' },
  ], {
    resolve: async () => { resolutions++; return conference; },
    remember: record => captured.push(record.name), link: linkMeetConferenceToCalendarEvent,
  }, Date.parse('2026-11-02T10:05:00Z'));
  assert.equal(resolutions, 1, 'only the current Meet calendar call is queried');
  assert.deepEqual(captured, [conference.name]);
  const linked = await db.findOneAsync({ _id: 'saved' });
  assert.equal(linked.sourceMetadata.meetConferenceRecord, conference.name);
  assert.equal(linked.sourceMetadata.keep, true);
  assert.equal(linked.recordingRecovery.audioPath, 'original.wav', 'linking preserves saved audio');
  assert.deepEqual(linked.attendees, ['alice@example.com']);

  const available = await listAvailableMeetConferences({ hosted: async () => [], saved: () => [{ ...conference, capturedAt: start }], get: async () => conference });
  assert.equal(available.length, 1, 'a saved attendee record is available with an empty organizer list');
  const active = await listAvailableMeetConferences({ hosted: async () => [], saved: () => [{ ...conference, capturedAt: start }], get: async () => ({ ...conference, endedAt: '' }) });
  assert.equal(active.length, 0, 'post-meeting import waits until the conference ends');
  const denied = await listAvailableMeetConferences({ hosted: async () => [], saved: () => [{ ...conference, capturedAt: start }], get: async () => { throw new Error('Access denied'); } });
  assert.equal(denied.length, 0, 'cached IDs do not bypass Google access checks');

  const current = { ...conference, startedAt: new Date().toISOString() };
  rememberMeetConference(current, 'event1');
  rememberMeetConference(current, 'event1');
  assert.equal(savedMeetConferences().filter(record => record.name === current.name).length, 1, 'saved record IDs survive independently of the live call without duplicates');
  console.log('meet-conference-tracker: all tests passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
