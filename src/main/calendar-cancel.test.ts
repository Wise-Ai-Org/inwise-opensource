import * as assert from 'node:assert/strict';
import { isCancelledEvent, isCancelledOccurrence } from './calendar-watcher';

// ── isCancelledEvent ─────────────────────────────────────────────────────────

assert.equal(isCancelledEvent({ status: 'CANCELLED' }), true, 'uppercase status');
assert.equal(isCancelledEvent({ status: 'cancelled' }), true, 'case-insensitive');
assert.equal(isCancelledEvent({ status: 'CONFIRMED' }), false, 'confirmed is kept');
assert.equal(isCancelledEvent({}), false, 'missing status is kept');

// ── isCancelledOccurrence ────────────────────────────────────────────────────

const OCC = new Date('2026-07-27T16:00:00.000Z');

// EXDATE removes the instance (exact match).
assert.equal(
  isCancelledOccurrence({ exdate: { '2026-07-27': new Date('2026-07-27T16:00:00.000Z') } }, OCC),
  true,
  'exdate exact match cancels the occurrence',
);

// EXDATE within the 60s tolerance still matches (feed rounding).
assert.equal(
  isCancelledOccurrence({ exdate: { '2026-07-27': new Date('2026-07-27T16:00:30.000Z') } }, OCC),
  true,
  'exdate within tolerance cancels',
);

// EXDATE for a different instance does not cancel this one.
assert.equal(
  isCancelledOccurrence({ exdate: { '2026-07-20': new Date('2026-07-20T16:00:00.000Z') } }, OCC),
  false,
  'other-week exdate leaves this occurrence alone',
);

// RECURRENCE-ID override carrying STATUS:CANCELLED cancels its instance.
assert.equal(
  isCancelledOccurrence(
    { recurrences: { '2026-07-27': { recurrenceid: new Date('2026-07-27T16:00:00.000Z'), status: 'CANCELLED' } } },
    OCC,
  ),
  true,
  'cancelled override instance is skipped',
);

// An override that merely reschedules (not cancelled) keeps the occurrence.
assert.equal(
  isCancelledOccurrence(
    { recurrences: { '2026-07-27': { recurrenceid: new Date('2026-07-27T16:00:00.000Z'), status: 'CONFIRMED' } } },
    OCC,
  ),
  false,
  'non-cancelled override does not skip',
);

// Garbage dates never throw or match.
assert.equal(
  isCancelledOccurrence({ exdate: { bad: 'not-a-date' } }, OCC),
  false,
  'unparseable exdate is ignored',
);

assert.equal(isCancelledOccurrence({}, OCC), false, 'no exceptions → keep');

console.log('calendar-cancel tests passed');
