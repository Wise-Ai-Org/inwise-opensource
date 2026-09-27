import * as assert from 'node:assert/strict';
import { syncZoomTranscripts } from './zoom-poller';
import type { ZoomRecordingItem } from './zoom-recordings';

const recordings: ZoomRecordingItem[] = [
  { meetingId: '1', uuid: 'imported', title: 'Already here', startedAt: '2026-07-20T10:00:00Z' },
  { meetingId: '2', uuid: 'ready', title: 'Ready transcript', startedAt: '2026-07-20T11:00:00Z' },
  { meetingId: '3', uuid: 'processing', title: 'Still processing', startedAt: '2026-07-20T12:00:00Z' },
  { meetingId: '4', uuid: 'broken', title: 'Broken download', startedAt: '2026-07-20T13:00:00Z' },
];

async function run(): Promise<void> {
  const attempted: string[] = [];
  const result = await syncZoomTranscripts({
    isConnected: async () => true,
    listRecordings: async () => recordings,
    alreadyImported: async uuid => uuid === 'imported',
    importRecording: async recording => {
      attempted.push(recording.uuid);
      if (recording.uuid === 'ready') return 'local-meeting-id';
      if (recording.uuid === 'processing') return null;
      throw new Error('download failed');
    },
  });

  assert.deepEqual(attempted, ['ready', 'processing', 'broken']);
  assert.deepEqual(result, { checked: 4, imported: 1, skipped: 1, pending: 1, failed: 1 });

  const disconnected = await syncZoomTranscripts({
    isConnected: async () => false,
    listRecordings: async () => { throw new Error('must not list while disconnected'); },
  });
  assert.deepEqual(disconnected, { checked: 0, imported: 0, skipped: 0, pending: 0, failed: 0 });

  console.log('zoom-poller: all tests passed');
}

if (require.main === module) {
  run().catch(error => {
    console.error(error);
    process.exit(1);
  });
}

export { run };
