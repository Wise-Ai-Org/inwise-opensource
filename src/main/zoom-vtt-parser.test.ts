import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseTimestampMs, parseZoomVtt, downloadAndParseVtt } from './zoom-vtt-parser';

function mockFetch(status: number, body: string): typeof fetch {
  return async (_url: any, _init?: any) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => ({}),
  } as Response);
}

async function run(): Promise<void> {
  // ── parseTimestampMs ────────────────────────────────────────────────────────
  {
    assert.equal(parseTimestampMs('00:00:00.000'), 0, 'zero timestamp');
    assert.equal(parseTimestampMs('00:00:01.000'), 1000, '1 second');
    assert.equal(parseTimestampMs('00:01:00.000'), 60000, '1 minute');
    assert.equal(parseTimestampMs('01:00:00.000'), 3600000, '1 hour');
    assert.equal(parseTimestampMs('00:00:04.159'), 4159, 'fractional milliseconds');
    assert.equal(parseTimestampMs('00:00:09.959'), 9959, 'fractional ms 2');
    assert.equal(parseTimestampMs('00:00:21.500'), 21500, 'fractional ms 3');
    assert.equal(parseTimestampMs('-00:00:01.250'), -1250, 'negative Teams offset');
    assert.equal(parseTimestampMs('00:00:01,500'), 1500, 'comma decimal separator');
  }

  // ── parseZoomVtt: fixture file ──────────────────────────────────────────────
  {
    const fixturePath = path.join(__dirname, '../../test-transcripts/zoom-sample.vtt');
    const vttContent = fs.readFileSync(fixturePath, 'utf8');
    const result = parseZoomVtt(vttContent, 'meeting-123', 'Test Meeting', '2026-05-28T10:00:00Z');

    assert.equal(result.meetingId, 'meeting-123', 'meetingId preserved');
    assert.equal(result.title, 'Test Meeting', 'title preserved');
    assert.equal(result.startedAt, '2026-05-28T10:00:00Z', 'startedAt preserved');
    assert.equal(result.segments.length, 4, 'four segments parsed');

    const [s0, s1, s2, s3] = result.segments;

    assert.equal(s0.speaker, 'John Doe', 'cue 1: speaker');
    assert.equal(s0.startMs, 0, 'cue 1: startMs');
    assert.equal(s0.endMs, 4159, 'cue 1: endMs');
    assert.ok(s0.text.includes('Hello'), 'cue 1: text');

    assert.equal(s1.speaker, 'Jane Smith', 'cue 2: speaker');
    assert.equal(s1.startMs, 4739, 'cue 2: startMs');
    assert.equal(s1.endMs, 9959, 'cue 2: endMs');

    assert.equal(s2.speaker, 'John Doe', 'cue 3: speaker');
    assert.equal(s2.startMs, 10219, 'cue 3: startMs');

    assert.equal(s3.speaker, 'Jane Smith', 'cue 4: speaker');
    assert.equal(s3.startMs, 16000, 'cue 4: startMs');
    assert.equal(s3.endMs, 21500, 'cue 4: endMs');
    assert.ok(s3.text.includes('roadmap'), 'cue 4: text');
  }

  // ── parseZoomVtt: cue without speaker prefix → Unknown ─────────────────────
  {
    const vtt = 'WEBVTT\n\n1\n00:00:00.000 --> 00:00:03.000\nNo speaker label here';
    const result = parseZoomVtt(vtt, 'm1', 'T', '2026-01-01T00:00:00Z');
    assert.equal(result.segments.length, 1, 'one segment');
    assert.equal(result.segments[0].speaker, 'Unknown', 'no prefix → Unknown');
    assert.equal(result.segments[0].text, 'No speaker label here', 'text preserved');
  }

  // ── parseZoomVtt: CRLF line endings ────────────────────────────────────────
  {
    const vtt = 'WEBVTT\r\n\r\n1\r\n00:00:00.000 --> 00:00:02.000\r\nAlice: Hi there.';
    const result = parseZoomVtt(vtt, 'm2', 'T2', '2026-01-01T00:00:00Z');
    assert.equal(result.segments.length, 1, 'CRLF: one segment');
    assert.equal(result.segments[0].speaker, 'Alice', 'CRLF: speaker');
    assert.equal(result.segments[0].text, 'Hi there.', 'CRLF: text');
  }

  // ── parseZoomVtt: empty content → no segments ──────────────────────────────
  {
    const result = parseZoomVtt('WEBVTT\n', 'm3', 'T3', '2026-01-01T00:00:00Z');
    assert.deepEqual(result.segments, [], 'empty VTT → empty segments');
  }

  // ── parseZoomVtt: text with colon in body doesn't corrupt speaker ───────────
  {
    const vtt = 'WEBVTT\n\n1\n00:00:00.000 --> 00:00:05.000\nBob: The time is 3:00 PM.';
    const result = parseZoomVtt(vtt, 'm4', 'T4', '2026-01-01T00:00:00Z');
    assert.equal(result.segments[0].speaker, 'Bob', 'colon in text: speaker correct');
    assert.equal(result.segments[0].text, 'The time is 3:00 PM.', 'colon in text: text correct');
  }

  // ── downloadAndParseVtt: downloads and parses ──────────────────────────────
  {
    const vttContent = 'WEBVTT\n\n1\n00:00:00.000 --> 00:00:05.000\nBob: Let\'s begin.\n';
    const result = await downloadAndParseVtt(
      'https://zoom.us/download/t.vtt',
      'token-123',
      'meet-456',
      'Bob Meeting',
      '2026-06-01T09:00:00Z',
      { fetchFn: mockFetch(200, vttContent) },
    );
    assert.equal(result.meetingId, 'meet-456', 'meetingId');
    assert.equal(result.segments.length, 1, 'one segment');
    assert.equal(result.segments[0].speaker, 'Bob', 'speaker');
    assert.equal(result.segments[0].text, "Let's begin.", 'text');
  }

  // ── downloadAndParseVtt: throws on HTTP error ──────────────────────────────
  {
    let threw = false;
    try {
      await downloadAndParseVtt(
        'https://zoom.us/t.vtt', 'tok', 'm', 'T', '2026-01-01T00:00:00Z',
        { fetchFn: mockFetch(403, 'Forbidden') },
      );
    } catch (e: any) {
      threw = true;
      assert.ok(e.message.includes('HTTP 403'), 'error includes status');
    }
    assert.ok(threw, 'throws on HTTP error');
  }

  console.log('zoom-vtt-parser: all tests passed');
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { run };
