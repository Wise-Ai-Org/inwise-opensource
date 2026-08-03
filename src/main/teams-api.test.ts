import * as assert from 'node:assert/strict';
import { fetchTeamsTranscriptArtifact, listTeamsMeetings, TeamsMeetingItem } from './teams-api';

function response(status: number, body: unknown): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
  } as Response;
}

async function run(): Promise<void> {
  const requested: string[] = [];
  const fetchList = async (url: any) => {
    requested.push(String(url));
    if (requested.length === 1) {
      return response(200, {
        value: [{
          id: 'event-1', subject: 'Weekly Teams Sync', isOnlineMeeting: true,
          start: { dateTime: '2026-08-01T10:00:00.0000000', timeZone: 'UTC' },
          end: { dateTime: '2026-08-01T10:30:00.0000000', timeZone: 'UTC' },
          onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' },
        }],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendarView?page=2',
      });
    }
    return response(200, { value: [{ id: 'event-2', isOnlineMeeting: false }] });
  };
  const meetings = await listTeamsMeetings({
    getToken: async () => 'token',
    fetchFn: fetchList as typeof fetch,
    now: new Date('2026-08-02T12:00:00.000Z'),
  });
  assert.equal(meetings.length, 1);
  assert.equal(meetings[0].title, 'Weekly Teams Sync');
  assert.equal(meetings[0].startedAt, '2026-08-01T10:00:00.000Z');
  assert.equal(requested.length, 2, 'calendar pagination followed');

  await assert.rejects(
    () => listTeamsMeetings({
      getToken: async () => 'token',
      fetchFn: (async () => response(404, {
        error: { code: 'ErrorItemNotFound', message: 'The mailbox was not found.' },
      })) as typeof fetch,
      now: new Date('2026-08-02T12:00:00.000Z'),
    }),
    /Exchange Online mailbox/,
  );

  const meeting: TeamsMeetingItem = meetings[0];
  const calls: Array<{ url: string; accept?: string }> = [];
  const fetchArtifact = async (url: any, init?: any) => {
    calls.push({ url: String(url), accept: init?.headers?.Accept });
    if (String(url).includes('/me/onlineMeetings?')) {
      return response(200, { value: [{ id: 'online-1' }] });
    }
    if (String(url).includes('/transcripts?')) {
      return response(200, { value: [{ id: 'transcript-1', createdDateTime: '2026-08-01T10:31:00Z' }] });
    }
    if (init?.headers?.Accept === 'text/vtt') {
      return response(403, { error: { innerError: { code: 'SpeakerAttributionNotAllowed' } } });
    }
    return response(200, '00:00:01.000 --> 00:00:02.000\n\nHello from the transcript.');
  };
  const artifact = await fetchTeamsTranscriptArtifact(meeting, {
    getToken: async () => 'token',
    fetchFn: fetchArtifact as typeof fetch,
  });
  assert.equal(artifact.transcriptId, 'transcript-1');
  assert.equal(artifact.speakerAttributed, false, 'falls back when speaker attribution is disabled');
  assert.ok(calls.some((call) => call.accept === 'application/vnd.microsoft.graph.transcript+text'));

  console.log('teams-api: all tests passed');
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { run };
