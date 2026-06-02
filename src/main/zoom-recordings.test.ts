import * as assert from 'node:assert/strict';
import { listZoomRecordings, getTranscriptDownloadUrl } from './zoom-recordings';

function mockFetch(status: number, body: unknown): typeof fetch {
  return async (_url: any, _init?: any) => {
    const text = JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
      json: async () => body,
    } as Response;
  };
}

const stubToken = async () => 'test-access-token';

async function run(): Promise<void> {
  // ── listZoomRecordings maps API response correctly ─────────────────────────
  {
    const apiResponse = {
      meetings: [
        { id: 123456, uuid: 'abc==', topic: 'Weekly Sync', start_time: '2026-05-28T10:00:00Z' },
        { id: 789012, uuid: 'def==', topic: 'Planning', start_time: '2026-05-29T14:00:00Z' },
      ],
    };
    const results = await listZoomRecordings({ getToken: stubToken, fetchFn: mockFetch(200, apiResponse) });
    assert.equal(results.length, 2, 'returns two recordings');
    assert.equal(results[0].meetingId, '123456', 'meetingId stringified');
    assert.equal(results[0].uuid, 'abc==', 'uuid preserved');
    assert.equal(results[0].title, 'Weekly Sync', 'title from topic');
    assert.equal(results[0].startedAt, '2026-05-28T10:00:00Z', 'startedAt from start_time');
  }

  // ── listZoomRecordings returns empty array when no meetings ────────────────
  {
    const results = await listZoomRecordings({ getToken: stubToken, fetchFn: mockFetch(200, { meetings: [] }) });
    assert.deepEqual(results, [], 'empty array for no meetings');
  }

  // ── listZoomRecordings handles missing meetings key ────────────────────────
  {
    const results = await listZoomRecordings({ getToken: stubToken, fetchFn: mockFetch(200, {}) });
    assert.deepEqual(results, [], 'empty array when meetings key absent');
  }

  // ── listZoomRecordings throws on HTTP error ────────────────────────────────
  {
    let threw = false;
    try {
      await listZoomRecordings({ getToken: stubToken, fetchFn: mockFetch(401, 'Unauthorized') });
    } catch (e: any) {
      threw = true;
      assert.ok(e.message.includes('HTTP 401'), 'error includes status code');
    }
    assert.ok(threw, 'throws on 401');
  }

  // ── getTranscriptDownloadUrl returns found=true when TRANSCRIPT exists ─────
  {
    const recordingDetail = {
      uuid: 'abc==',
      recording_files: [
        { file_type: 'MP4', status: 'completed', download_url: 'https://zoom.us/download/video.mp4' },
        { file_type: 'TRANSCRIPT', status: 'completed', download_url: 'https://zoom.us/download/transcript.vtt' },
        { file_type: 'CHAT', status: 'completed', download_url: 'https://zoom.us/download/chat.txt' },
      ],
    };
    const result = await getTranscriptDownloadUrl('abc==', { getToken: stubToken, fetchFn: mockFetch(200, recordingDetail) });
    assert.equal(result.found, true, 'found=true when TRANSCRIPT file present');
    if (result.found) {
      assert.equal(result.downloadUrl, 'https://zoom.us/download/transcript.vtt', 'returns TRANSCRIPT download url');
      assert.equal(result.accessToken, 'test-access-token', 'returns access token');
    }
  }

  // ── getTranscriptDownloadUrl returns found=false when no TRANSCRIPT file ───
  {
    const recordingDetail = {
      uuid: 'abc==',
      recording_files: [
        { file_type: 'MP4', status: 'completed', download_url: 'https://zoom.us/download/video.mp4' },
      ],
    };
    const result = await getTranscriptDownloadUrl('abc==', { getToken: stubToken, fetchFn: mockFetch(200, recordingDetail) });
    assert.equal(result.found, false, 'found=false when no TRANSCRIPT file');
    if (!result.found) {
      assert.equal(result.reason, 'No transcript available for this recording', 'clear reason returned');
    }
  }

  // ── getTranscriptDownloadUrl skips TRANSCRIPT with non-completed status ────
  {
    const recordingDetail = {
      recording_files: [
        { file_type: 'TRANSCRIPT', status: 'processing', download_url: 'https://zoom.us/download/t.vtt' },
      ],
    };
    const result = await getTranscriptDownloadUrl('abc==', { getToken: stubToken, fetchFn: mockFetch(200, recordingDetail) });
    assert.equal(result.found, false, 'ignores in-progress transcript');
  }

  // ── getTranscriptDownloadUrl returns found=false on HTTP error ─────────────
  {
    const result = await getTranscriptDownloadUrl('abc==', { getToken: stubToken, fetchFn: mockFetch(404, 'Not Found') });
    assert.equal(result.found, false, 'found=false on 404');
    if (!result.found) {
      assert.ok(result.reason.includes('HTTP 404'), 'reason includes status');
    }
  }

  // ── getTranscriptDownloadUrl handles empty recording_files array ───────────
  {
    const result = await getTranscriptDownloadUrl('abc==', { getToken: stubToken, fetchFn: mockFetch(200, { recording_files: [] }) });
    assert.equal(result.found, false, 'found=false on empty files');
  }

  console.log('zoom-recordings: all tests passed');
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { run };
