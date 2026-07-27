import * as assert from 'node:assert/strict';
import {
  retrieveCandidates,
  decideMention,
  buildMentionThread,
  computeRepetitionNudge,
  getSeriesUid,
  attendeeOverlap,
  __setLlmForTests,
  TaskMention,
} from './task-dedup';
import { textSimilarity } from './text-similarity';
import {
  RETRIEVAL_FLOOR,
  FALLBACK_JACCARD_THRESHOLD,
  STALE_CANDIDATE_DAYS,
  DONE_LOOKBACK_DAYS,
} from './dedup-constants';

const NOW = Date.parse('2026-07-27T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

function task(over: Record<string, any> = {}): any {
  return {
    _id: over._id || `t-${Math.random().toString(36).slice(2)}`,
    title: '',
    description: '',
    status: 'todo',
    archivedAt: null,
    createdAt: iso(NOW - DAY),
    updatedAt: iso(NOW - DAY),
    source: { type: 'meeting', id: 'm-src' },
    ...over,
  };
}

/** Mock the BYOK call with a fixed verdict list, newest call args captured. */
function mockLlm(results: Array<{ index: number; verdict: string; confidence: number }>): { calls: string[] } {
  const calls: string[] = [];
  __setLlmForTests(async (_system, user) => {
    calls.push(user);
    return JSON.stringify({ results });
  });
  return { calls };
}

async function run(): Promise<void> {
  // ── US-003: retrieval floor catches a paraphrase 0.65 would have missed ──
  {
    const existing = task({ _id: 'legal', title: 'Chase legal on the MSA redline' });
    const paraphrase = { title: 'Still blocked on legal, third time the MSA redline has come up' };

    const score = textSimilarity(paraphrase.title, existing.title);
    assert.ok(score >= RETRIEVAL_FLOOR, `paraphrase scores ${score}, must clear the 0.2 floor`);
    assert.ok(score < FALLBACK_JACCARD_THRESHOLD, `paraphrase scores ${score}, must be missed by the old 0.65 rule`);

    const cands = retrieveCandidates(paraphrase, [existing], { nowMs: NOW });
    assert.equal(cands.length, 1, 'paraphrase retrieves the existing task as a candidate');
    assert.equal(cands[0].taskId, 'legal');
  }

  // Retrieval scores title + description, not title alone
  {
    const existing = task({ _id: 'desc', title: 'Vendor follow-up', description: 'Chase legal on the MSA redline' });
    const cands = retrieveCandidates({ title: 'MSA redline still stuck with legal' }, [existing], { nowMs: NOW });
    assert.equal(cands.length, 1, 'description text participates in retrieval');
  }

  // Zero candidates above the floor → no classification at all
  {
    let called = false;
    __setLlmForTests(async () => { called = true; return '{}'; });
    const decision = await decideMention(
      { title: 'Book the offsite venue' },
      [task({ title: 'Rewrite the onboarding email copy' })],
      { nowMs: NOW },
    );
    assert.equal(decision.kind, 'none', 'no candidates → create exactly as today');
    assert.equal(called, false, 'no candidates → no LLM call');
  }

  // Out-of-window tasks are out of scope (US-012)
  {
    const stale = task({
      _id: 'stale',
      title: 'Chase legal on the MSA redline',
      createdAt: iso(NOW - (STALE_CANDIDATE_DAYS + 5) * DAY),
      updatedAt: iso(NOW - (STALE_CANDIDATE_DAYS + 5) * DAY),
    });
    const cands = retrieveCandidates({ title: 'Chase legal on the MSA redline' }, [stale], { nowMs: NOW });
    assert.equal(cands.length, 0, `tasks idle beyond ${STALE_CANDIDATE_DAYS}d are out of scope`);
  }

  // ── US-005: band boundaries ──────────────────────────────────────────────
  {
    const cand = task({ _id: 'band', title: 'Chase legal on the MSA redline' });
    const item = { title: 'Still blocked on legal, third time the MSA redline has come up' };

    mockLlm([{ index: 0, verdict: 'same_task', confidence: 90 }]);
    let d = await decideMention(item, [cand], { nowMs: NOW });
    assert.equal(d.kind, 'auto_merge', '90 auto-merges');

    mockLlm([{ index: 0, verdict: 'same_task', confidence: 89 }]);
    d = await decideMention(item, [cand], { nowMs: NOW });
    assert.equal(d.kind, 'ask', '89 asks');

    mockLlm([{ index: 0, verdict: 'same_task', confidence: 60 }]);
    d = await decideMention(item, [cand], { nowMs: NOW });
    assert.equal(d.kind, 'ask', '60 asks');

    mockLlm([{ index: 0, verdict: 'same_task', confidence: 59 }]);
    d = await decideMention(item, [cand], { nowMs: NOW });
    assert.equal(d.kind, 'new', '59 creates a new task with no prompt');
  }

  // A non-"same_task" verdict never merges, however confident
  {
    const cand = task({ _id: 'related', title: 'Chase legal on the MSA redline' });
    mockLlm([{ index: 0, verdict: 'related_but_different', confidence: 99 }]);
    const d = await decideMention(
      { title: 'Still blocked on legal, third time the MSA redline has come up' },
      [cand],
      { nowMs: NOW },
    );
    assert.equal(d.kind, 'new', 'related-but-different at 99 still creates a new task');
  }

  // ── US-008: done candidate at 95 routes to the reopen prompt ─────────────
  {
    const done = task({
      _id: 'done',
      title: 'Chase legal on the MSA redline',
      status: 'done',
      updatedAt: iso(NOW - 2 * DAY),
    });
    mockLlm([{ index: 0, verdict: 'same_task', confidence: 95 }]);
    const d: any = await decideMention(
      { title: 'Still blocked on legal, third time the MSA redline has come up' },
      [done],
      { nowMs: NOW },
    );
    assert.equal(d.kind, 'ask', 'confidence 95 against a done candidate asks instead of auto-merging');
    assert.equal(d.wasDone, true, 'the prompt is flagged as the reopen variant');
  }

  // Done longer ago than the lookback drops out of retrieval entirely
  {
    const longDone = task({
      _id: 'long-done',
      title: 'Chase legal on the MSA redline',
      status: 'done',
      createdAt: iso(NOW - (DONE_LOOKBACK_DAYS + 10) * DAY),
      updatedAt: iso(NOW - (DONE_LOOKBACK_DAYS + 10) * DAY),
    });
    const cands = retrieveCandidates({ title: 'Chase legal on the MSA redline' }, [longDone], { nowMs: NOW });
    assert.equal(cands.length, 0, `done more than ${DONE_LOOKBACK_DAYS}d ago is not a candidate`);
  }

  // ── US-012: context signals outrank raw wording similarity ──────────────
  {
    const sourceMeeting = { _id: 'm0', attendees: ['Alex Chen', 'Sarah Kim'], seriesUid: 'weekly-sync', calendarEventId: 'weekly-sync_1750000000000' };
    const meetingsById = new Map<string, any>([
      // similar wording, but nobody in common and a different series
      ['m-a', { _id: 'm-a', attendees: ['Jordan Patel'], seriesUid: 'other-series', calendarEventId: 'other-series_1750000000000' }],
      // lower wording similarity, shares both signals
      ['m-b', { _id: 'm-b', attendees: ['alex chen'], seriesUid: 'weekly-sync', calendarEventId: 'weekly-sync_1751000000000' }],
    ]);
    const a = task({ _id: 'A', title: 'Ship the billing export for the finance team next quarter', source: { type: 'meeting', id: 'm-a' } });
    const b = task({ _id: 'B', title: 'Billing export work', source: { type: 'meeting', id: 'm-b' } });
    const item = { title: 'Ship the billing export to finance' };

    // Wording alone favors A
    assert.ok(
      textSimilarity(item.title, a.title) > textSimilarity(item.title, b.title),
      'precondition: A is the closer wording match',
    );

    const ranked = retrieveCandidates(item, [a, b], { nowMs: NOW, sourceMeeting, meetingsById });
    assert.equal(ranked[0].taskId, 'B', 'shared attendees + same series outrank closer wording');
    assert.equal(ranked[0].sameSeries, true);
    assert.deepEqual(ranked[0].sharedAttendees, ['Alex Chen']);
    const rankedA = ranked.find(c => c.taskId === 'A')!;
    assert.equal(rankedA.sameSeries, false);
    assert.deepEqual(rankedA.sharedAttendees, [], 'disjoint attendees produce no overlap');
  }

  // Voice-memo mentions skip both context signals (text-only)
  {
    const meetingsById = new Map<string, any>([
      ['m-b', { _id: 'm-b', attendees: ['Alex Chen'], seriesUid: 'weekly-sync' }],
    ]);
    const b = task({ _id: 'B', title: 'Billing export work', source: { type: 'meeting', id: 'm-b' } });
    const ranked = retrieveCandidates({ title: 'Ship the billing export to finance' }, [b], {
      nowMs: NOW,
      sourceMeeting: null, // voice memo
      meetingsById,
    });
    assert.equal(ranked[0].sameSeries, false, 'voice memos get no series signal');
    assert.deepEqual(ranked[0].sharedAttendees, [], 'voice memos get no attendee signal');
  }

  // ── US-013: a spoken paraphrase never falls through to a plain insert ────
  {
    const open = task({ _id: 'open', title: 'Chase legal on the MSA redline' });
    const spoken = { title: 'Still blocked on legal, third time the MSA redline has come up' };

    mockLlm([{ index: 0, verdict: 'same_task', confidence: 93 }]);
    let d = await decideMention(spoken, [open], { nowMs: NOW, sourceMeeting: null });
    assert.equal(d.kind, 'auto_merge', 'high-confidence spoken paraphrase merges');

    mockLlm([{ index: 0, verdict: 'same_task', confidence: 72 }]);
    d = await decideMention(spoken, [open], { nowMs: NOW, sourceMeeting: null });
    assert.equal(d.kind, 'ask', 'ask-band spoken paraphrase asks — still not an unconditional insert');
  }

  // ── FR-12: every classifier failure degrades, never blocks ──────────────
  {
    const cand = task({ _id: 'fb', title: 'Chase legal on the MSA redline' });

    // Network/API failure with a strong lexical match → legacy 0.65 merge
    __setLlmForTests(async () => { throw new Error('Claude API error: 529'); });
    let d: any = await decideMention({ title: 'Chase legal on MSA redline' }, [cand], { nowMs: NOW });
    assert.equal(d.kind, 'auto_merge', 'fallback merges when Jaccard clears 0.65');
    assert.equal(d.viaFallback, true);
    assert.equal(d.confidence, null, 'fallback merges carry no LLM confidence');

    // Malformed JSON with only a weak lexical match → plain creation
    __setLlmForTests(async () => 'not json at all');
    d = await decideMention(
      { title: 'Still blocked on legal, third time the MSA redline has come up' },
      [cand],
      { nowMs: NOW },
    );
    assert.equal(d.kind, 'none', 'malformed response below 0.65 just creates the task');

    // A done candidate never auto-merges even on the fallback path
    const doneCand = task({ _id: 'fb-done', title: 'Chase legal on the MSA redline', status: 'done', updatedAt: iso(NOW - DAY) });
    __setLlmForTests(async () => { throw new Error('boom'); });
    d = await decideMention({ title: 'Chase legal on MSA redline' }, [doneCand], { nowMs: NOW });
    assert.equal(d.kind, 'none', 'fallback never reopens a done task');
  }

  __setLlmForTests(null);

  // ── OQ4: series recovery prefers the persisted uid, falls back to split ──
  {
    assert.equal(getSeriesUid({ seriesUid: 'abc-123', calendarEventId: 'zzz_1750000000000' }), 'abc-123');
    assert.equal(getSeriesUid({ calendarEventId: 'abc-123_1750000000000' }), 'abc-123', 'legacy rows split on the last underscore');
    assert.equal(getSeriesUid({ calendarEventId: 'one_off_event' }), null, 'a non-epoch suffix is not a series');
    assert.equal(getSeriesUid({ calendarEventId: null }), null);
    assert.equal(getSeriesUid(null), null);
  }

  // Attendee matching is case-insensitive and containment-based
  {
    assert.deepEqual(attendeeOverlap(['Alex Chen'], ['alex chen']), ['Alex Chen']);
    assert.deepEqual(attendeeOverlap(['Alex Chen'], ['Alex']), ['Alex Chen']);
    assert.deepEqual(attendeeOverlap(['Alex Chen'], ['Jordan Patel']), []);
    assert.deepEqual(attendeeOverlap([], ['Alex Chen']), []);
  }

  // ── US-009: mention thread ──────────────────────────────────────────────
  {
    const mentions: TaskMention[] = [
      { id: 'm3', sourceType: 'voice_note', sourceId: 'v1', sourceTitle: 'Voice note', excerpt: 'third mention', occurredAt: iso(NOW - DAY) },
      { id: 'm1', sourceType: 'meeting', sourceId: 'a', sourceTitle: 'Weekly sync', excerpt: 'first mention', occurredAt: iso(NOW - 5 * DAY) },
      { id: 'm2', sourceType: 'meeting', sourceId: 'b', sourceTitle: 'Vendor call', excerpt: 'second mention', occurredAt: iso(NOW - 3 * DAY), mergedItem: { title: 'second mention' } },
    ];
    const thread = buildMentionThread({ taskMentions: mentions });
    assert.equal(thread.length, 3, 'three mentions render three thread entries');
    assert.deepEqual(thread.map(e => e.id), ['m1', 'm2', 'm3'], 'entries are chronological');
    assert.deepEqual(thread.map(e => e.sourceTitle), ['Weekly sync', 'Vendor call', 'Voice note']);
    assert.deepEqual(thread.map(e => e.sourceType), ['meeting', 'meeting', 'voice_note']);
    assert.deepEqual(thread.map(e => e.excerpt), ['first mention', 'second mention', 'third mention']);
    assert.deepEqual(thread.map(e => e.canSplit), [false, true, false], 'only merged mentions offer a split');

    // The common case keeps today's chrome exactly
    assert.deepEqual(buildMentionThread({ taskMentions: [mentions[1]] }), [], 'one mention renders no thread');
    assert.deepEqual(buildMentionThread({ taskMentions: [] }), []);
    assert.deepEqual(buildMentionThread({}), []);
  }

  // ── US-014: repetition nudge ────────────────────────────────────────────
  {
    const mention = (daysAgo: number, id: string): TaskMention => ({
      id, sourceType: 'meeting', sourceId: id, excerpt: id, occurredAt: iso(NOW - daysAgo * DAY),
    });

    const two = { taskMentions: [mention(1, 'a'), mention(2, 'b')] };
    assert.deepEqual(computeRepetitionNudge(two, NOW), { show: false, count: 2 }, '2 in the window is below the bar');

    const three = { taskMentions: [mention(1, 'a'), mention(2, 'b'), mention(6, 'c')] };
    assert.deepEqual(computeRepetitionNudge(three, NOW), { show: true, count: 3 }, '3 within 7 days shows the chip');

    const spread = { taskMentions: [mention(1, 'a'), mention(2, 'b'), mention(30, 'c')] };
    assert.equal(computeRepetitionNudge(spread, NOW).show, false, 'mentions outside the window do not count');

    const dismissed = { ...three, nudgeDismissedAtCount: 3 };
    assert.equal(computeRepetitionNudge(dismissed, NOW).show, false, 'dismissal suppresses the chip');

    const grew = { taskMentions: [...three.taskMentions, mention(0, 'd')], nudgeDismissedAtCount: 3 };
    assert.equal(computeRepetitionNudge(grew, NOW).show, true, 'the chip returns once the count increases');

    const done = { ...three, status: 'done' };
    assert.equal(computeRepetitionNudge(done, NOW).show, false, 'done tasks are never nudged');
  }

  console.log('task-dedup: all tests passed');
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { run };
