import * as assert from 'node:assert/strict';
import { computeWelcomeBack, WelcomeBackInputs } from './welcome-back';

const NOW = new Date('2026-04-21T12:00:00.000Z');
const NOW_MS = NOW.getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

function iso(daysAgo: number): string {
  return new Date(NOW_MS - daysAgo * DAY_MS).toISOString();
}

function baseInputs(overrides: Partial<WelcomeBackInputs> = {}): WelcomeBackInputs {
  // Default inputs represent a 5-day gap, never-dismissed, no data.
  return {
    now: NOW,
    daysSinceLastOpen: 5,
    lastOpenedAtSnapshot: iso(5),
    welcomeBackLastSeenAt: null,
    openAtLogin: false,
    lastSweepResult: null,
    tasks: [],
    meetings: [],
    upcomingEvents: [],
    ...overrides,
  };
}

async function run(): Promise<void> {
  // ── Null-return gates ────────────────────────────────────────────────────

  // Gate 1: first-ever launch (null gap) → null
  {
    const r = computeWelcomeBack(
      baseInputs({ daysSinceLastOpen: null, lastOpenedAtSnapshot: null }),
    );
    assert.equal(r, null, 'null gap → null');
  }

  // Gate 2: gap < 2 days → null
  {
    const r = computeWelcomeBack(baseInputs({ daysSinceLastOpen: 1, lastOpenedAtSnapshot: iso(1) }));
    assert.equal(r, null, 'gap < 2 days → null');
  }

  // Gate 3: already dismissed since prior open → null
  {
    const r = computeWelcomeBack(
      baseInputs({
        daysSinceLastOpen: 5,
        lastOpenedAtSnapshot: iso(5),
        welcomeBackLastSeenAt: iso(4), // dismissed 4d ago, after prior open (5d ago)
      }),
    );
    assert.equal(r, null, 'already dismissed since prior open → null');
  }

  // Gate 3 counter: dismissal is OLDER than prior open → show
  {
    const r = computeWelcomeBack(
      baseInputs({
        daysSinceLastOpen: 5,
        lastOpenedAtSnapshot: iso(5),
        welcomeBackLastSeenAt: iso(10), // dismissed 10d ago, before prior open (5d ago)
      }),
    );
    assert.ok(r, 'old dismissal does not suppress → welcome-back shows');
    assert.equal(r!.gapDays, 5);
  }

  // Gate 3 edge: gap qualifies, no prior dismiss → show
  {
    const r = computeWelcomeBack(baseInputs({ daysSinceLastOpen: 3, lastOpenedAtSnapshot: iso(3) }));
    assert.ok(r, 'first-ever welcome-back with gap >= 2 → shows');
  }

  // ── Wins ─────────────────────────────────────────────────────────────────

  // wins.cleared comes from lastSweepResult
  {
    const r = computeWelcomeBack(
      baseInputs({
        lastSweepResult: {
          snoozed: [
            { _id: 't1', title: 'First stale' },
            { _id: 't2', title: 'Second stale' },
            { _id: 't3', title: 'Third stale' },
            { _id: 't4', title: 'Fourth stale' },
          ],
        },
      }),
    );
    assert.ok(r);
    assert.equal(r!.wins.cleared?.count, 4);
    assert.deepEqual(r!.wins.cleared?.sampleTitles, ['First stale', 'Second stale', 'Third stale']);
  }

  // wins.jiraProgress counts jira-linked tasks updated in gap
  {
    const r = computeWelcomeBack(
      baseInputs({
        tasks: [
          { _id: 'a', source: { type: 'jira' }, updatedAt: iso(1), status: 'completed' },
          { _id: 'b', source: { type: 'jira' }, updatedAt: iso(2), status: 'inProgress' },
          { _id: 'c', source: { type: 'jira' }, updatedAt: iso(10), status: 'completed' }, // before gap
          { _id: 'd', source: { type: 'manual' }, updatedAt: iso(1), status: 'completed' }, // not jira
        ],
      }),
    );
    assert.ok(r);
    assert.equal(r!.wins.jiraProgress?.count, 2);
    assert.equal(r!.wins.jiraProgress?.doneCount, 1);
  }

  // wins.meetingsMatched counts distinct meetings with jira-linked tasks in gap
  {
    const r = computeWelcomeBack(
      baseInputs({
        tasks: [
          { _id: 't1', source: { type: 'jira' }, provenance: { meetingId: 'm1' } },
          { _id: 't2', source: { type: 'jira' }, provenance: { meetingId: 'm1' } }, // dup meeting
          { _id: 't3', source: { type: 'jira' }, provenance: { meetingId: 'm2' } },
          { _id: 't4', source: { type: 'jira' }, provenance: { meetingId: 'm-old' } }, // outside gap
        ],
        meetings: [
          { _id: 'm1', createdAt: iso(1), insights: null },
          { _id: 'm2', createdAt: iso(2), insights: null },
          { _id: 'm-old', createdAt: iso(30), insights: null },
        ],
      }),
    );
    assert.ok(r);
    assert.equal(r!.wins.meetingsMatched?.count, 2);
  }

  // wins.calendarHealthy only includes events in next 7 days
  {
    const r = computeWelcomeBack(
      baseInputs({
        upcomingEvents: [
          { id: 'e1', startTime: new Date(NOW_MS + 1 * DAY_MS) },
          { id: 'e2', startTime: new Date(NOW_MS + 6 * DAY_MS) },
          { id: 'e3', startTime: new Date(NOW_MS + 10 * DAY_MS) }, // beyond 7d
          { id: 'e4', startTime: new Date(NOW_MS - 1 * DAY_MS) }, // in the past
        ],
      }),
    );
    assert.ok(r);
    assert.equal(r!.wins.calendarHealthy?.upcomingCount, 2);
  }

  // No wins, no ask → empty wins object, no ask (US-005 renders empty-state)
  {
    const r = computeWelcomeBack(baseInputs());
    assert.ok(r);
    assert.deepEqual(r!.wins, {});
    assert.equal(r!.ask, undefined);
  }

  // ── Ask-selection priority ───────────────────────────────────────────────

  // Priority 1: contradiction beats overdueWithSignal
  {
    const r = computeWelcomeBack(
      baseInputs({
        meetings: [
          {
            _id: 'm1',
            title: 'Eng sync',
            createdAt: iso(1),
            insights: {
              contradictions: [
                { text: 'Budget change contradicts prior cap', previousDecision: 'Cap at 30k' },
              ],
            },
          },
        ],
        tasks: [
          {
            _id: 't-overdue',
            title: 'overdue task',
            dueDate: iso(1),
            lastMentionedAt: iso(2),
            status: 'todo',
          },
        ],
      }),
    );
    assert.ok(r);
    assert.equal(r!.ask?.kind, 'contradiction');
    assert.equal(r!.ask?.payload.meetingId, 'm1');
    assert.equal(r!.ask?.payload.summary, 'Budget change contradicts prior cap');
  }

  // Priority 1 guard: old contradiction (before prior open) does NOT qualify
  {
    const r = computeWelcomeBack(
      baseInputs({
        meetings: [
          {
            _id: 'm-old',
            title: 'Old meeting',
            createdAt: iso(30), // before priorOpen (5d ago)
            insights: { contradictions: [{ text: 'old', previousDecision: 'old' }] },
          },
        ],
      }),
    );
    assert.ok(r);
    assert.equal(r!.ask, undefined, 'old contradiction is not asked');
  }

  // Priority 2: overdueWithSignal when no contradiction
  {
    const r = computeWelcomeBack(
      baseInputs({
        tasks: [
          {
            _id: 't-overdue',
            title: 'Ship v2',
            dueDate: iso(1),
            lastMentionedAt: iso(2),
            status: 'todo',
          },
        ],
      }),
    );
    assert.ok(r);
    assert.equal(r!.ask?.kind, 'overdueWithSignal');
    assert.equal(r!.ask?.payload.taskId, 't-overdue');
    assert.equal(r!.ask?.payload.title, 'Ship v2');
  }

  // Priority 2 guard: overdue task with stale mention (>14d ago) does NOT qualify
  {
    const r = computeWelcomeBack(
      baseInputs({
        tasks: [
          {
            _id: 't',
            title: 'No signal',
            dueDate: iso(1),
            lastMentionedAt: iso(20),
            status: 'todo',
          },
        ],
      }),
    );
    assert.ok(r);
    assert.equal(r!.ask, undefined, 'stale-mention overdue does not ask');
  }

  // Priority 2 guard: overdue task with no lastMentionedAt does NOT qualify
  {
    const r = computeWelcomeBack(
      baseInputs({
        tasks: [
          {
            _id: 't',
            title: 'Never mentioned',
            dueDate: iso(1),
            lastMentionedAt: null,
            status: 'todo',
          },
        ],
      }),
    );
    assert.ok(r);
    assert.equal(r!.ask, undefined, 'no lastMentionedAt → no overdue ask');
  }

  // Priority 2 guard: snoozed task with signal does NOT qualify
  {
    const r = computeWelcomeBack(
      baseInputs({
        tasks: [
          {
            _id: 't',
            title: 'Snoozed',
            dueDate: iso(1),
            lastMentionedAt: iso(2),
            status: 'todo',
            snoozedAt: iso(1),
          },
        ],
      }),
    );
    assert.ok(r);
    assert.equal(r!.ask, undefined, 'snoozed overdue does not ask');
  }

  // Priority 3: launchAtStartupOffer when gap >= 3 AND 3+ missed meetings AND !openAtLogin
  {
    const r = computeWelcomeBack(
      baseInputs({
        daysSinceLastOpen: 5,
        lastOpenedAtSnapshot: iso(5),
        openAtLogin: false,
        upcomingEvents: [
          { id: 'p1', startTime: new Date(NOW_MS - 2 * DAY_MS) },
          { id: 'p2', startTime: new Date(NOW_MS - 3 * DAY_MS) },
          { id: 'p3', startTime: new Date(NOW_MS - 4 * DAY_MS) },
        ],
        meetings: [], // none recorded → all three are "missed"
      }),
    );
    assert.ok(r);
    assert.equal(r!.ask?.kind, 'launchAtStartupOffer');
    assert.equal(r!.ask?.payload.missedMeetingsCount, 3);
  }

  // Priority 3 guard: openAtLogin=true suppresses the offer even with missed meetings
  {
    const r = computeWelcomeBack(
      baseInputs({
        daysSinceLastOpen: 5,
        lastOpenedAtSnapshot: iso(5),
        openAtLogin: true,
        upcomingEvents: [
          { id: 'p1', startTime: new Date(NOW_MS - 2 * DAY_MS) },
          { id: 'p2', startTime: new Date(NOW_MS - 3 * DAY_MS) },
          { id: 'p3', startTime: new Date(NOW_MS - 4 * DAY_MS) },
        ],
      }),
    );
    assert.ok(r);
    assert.equal(r!.ask, undefined, 'openAtLogin=true suppresses launch offer');
  }

  // Priority 3 guard: gap < 3 days suppresses the offer
  {
    const r = computeWelcomeBack(
      baseInputs({
        daysSinceLastOpen: 2,
        lastOpenedAtSnapshot: iso(2),
        upcomingEvents: [
          { id: 'p1', startTime: new Date(NOW_MS - 1 * DAY_MS) },
          { id: 'p2', startTime: new Date(NOW_MS - 1.5 * DAY_MS) },
          { id: 'p3', startTime: new Date(NOW_MS - 1.8 * DAY_MS) },
        ],
      }),
    );
    assert.ok(r);
    assert.equal(r!.ask, undefined, 'gap < 3 → no launch offer');
  }

  // Priority 3 guard: <3 missed meetings → no offer
  {
    const r = computeWelcomeBack(
      baseInputs({
        daysSinceLastOpen: 5,
        lastOpenedAtSnapshot: iso(5),
        openAtLogin: false,
        upcomingEvents: [
          { id: 'p1', startTime: new Date(NOW_MS - 2 * DAY_MS) },
          { id: 'p2', startTime: new Date(NOW_MS - 3 * DAY_MS) },
        ],
      }),
    );
    assert.ok(r);
    assert.equal(r!.ask, undefined, '<3 missed → no launch offer');
  }

  // Priority 3 guard: processed meeting (non-calendar_sync row) does NOT count as missed
  {
    const r = computeWelcomeBack(
      baseInputs({
        daysSinceLastOpen: 5,
        lastOpenedAtSnapshot: iso(5),
        openAtLogin: false,
        upcomingEvents: [
          { id: 'p1', startTime: new Date(NOW_MS - 2 * DAY_MS) },
          { id: 'p2', startTime: new Date(NOW_MS - 3 * DAY_MS) },
          { id: 'p3', startTime: new Date(NOW_MS - 4 * DAY_MS) },
        ],
        meetings: [
          { _id: 'm1', calendarEventId: 'p1', status: 'processed', createdAt: iso(2) },
          { _id: 'm2', calendarEventId: 'p2', status: 'processed', createdAt: iso(3) },
          // p3 is still missed, but that's only 1 → no offer
        ],
      }),
    );
    assert.ok(r);
    assert.equal(r!.ask, undefined, 'processed rows reduce missed count below threshold');
  }

  // Priority 3 guard: calendar_sync placeholder row STILL counts as missed
  {
    const r = computeWelcomeBack(
      baseInputs({
        daysSinceLastOpen: 5,
        lastOpenedAtSnapshot: iso(5),
        openAtLogin: false,
        upcomingEvents: [
          { id: 'p1', startTime: new Date(NOW_MS - 2 * DAY_MS) },
          { id: 'p2', startTime: new Date(NOW_MS - 3 * DAY_MS) },
          { id: 'p3', startTime: new Date(NOW_MS - 4 * DAY_MS) },
        ],
        meetings: [
          { _id: 'm1', calendarEventId: 'p1', status: 'calendar_sync', createdAt: iso(2) },
          { _id: 'm2', calendarEventId: 'p2', status: 'calendar_sync', createdAt: iso(3) },
          { _id: 'm3', calendarEventId: 'p3', status: 'calendar_sync', createdAt: iso(4) },
        ],
      }),
    );
    assert.ok(r);
    assert.equal(r!.ask?.kind, 'launchAtStartupOffer');
    assert.equal(r!.ask?.payload.missedMeetingsCount, 3);
  }

  console.log('welcome-back: all tests passed');
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { run };
