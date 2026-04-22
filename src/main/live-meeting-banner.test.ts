import * as assert from 'node:assert/strict';
import {
  findLiveMeetingForBanner,
  LIVE_MEETING_FALLBACK_DURATION_MS,
  LiveMeetingCandidateEvent,
} from './live-meeting-banner';

const now = new Date('2026-04-21T20:15:00.000Z');

function makeEvent(partial: Partial<LiveMeetingCandidateEvent> = {}): LiveMeetingCandidateEvent {
  const start = partial.startTime ?? new Date(now.getTime() - 10 * 60_000); // 10min ago
  const end = partial.endTime ?? new Date(start.getTime() + 60 * 60_000);   // 1h long
  return {
    id: partial.id ?? 'evt-1',
    title: partial.title ?? 'Weekly sync',
    startTime: start,
    endTime: end,
    attendees: partial.attendees ?? ['alice@example.com'],
  };
}

function run(): void {
  // Empty events list → null.
  assert.equal(
    findLiveMeetingForBanner({ events: [], now, isRecordingActive: false, overlayWindowOpen: false }),
    null,
  );

  // Happy path: meeting started 10min ago, ends in 50min → returns payload.
  {
    const r = findLiveMeetingForBanner({
      events: [makeEvent()],
      now,
      isRecordingActive: false,
      overlayWindowOpen: false,
    });
    assert.ok(r, 'expected live meeting result');
    assert.equal(r!.id, 'evt-1');
    assert.equal(r!.title, 'Weekly sync');
    assert.deepEqual(r!.attendees, ['alice@example.com']);
    assert.ok(typeof r!.startTime === 'number', 'startTime should be epoch ms');
    assert.ok(typeof r!.endTime === 'number', 'endTime should be epoch ms');
  }

  // Event hasn't started yet → null.
  {
    const future = makeEvent({
      id: 'future',
      startTime: new Date(now.getTime() + 10 * 60_000),
      endTime: new Date(now.getTime() + 60 * 60_000),
    });
    const r = findLiveMeetingForBanner({
      events: [future],
      now,
      isRecordingActive: false,
      overlayWindowOpen: false,
    });
    assert.equal(r, null);
  }

  // Event already ended → null.
  {
    const past = makeEvent({
      id: 'past',
      startTime: new Date(now.getTime() - 3 * 60 * 60_000),
      endTime: new Date(now.getTime() - 2 * 60 * 60_000),
    });
    const r = findLiveMeetingForBanner({
      events: [past],
      now,
      isRecordingActive: false,
      overlayWindowOpen: false,
    });
    assert.equal(r, null);
  }

  // Missing endTime → uses 90min fallback.
  {
    const ev: LiveMeetingCandidateEvent = {
      id: 'no-end',
      title: 'Open-ended sync',
      startTime: new Date(now.getTime() - 30 * 60_000), // 30min ago; fallback carries to +60min
      attendees: [],
    };
    const r = findLiveMeetingForBanner({
      events: [ev],
      now,
      isRecordingActive: false,
      overlayWindowOpen: false,
    });
    assert.ok(r, 'expected fallback-duration match');
    assert.equal(r!.endTime - r!.startTime, LIVE_MEETING_FALLBACK_DURATION_MS);
  }

  // endTime <= startTime (malformed) → fallback kicks in.
  {
    const start = new Date(now.getTime() - 30 * 60_000);
    const ev: LiveMeetingCandidateEvent = {
      id: 'malformed',
      title: 'Broken event',
      startTime: start,
      endTime: start, // zero-duration, treated as malformed
      attendees: [],
    };
    const r = findLiveMeetingForBanner({
      events: [ev],
      now,
      isRecordingActive: false,
      overlayWindowOpen: false,
    });
    assert.ok(r, 'expected fallback when endTime<=startTime');
    assert.equal(r!.endTime - r!.startTime, LIVE_MEETING_FALLBACK_DURATION_MS);
  }

  // isRecordingActive → null regardless of candidate events.
  {
    const r = findLiveMeetingForBanner({
      events: [makeEvent()],
      now,
      isRecordingActive: true,
      overlayWindowOpen: false,
    });
    assert.equal(r, null, 'should suppress when already recording');
  }

  // overlayWindowOpen → null regardless of candidate events.
  {
    const r = findLiveMeetingForBanner({
      events: [makeEvent()],
      now,
      isRecordingActive: false,
      overlayWindowOpen: true,
    });
    assert.equal(r, null, 'should suppress when overlay already open');
  }

  // First matching event wins (iteration order preserved).
  {
    const a = makeEvent({ id: 'first' });
    const b = makeEvent({ id: 'second' });
    const r = findLiveMeetingForBanner({
      events: [a, b],
      now,
      isRecordingActive: false,
      overlayWindowOpen: false,
    });
    assert.ok(r);
    assert.equal(r!.id, 'first');
  }

  // Attendees default to [] when absent on the source event.
  {
    const ev: LiveMeetingCandidateEvent = {
      id: 'no-attendees',
      title: 'Solo focus',
      startTime: new Date(now.getTime() - 5 * 60_000),
      endTime: new Date(now.getTime() + 30 * 60_000),
    };
    const r = findLiveMeetingForBanner({
      events: [ev],
      now,
      isRecordingActive: false,
      overlayWindowOpen: false,
    });
    assert.ok(r);
    assert.deepEqual(r!.attendees, []);
  }

  console.log('live-meeting-banner: all tests passed');
}

if (require.main === module) {
  run();
}

export { run };
