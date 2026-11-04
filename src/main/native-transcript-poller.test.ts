import * as assert from 'node:assert/strict';
import { syncNativeTranscripts, NativeSyncDeps } from './native-transcript-poller';

async function run() {
  const ingested: string[] = [];
  const deps: NativeSyncDeps = {
    connected: async () => true,
    list: async () => ['old', 'new', 'pending', 'denied'].map(title => ({ title })),
    prepare: async meeting => {
      if (meeting.title === 'pending') throw new Error('No native transcript is available for this Google Meet conference.');
      if (meeting.title === 'denied') throw new Error('HTTP 403');
      return { meetingId: meeting.title, externalId: meeting.title, title: meeting.title, startedAt: '2026-11-02T10:00:00Z', segments: [{ speaker: 'Alice', startMs: 0, endMs: 1000, text: 'Hello' }] };
    },
    existing: async (_, id) => id === 'old' ? { transcript: 'Alice: Hello', insights: { summary: 'Saved' } } : null,
    ingest: async (normalized, source) => { assert.equal(source, 'meet_transcript'); ingested.push(normalized.meetingId); return normalized.meetingId; },
  };
  const result = await syncNativeTranscripts('meet', deps);
  assert.deepEqual(ingested, ['new']);
  assert.deepEqual({ ...result, errors: [] }, { checked: 4, imported: 1, skipped: 1, unavailable: 1, errors: [] });
  assert.deepEqual(result.errors, ['denied: HTTP 403']);
  await syncNativeTranscripts('meet', { ...deps, connected: async () => false, list: async () => { throw new Error('must not fetch'); } });
  // Saved transcripts with failed insights remain eligible for retry.
  const retry = await syncNativeTranscripts('meet', { ...deps, list: async () => [{ title: 'old' }], existing: async () => ({ transcript: 'Alice: Hello', status: 'transcribed' }) });
  assert.equal(retry.imported, 1);
  console.log('native-transcript-poller: all tests passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
