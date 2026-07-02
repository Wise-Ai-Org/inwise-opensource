import * as assert from 'node:assert/strict';
import Datastore from '@seald-io/nedb';
import { __setMeetingsDbForTests, __setTasksDbForTests } from './database';
import {
  NormalizedTranscript,
  segmentsToText,
  ingestNormalizedTranscript,
} from './zoom-transcript-ingestion';

const FIXTURE: NormalizedTranscript = {
  meetingId: 'zoom-meeting-abc123',
  externalId: 'zoom-uuid-abc123',
  title: 'Q2 Planning',
  startedAt: '2026-06-01T17:00:00.000Z',
  sourceMetadata: { zoomUuid: 'zoom-uuid-abc123' },
  segments: [
    { speaker: 'Alice', startMs: 0,     endMs: 4000,  text: 'Welcome everyone.' },
    { speaker: 'Bob',   startMs: 4500,  endMs: 9000,  text: 'Thanks. We should ship the dashboard by Friday.' },
    { speaker: 'Alice', startMs: 9500,  endMs: 14000, text: 'Agreed. Bob will own the deployment.' },
  ],
};

async function run(): Promise<void> {
  // ── segmentsToText: pure conversion ──────────────────────────────────────
  const text = segmentsToText(FIXTURE.segments);
  assert.ok(text.includes('Alice: Welcome everyone.'), 'speaker prefix present');
  assert.ok(text.includes('Bob: Thanks.'), 'second speaker present');
  const lines = text.split('\n');
  assert.equal(lines.length, 3, 'one line per segment');

  // ── ingestNormalizedTranscript: reaches createMeetingFromTranscript ───────
  const meetingsDb = new Datastore<any>();
  await meetingsDb.loadDatabaseAsync();
  const tasksDb = new Datastore<any>();
  await tasksDb.loadDatabaseAsync();
  __setMeetingsDbForTests(meetingsDb);
  __setTasksDbForTests(tasksDb);

  let insightsCalledWith: string | null = null;
  const stubInsights = async (content: string, _meetingId: string) => {
    insightsCalledWith = content;
  };

  const meetingId = await ingestNormalizedTranscript(FIXTURE, { runInsights: stubInsights });

  assert.ok(typeof meetingId === 'string' && meetingId.length > 0, 'returns a meeting ID');

  const meeting = await meetingsDb.findOneAsync({ _id: meetingId });
  assert.ok(meeting, 'meeting persisted in DB');
  assert.equal(meeting.title, 'Q2 Planning', 'title stored');
  assert.equal(meeting.transcript, text, 'full speaker-labeled transcript stored');
  assert.equal(meeting.date, FIXTURE.startedAt, 'startedAt maps to date');
  assert.equal(meeting.source, 'zoom_cloud_recording', 'Zoom import source stored');
  assert.equal(meeting.externalId, 'zoom-uuid-abc123', 'Zoom UUID stored as external ID');
  assert.equal(meeting.sourceMetadata.zoomMeetingId, 'zoom-meeting-abc123', 'Zoom meeting ID stored in metadata');

  assert.equal(insightsCalledWith, text, 'insights pipeline called with same transcript text');

  const updatedFixture: NormalizedTranscript = {
    ...FIXTURE,
    title: 'Q2 Planning Updated',
    segments: [
      ...FIXTURE.segments,
      { speaker: 'Bob', startMs: 15000, endMs: 18000, text: 'One more follow-up.' },
    ],
  };
  const meetingIdAgain = await ingestNormalizedTranscript(updatedFixture, { runInsights: stubInsights });
  assert.equal(meetingIdAgain, meetingId, 're-import updates existing Zoom meeting');
  const updatedMeeting = await meetingsDb.findOneAsync({ _id: meetingId });
  assert.equal(updatedMeeting.title, 'Q2 Planning Updated', 're-import updates title');
  assert.ok(updatedMeeting.transcript.includes('One more follow-up.'), 're-import updates transcript');
  const allZoomImports = await meetingsDb.findAsync({ source: 'zoom_cloud_recording', externalId: 'zoom-uuid-abc123' });
  assert.equal(allZoomImports.length, 1, 're-import does not create duplicate meeting');

  // ── insights failure is non-fatal ─────────────────────────────────────────
  const throwingInsights = async () => { throw new Error('LLM unavailable'); };
  const meetingId2 = await ingestNormalizedTranscript(
    { ...FIXTURE, externalId: 'zoom-uuid-def456' },
    { runInsights: throwingInsights },
  );
  assert.ok(typeof meetingId2 === 'string', 'meeting created even when insights throws');
  const meeting2 = await meetingsDb.findOneAsync({ _id: meetingId2 });
  assert.ok(meeting2, 'meeting persists when insights pipeline fails');

  console.log('zoom-transcript-ingestion: all tests passed');
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { run };
