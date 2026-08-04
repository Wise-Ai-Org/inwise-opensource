import * as assert from 'node:assert/strict';
import { fetchMeetTranscript, listMeetConferenceRecords } from './meet-api';

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
  const listCalls: string[] = [];
  const listFetch = async (url: any) => {
    listCalls.push(String(url));
    if (!String(url).includes('pageToken=')) {
      return response(200, {
        conferenceRecords: [{
          name: 'conferenceRecords/conf-1',
          space: 'spaces/space-1',
          startTime: '2026-08-01T10:00:00Z',
          endTime: '2026-08-01T10:30:00Z',
        }],
        nextPageToken: 'page-2',
      });
    }
    return response(200, { conferenceRecords: [] });
  };
  const records = await listMeetConferenceRecords({
    getToken: async () => 'token',
    fetchFn: listFetch as typeof fetch,
    now: new Date('2026-08-02T12:00:00Z'),
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].title, 'Google Meet — 2026-08-01 10:00 UTC');
  assert.equal(listCalls.length, 2, 'conference record pagination followed');

  const fetchFn = async (url: any) => {
    const value = String(url);
    if (value.includes('/transcripts?')) {
      return response(200, { transcripts: [{
        name: 'conferenceRecords/conf-1/transcripts/transcript-1',
        state: 'FILE_GENERATED',
        startTime: '2026-08-01T10:00:10Z',
      }] });
    }
    if (value.includes('/participants?')) {
      return response(200, { participants: [
        { name: 'conferenceRecords/conf-1/participants/p1', signedinUser: { displayName: 'Alice' } },
        { name: 'conferenceRecords/conf-1/participants/p2', anonymousUser: { displayName: 'Guest Bob' } },
      ] });
    }
    if (value.includes('/entries?')) {
      return response(200, { transcriptEntries: [
        {
          name: 'entry-2', participant: 'conferenceRecords/conf-1/participants/p2', text: 'Second',
          startTime: '2026-08-01T10:00:20Z', endTime: '2026-08-01T10:00:25Z',
        },
        {
          name: 'entry-1', participant: 'conferenceRecords/conf-1/participants/p1', text: 'First',
          startTime: '2026-08-01T10:00:05Z', endTime: '2026-08-01T10:00:10Z',
        },
      ] });
    }
    return response(404, { error: { message: 'unexpected URL' } });
  };
  const normalized = await fetchMeetTranscript(records[0], {
    getToken: async () => 'token',
    fetchFn: fetchFn as typeof fetch,
  });
  assert.equal(normalized.externalId, 'conferenceRecords/conf-1/transcripts/transcript-1');
  assert.deepEqual(normalized.segments.map((segment) => segment.speaker), ['Alice', 'Guest Bob']);
  assert.deepEqual(normalized.segments.map((segment) => segment.startMs), [5000, 20000]);

  await assert.rejects(
    () => fetchMeetTranscript(records[0], {
      getToken: async () => 'token',
      fetchFn: (async (url: any) => {
        if (String(url).includes('/transcripts?')) {
          return response(200, { transcripts: [{
            name: 'conferenceRecords/conf-1/transcripts/still-generating',
            state: 'ENDED',
            startTime: '2026-08-01T10:00:10Z',
          }] });
        }
        throw new Error('entries must not be fetched before FILE_GENERATED');
      }) as typeof fetch,
    }),
    /No native transcript is available/,
  );

  console.log('meet-api: all tests passed');
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { run };
