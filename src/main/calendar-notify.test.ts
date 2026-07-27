import * as assert from 'node:assert/strict';
import { meetingNotifyPhase } from './calendar-watcher';

const NOW = new Date('2026-07-27T17:05:00.000Z').getTime();
const MIN = 60_000;

function ev(startOffsetMin: number, durationMin = 60) {
  const start = new Date(NOW + startOffsetMin * MIN);
  return { startTime: start, endTime: new Date(start.getTime() + durationMin * MIN) };
}

// Normal path: starting within the 5-minute window.
assert.equal(meetingNotifyPhase(ev(0), NOW), 'starting-soon', 'starting right now');
assert.equal(meetingNotifyPhase(ev(4), NOW), 'starting-soon', 'starting in 4m');
assert.equal(meetingNotifyPhase(ev(6), NOW), null, 'starting in 6m — too early');

// Catch-up path: the 10:00 meeting missed when the app launched at 10:05.
assert.equal(meetingNotifyPhase(ev(-5), NOW), 'in-progress', 'started 5m ago, 55m left');
assert.equal(meetingNotifyPhase(ev(-40), NOW), 'in-progress', 'started 40m ago, 20m left');

// Nearly over or already over: not worth surfacing the recorder.
assert.equal(meetingNotifyPhase(ev(-57), NOW), null, 'only 3m left — skip');
assert.equal(meetingNotifyPhase(ev(-90), NOW), null, 'already ended');

console.log('calendar-notify tests passed');
