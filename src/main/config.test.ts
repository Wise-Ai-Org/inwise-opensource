import * as assert from 'node:assert/strict';
import { computeDaysSince } from './config';

function run(): void {
  const nowMs = new Date('2026-04-21T12:00:00.000Z').getTime();

  // Null input → null (first-ever launch)
  assert.equal(computeDaysSince(null, nowMs), null);

  // Invalid date string → null
  assert.equal(computeDaysSince('not-a-date', nowMs), null);

  // Empty string → null (falsy path)
  assert.equal(computeDaysSince('', nowMs), null);

  // Exactly 2 days ago → 2.0
  const twoDaysAgo = new Date(nowMs - 2 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(computeDaysSince(twoDaysAgo, nowMs), 2);

  // Exactly 14 days ago → 14.0
  const fourteenDaysAgo = new Date(nowMs - 14 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(computeDaysSince(fourteenDaysAgo, nowMs), 14);

  // Same instant → 0
  const nowIso = new Date(nowMs).toISOString();
  assert.equal(computeDaysSince(nowIso, nowMs), 0);

  // Future timestamp → negative (clock skew; caller decides how to handle)
  const inOneDay = new Date(nowMs + 24 * 60 * 60 * 1000).toISOString();
  assert.equal(computeDaysSince(inOneDay, nowMs), -1);

  // Fractional half-day ≈ 0.5
  const halfDayAgo = new Date(nowMs - 12 * 60 * 60 * 1000).toISOString();
  assert.equal(computeDaysSince(halfDayAgo, nowMs), 0.5);

  console.log('config: all tests passed');
}

if (require.main === module) {
  run();
}

export { run };
