import * as assert from 'node:assert/strict';
import {
  computeDailyPlanGate,
  selectTodaysMeetings,
  hasAgendaHistory,
  selectAgendaHistory,
  buildAgendaBasis,
  buildGreeting,
  isSameLocalDay,
  DailyPlanEvent,
} from './daily-plan';

// Fixed local-time reference: a Tuesday at 09:00 local.
const NOW = new Date(2026, 6, 28, 9, 0, 0);

function at(hour: number, minute = 0, dayOffset = 0): Date {
  return new Date(2026, 6, 28 + dayOffset, hour, minute, 0);
}

function ev(
  id: string,
  start: Date,
  end: Date,
  attendees: string[] = ['ana@x.com'],
  seriesUid: string | null = null,
): DailyPlanEvent {
  return { id, title: `Meeting ${id}`, startTime: start, endTime: end, attendees, seriesUid };
}

// ── computeDailyPlanGate ─────────────────────────────────────────────────────

assert.equal(
  computeDailyPlanGate({ now: NOW, enabled: false, lastShownAt: null, liveMeeting: false }),
  'disabled',
  'disabled pref wins over everything',
);

assert.equal(
  computeDailyPlanGate({ now: NOW, enabled: true, lastShownAt: at(7).toISOString(), liveMeeting: false }),
  'already-shown',
  'shown earlier the same local day → already-shown',
);

assert.equal(
  computeDailyPlanGate({ now: NOW, enabled: true, lastShownAt: at(20, 0, -1).toISOString(), liveMeeting: false }),
  'show',
  'shown yesterday evening → show again today',
);

assert.equal(
  computeDailyPlanGate({ now: NOW, enabled: true, lastShownAt: null, liveMeeting: true }),
  'defer',
  'live meeting at fire time → defer',
);

assert.equal(
  computeDailyPlanGate({ now: NOW, enabled: true, lastShownAt: 'garbage', liveMeeting: false }),
  'show',
  'unparseable lastShownAt is treated as never shown',
);

assert.equal(
  computeDailyPlanGate({ now: NOW, enabled: true, lastShownAt: at(7).toISOString(), liveMeeting: true }),
  'already-shown',
  'already-shown wins over defer',
);

// ── isSameLocalDay ───────────────────────────────────────────────────────────

assert.equal(isSameLocalDay(at(0, 1), at(23, 59)), true);
assert.equal(isSameLocalDay(at(23, 59, -1), at(0, 1)), false);

// ── selectTodaysMeetings ─────────────────────────────────────────────────────

{
  const events = [
    ev('tomorrow', at(9, 0, 1), at(10, 0, 1)),
    ev('ended', at(7), at(8, 30)),
    ev('afternoon', at(15), at(16)),
    ev('in-progress', at(8, 45), at(9, 30)),
    ev('late-morning', at(11), at(12)),
  ];
  const picked = selectTodaysMeetings(events, NOW);
  assert.deepEqual(
    picked.map((e) => e.id),
    ['in-progress', 'late-morning', 'afternoon'],
    'keeps today\'s unfinished meetings sorted by start; drops ended + other days',
  );

  assert.equal(selectTodaysMeetings(events, NOW, 2).length, 2, 'cap is respected');
}

// ── hasAgendaHistory ─────────────────────────────────────────────────────────

{
  const past = [
    {
      title: 'Weekly sync',
      date: at(9, 0, -7).toISOString(),
      attendees: ['Ana Torres', 'Shrav'],
      seriesUid: 'weekly-sync',
      insights: { actionItems: [{ text: 'Send the launch brief' }] },
    },
  ];

  assert.equal(
    hasAgendaHistory(past, ev('one-off', at(11), at(12), ['Shrav'], null)),
    false,
    'a one-time event never inherits history from a shared attendee (including self)',
  );
  assert.equal(
    hasAgendaHistory(past, ev('renamed', at(11), at(12), [], 'weekly-sync')),
    true,
    'an exact recurring-series match with substantive evidence qualifies',
  );
  assert.equal(
    hasAgendaHistory(past, ev('Weekly sync', at(11), at(12), [], 'different-series')),
    false,
    'a matching title in a different series does not qualify',
  );
  assert.equal(
    hasAgendaHistory([], ev('anything', at(11), at(12), [], 'series')),
    false,
    'empty history never matches',
  );
}

// Low-signal recordings are filtered before the history cap is applied.
{
  const seriesUid = 'daily-standup';
  const lowSignal = [1, 2, 3].map((daysAgo) => ({
    title: 'Daily standup',
    date: at(9, 0, -daysAgo).toISOString(),
    seriesUid,
    insights: { summary: daysAgo === 1 ? 'Coughing.' : '' },
  }));
  const substantive = {
    title: 'Daily standup',
    date: at(9, 0, -7).toISOString(),
    seriesUid,
    insights: { decisions: [{ text: 'Ship the revised launch page' }] },
  };
  const unrelated = {
    title: 'Daily standup',
    date: at(9, 0, -8).toISOString(),
    seriesUid: 'another-series',
    insights: { actionItems: [{ text: 'Should never appear' }] },
  };

  const picked = selectAgendaHistory(
    [...lowSignal, substantive, unrelated],
    ev('today', at(11), at(12), [], seriesUid),
  );
  assert.deepEqual(picked.map(meeting => meeting.date), [substantive.date]);
  assert.equal(buildAgendaBasis(picked), 'Based on Jul 21: Daily standup');
}

// ── buildGreeting ────────────────────────────────────────────────────────────

{
  const morning = buildGreeting(at(9), 'Shrav');
  assert.ok(morning.title.startsWith('Good morning'), 'morning greeting');
  assert.ok(morning.title.includes('Shrav'), 'greeting uses the name');
  assert.ok(morning.sub.length > 0, 'sub line is never empty');
  assert.ok(morning.sub.includes('Wiser'), 'sub line is in the Wiser voice');

  const evening = buildGreeting(at(19), '');
  assert.equal(evening.title, 'Good evening', 'no trailing comma without a name');

  // Deterministic per day: same date → same sub.
  assert.equal(buildGreeting(at(9), '').sub, buildGreeting(at(14), '').sub);
}

console.log('daily-plan tests passed');
