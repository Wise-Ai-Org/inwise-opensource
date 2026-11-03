import * as assert from 'node:assert/strict';
import {
  buildCatchUpNotes,
  buildMorning,
  buildPrep,
  buildProcessed,
  buildWrapUp,
  computeCatchUp,
  computeCrunch,
  computeGoneQuiet,
  countDayMeetings,
  daysLate,
  identitiesMatch,
  parseIdentity,
  summarizePendingApproval,
  type ContentContext,
} from './ollie-content';
const matchesSelf = (s: string, emails: string[], name: string) => emails.some((e) => s.toLowerCase().includes(e)) || name.toLowerCase().split(' ').every((t) => s.toLowerCase().includes(t));

const now = new Date(2026, 10, 2, 8, 0); // Mon Nov 2 2026, 08:00 local
const d = (day: number, h = 12, m = 0, month = 10) => new Date(2026, month, day, h, m);
const iso = (date: Date) => date.toISOString();
const isSelf = (s: string) => matchesSelf(s, ['shrav@inwise.ai'], 'Shrav Vatti');

// ── Identity ────────────────────────────────────────────────────────────────
assert.deepEqual(parseIdentity('Priya Shah <Priya@acme.com>'), { name: 'Priya Shah', email: 'priya@acme.com' });
assert.deepEqual(parseIdentity('priya@acme.com'), { name: '', email: 'priya@acme.com' });
assert.equal(identitiesMatch('Priya Shah <priya@acme.com>', 'priya@acme.com'), true);
assert.equal(identitiesMatch('priya.shah@acme.com', 'Priya Shah'), true);
assert.equal(identitiesMatch('Priya Shah', 'Marco Diaz'), false);
assert.equal(daysLate('2026-11-01', now), 1);
assert.equal(daysLate('2026-11-02', now), null, 'due today is not late');
assert.equal(daysLate(null, now), null);

// ── Fixtures ────────────────────────────────────────────────────────────────
const meetings = [
  {
    _id: 'm-old', title: 'Pricing kickoff', date: iso(d(5, 10, 0, 9)), source: 'desktop_recording', status: 'processed',
    attendees: ['Priya Shah <priya@acme.com>', 'shrav@inwise.ai'],
    insights: {
      actionItems: [], decisions: [{ text: 'Use tiered pricing' }],
      commitments: [
        { text: 'Send pricing deck', who: 'Priya Shah', deadline: '2026-10-30' },
        { text: 'Share the security review', who: 'Shrav Vatti', deadline: '2026-10-20' },
      ],
    },
  },
  {
    _id: 'm-marco', title: 'Hiring sync', date: iso(d(1, 9, 0, 9)), source: 'calendar', status: 'calendar_sync',
    attendees: ['Marco Diaz <marco@acme.com>', 'shrav@inwise.ai'], insights: null,
  },
];
const tasks = [
  { _id: 't-you', title: 'Review contract redlines', status: 'todo', owner: 'Shrav Vatti', meetingId: 'm-old', dueDate: '2026-10-28', createdAt: iso(d(5, 11, 0, 9)), updatedAt: iso(d(5, 11, 0, 9)), snoozedAt: null },
  { _id: 't-priya', title: 'Draft rollout plan', status: 'todo', owner: 'Priya Shah', meetingId: 'm-old', dueDate: null, createdAt: iso(d(5, 11, 0, 9)), updatedAt: iso(d(30, 11, 0, 9)), snoozedAt: null },
  { _id: 't-marco', title: 'Send offer letter', status: 'todo', owner: 'Shrav Vatti', meetingId: 'm-marco', dueDate: null, createdAt: iso(d(1, 11, 0, 9)), updatedAt: iso(d(1, 11, 0, 9)), snoozedAt: null },
  { _id: 't-likely', title: 'Book offsite venue', status: 'todo', owner: 'Shrav Vatti', likelyDone: true, likelyDoneAt: iso(d(1, 15)), dueDate: null, snoozedAt: null, createdAt: iso(d(20, 9, 0, 9)), updatedAt: iso(d(1, 15)) },
  { _id: 't-oldlikely', title: 'Old flag', status: 'todo', likelyDone: true, likelyDoneAt: iso(d(25, 9, 0, 9)), snoozedAt: null },
  { _id: 't-done', title: 'Done thing', status: 'done', owner: 'Priya Shah', snoozedAt: null },
];
const people = [
  { _id: 'p-priya', name: 'Priya Shah', email: 'priya@acme.com', lastMeeting: meetings[0].date },
  { _id: 'p-marco', name: 'Marco Diaz', email: 'marco@acme.com', lastMeeting: meetings[1].date },
  { _id: 'p-self', name: 'Shrav Vatti', email: 'shrav@inwise.ai', lastMeeting: meetings[0].date },
];
const scored = [
  { _id: 't-you', score: 72, reasoning: 'Overdue', signals: { commitmentLinkage: 100 } },
  { _id: 't-priya', score: 65, reasoning: 'Waiting', signals: { commitmentLinkage: 0 } },
  { _id: 't-marco', score: 40, reasoning: 'Soon', signals: { commitmentLinkage: 0 } },
  { _id: 't-likely', score: 20, reasoning: '', signals: { commitmentLinkage: 0 } },
];
const ctx: ContentContext = { now, userName: 'Shrav Vatti', isSelf, tasks, meetings, people, scored };

// ── Catch up ────────────────────────────────────────────────────────────────
const catchUp = computeCatchUp(ctx);
assert.deepEqual(catchUp.map((c) => c.personId), ['p-priya', 'p-marco'], 'both ≥21 days with open items; self excluded');
const priya = catchUp[0];
assert.equal(priya.waitingCount, 2);
assert.equal(priya.waitingOn, 'Share the security review', 'most overdue item first');
assert.equal(priya.weeksSinceMet, 3);
assert.equal(computeCatchUp({ ...ctx, now: d(15, 8, 0, 9) }).length, 0, 'under 21 days → nobody');
assert.equal(computeCatchUp(ctx, 1).length, 1);
assert.equal(buildCatchUpNotes([priya])[0].text, '3 weeks since you met · waiting on Share the security review');

// ── Morning ─────────────────────────────────────────────────────────────────
const morning = buildMorning({ ...ctx, todayEvents: [{ id: 'e1', title: 'Standup', startTime: d(2, 9), endTime: d(2, 9, 30) }], welcomeBack: null });
assert.equal(morning.firstName, 'Shrav');
assert.equal(morning.meetingCount, 1);
assert.deepEqual(morning.topPriorities.map((p) => [p.rank, p.taskId]), [[1, 't-you'], [2, 't-priya'], [3, 't-marco']]);
assert.equal(morning.topPriorities[0].sourceMeetingTitle, 'Pricing kickoff');
assert.equal(morning.topPriorities[0].daysLate, 5);
assert.deepEqual(morning.doneSinceYesterday.map((t) => t.taskId), ['t-likely'], 'only flags since previous local day start');
assert.equal(morning.overduePromiseCount, 1, 'own overdue commitments only');
assert.equal(morning.catchUp.length, 2);

// ── Prep ────────────────────────────────────────────────────────────────────
const event = { id: 'e-priya', title: 'Pricing follow-up', startTime: d(2, 8, 10), endTime: d(2, 8, 40), attendees: ['priya@acme.com', 'shrav@inwise.ai'] };
const pending = [
  summarizePendingApproval({ _id: 's1', pushParams: { operation: 'create', args: { title: 'Pricing page', projectKey: 'P' } }, meetingTitle: 'Pricing kickoff', createdAt: iso(d(5, 12, 0, 9)) }, 'm-old'),
  summarizePendingApproval({ _id: 's2', pushParams: { operation: 'transition', args: { issueKey: 'P-9', targetStatus: 'Done' } }, meetingTitle: 'Hiring sync', createdAt: iso(d(1, 12, 0, 9)) }, 'm-marco'),
];
assert.equal(pending[0].summary, 'Create ticket “Pricing page”?');
assert.equal(pending[1].summary, 'Move P-9 to Done?');
const prep = buildPrep({ ...ctx, event, draftAgenda: ['Pricing tiers'], pendingApprovals: pending, recordArmed: true });
assert.equal(prep.minutesUntil, 10);
assert.deepEqual(prep.attendees, ['Priya']);
assert.deepEqual(prep.lastMet, { meetingId: 'm-old', title: 'Pricing kickoff', date: meetings[0].date });
assert.equal(prep.owes.length, 1);
assert.equal(prep.owes[0].personId, 'p-priya');
assert.deepEqual(prep.owes[0].owesYou.map((i) => [i.kind, i.text, i.daysLate]), [
  ['commitment', 'Send pricing deck', 3],
  ['task', 'Draft rollout plan', null],
]);
assert.deepEqual(prep.owes[0].youOwe.map((i) => [i.kind, i.text]), [
  ['commitment', 'Share the security review'],
  ['task', 'Review contract redlines'],
]);
assert.deepEqual(prep.pendingApprovals.map((p) => p.id), ['s1'], 'only approvals from meetings with these attendees');
assert.deepEqual(prep.draftAgenda, ['Pricing tiers']);
assert.equal(buildPrep({ ...ctx, event, draftAgenda: [], pendingApprovals: [], recordArmed: false }).draftAgenda, null);
const strangers = buildPrep({ ...ctx, event: { ...event, attendees: ['new@else.com'] }, draftAgenda: null, pendingApprovals: pending, recordArmed: false });
assert.equal(strangers.owes.length, 0);
assert.equal(strangers.lastMet, null);
assert.equal(strangers.pendingApprovals.length, 0);

// ── Processed ───────────────────────────────────────────────────────────────
const processedMeeting = {
  _id: 'm-new', title: 'Design review', date: iso(d(2, 7)), duration: 1800, status: 'processed', source: 'desktop_recording',
  transcriptQuality: { ok: true, reasons: [] },
  insights: { actionItems: [{ text: 'a' }, { text: 'b' }], decisions: [{ text: 'Ship Friday' }] },
};
const processedTasks = [
  { _id: 'n1', title: 'a', meetingId: 'm-new', approval: { status: 'pending' } },
  { _id: 'n2', title: 'b', meetingId: 'm-new', approval: { status: 'pending' }, dedupSuggestion: { candidateTaskId: 't-you', candidateTitle: 'Review contract redlines', wasDone: false } },
  { _id: 'other', title: 'c', meetingId: 'm-old' },
];
const writes = [
  { _id: 'w1', targetSystem: 'jira', result: 'success', targetRecordId: 'P-1', targetRecordUrl: 'https://x/P-1', operation: 'create' },
  { _id: 'w2', targetSystem: 'jira', result: 'failed', errorMessage: 'User rejected', operation: 'create' },
  { _id: 's1', targetSystem: 'jira', result: 'pending-approval', operation: 'create' },
];
const processed = buildProcessed({ meeting: processedMeeting, tasks: processedTasks, sorWrites: writes, pendingApprovals: [pending[0]], slackConnected: true });
assert.equal(processed.status, 'processed');
assert.equal(processed.taskCount, 2);
assert.equal(processed.decisionCount, 1);
assert.deepEqual(processed.tasks.map((t) => t.taskId), ['n1', 'n2']);
assert.equal(processed.tasks[1].duplicateOf!.taskId, 't-you');
assert.equal(processed.jira!.pushedCount, 1);
assert.equal(processed.jira!.failedCount, 0, 'user rejections are not failures');
assert.equal(processed.jira!.pending.length, 1);
assert.equal(processed.patchyAudio, null);
assert.equal(processed.endedAt! - processed.startedAt!, 1800_000);
assert.equal(buildProcessed({ meeting: processedMeeting, tasks: [], sorWrites: [], pendingApprovals: [], slackConnected: false }).jira, null);
const patchy = buildProcessed({ meeting: { ...processedMeeting, status: 'needs_review', transcriptQuality: { ok: false, reasons: ['repeated phrases'] } }, tasks: [], sorWrites: [], pendingApprovals: [], slackConnected: false });
assert.equal(patchy.status, 'needs_review');
assert.deepEqual(patchy.patchyAudio, { reasons: ['repeated phrases'] });
const failed = buildProcessed({
  meeting: { ...processedMeeting, status: 'error', recordingRecovery: { audioPath: 'x' }, recordingFailure: { stage: 'transcribing', message: 'Transcription failed.', audioSaved: true } },
  tasks: [], sorWrites: [], pendingApprovals: [], slackConnected: false,
});
assert.equal(failed.status, 'failed');
assert.deepEqual(failed.failure, { message: 'Transcription failed.', stage: 'transcribing', audioSaved: true });

// ── Crunch ──────────────────────────────────────────────────────────────────
const tomorrow = d(3, 0);
const back2back = [9, 10, 11, 12, 13, 14, 15, 16].map((h) => ({ id: `b${h}`, title: 'x', startTime: d(3, h), endTime: d(3, h + 1) }));
assert.deepEqual(computeCrunch(back2back, tomorrow), { from: d(3, 9).getTime(), to: d(3, 17).getTime() });
assert.equal(computeCrunch(back2back.filter((e) => e.id !== 'b12'), tomorrow), null, 'an hour free at noon');
const gap20 = back2back.map((e) => e.id === 'b12' ? { ...e, startTime: d(3, 12, 20) } : e);
assert.notEqual(computeCrunch(gap20, tomorrow), null, '20-minute gap is not enough');
const lateDense = [13, 14, 15, 16].map((h) => ({ id: `l${h}`, title: 'x', startTime: d(3, h), endTime: d(3, h + 1) }));
assert.deepEqual(computeCrunch(lateDense, tomorrow), { from: d(3, 13).getTime(), to: d(3, 17).getTime() }, 'first-to-last span ≥3h with no gap');
assert.equal(computeCrunch([], tomorrow), null);

// ── Gone quiet ──────────────────────────────────────────────────────────────
const quiet = computeGoneQuiet(ctx);
assert.deepEqual(quiet.map((q) => q.taskId), ['t-you'], 't-priya updated 3 days ago; t-marco under 60');
assert.equal(quiet[0].commitmentToOther, true);
const quietMany = computeGoneQuiet({
  ...ctx,
  tasks: [
    ...['q1', 'q2', 'q3', 'q4'].map((id) => ({ _id: id, title: id, status: 'todo', owner: 'Marco Diaz', updatedAt: iso(d(1, 9, 0, 9)), snoozedAt: null })),
    { _id: 'q5', title: 'mine', status: 'todo', owner: 'Shrav Vatti', isCommitment: true, updatedAt: iso(d(1, 9, 0, 9)), snoozedAt: null },
    { _id: 'q6', title: 'mentioned', status: 'todo', lastMentionedAt: iso(d(1, 9)), updatedAt: iso(d(1, 9, 0, 9)), snoozedAt: null },
  ],
  scored: [
    { _id: 'q1', score: 90, reasoning: '' }, { _id: 'q2', score: 80, reasoning: '' }, { _id: 'q3', score: 70, reasoning: '' },
    { _id: 'q4', score: 61, reasoning: '' }, { _id: 'q5', score: 62, reasoning: '' }, { _id: 'q6', score: 99, reasoning: '' },
  ],
});
assert.deepEqual(quietMany.map((q) => q.taskId), ['q1', 'q5', 'q2'], 'commitment boost, max 3, recent mention excluded');

// ── Wrap-up ─────────────────────────────────────────────────────────────────
const evening = new Date(2026, 10, 2, 18, 0);
const wrapMeetings = [
  ...meetings,
  { _id: 'today-rec', title: 'Design review', date: iso(d(2, 10)), source: 'desktop_recording', status: 'processed', calendarEventId: 'ev-today', insights: { decisions: [{ text: 'd1' }, { text: 'd2' }], actionItems: [] } },
  { _id: 'slack1', title: 'thread', date: iso(d(2, 11)), createdAt: iso(d(2, 13)), source: 'slack_thread', slackChannelId: 'C1', insights: { actionItems: [{ text: 'x' }], decisions: [] } },
  { _id: 'slack2', title: 'thread', date: iso(d(2, 12)), createdAt: iso(d(2, 14)), source: 'slack_thread', slackChannelId: 'C1', insights: { actionItems: [], decisions: [{ text: 'y' }] } },
  { _id: 'failed-rec', title: 'Broken call', date: iso(d(1, 16)), status: 'error', recordingRecovery: { audioPath: 'a' }, recordingFailure: { audioSaved: true, message: 'Transcription failed.' } },
  { _id: 'series-src', title: 'Weekly 1:1', date: iso(d(26, 9, 0, 9)), source: 'desktop_recording', status: 'processed', seriesUid: 'series-1', attendees: ['Marco Diaz'] },
];
const wrapTasks = [
  ...tasks,
  { _id: 'due-tmrw', title: 'Prep metrics', status: 'todo', dueDate: '2026-11-03', snoozedAt: null },
  { _id: 'found-today', title: 'found', status: 'todo', aiExtracted: true, createdAt: iso(d(2, 10, 30)), snoozedAt: null },
  { _id: 'series-task', title: 'Bring hiring plan', status: 'todo', meetingId: 'series-src', dueDate: '2026-11-02', snoozedAt: null },
];
const allTasks = [
  ...wrapTasks,
  { _id: 'snoozed-today', title: 'Stale thing', status: 'todo', snoozedAt: iso(d(2, 8, 5)), snoozedReason: 'stale-30d' },
  { _id: 'snoozed-manual', title: 'Manual', status: 'todo', snoozedAt: iso(d(2, 8, 5)), snoozedReason: 'user' },
];
const wrapEvents = [
  { id: 'ev-today', title: 'Design review', startTime: d(2, 10), endTime: d(2, 11), attendees: [] },
  { id: 'ev-tmrw-2', title: 'Hiring sync', startTime: d(3, 13), endTime: d(3, 14), attendees: ['marco@acme.com'] },
  { id: 'ev-tmrw-1', title: 'Pricing review', startTime: d(3, 9, 30), endTime: d(3, 10), attendees: ['Priya Shah <priya@acme.com>'] },
];
const wrap = buildWrapUp({
  ...ctx,
  now: evening,
  meetings: wrapMeetings,
  tasks: wrapTasks,
  allTasks,
  events: wrapEvents,
  agendaEventIds: new Set(['ev-tmrw-1']),
  cancelledToday: [{ id: 'ev-cancel', title: 'Weekly 1:1', startTime: d(2, 15).getTime(), seriesUid: 'series-1' }],
  executions: [
    { _id: 'x1', actionItemTitle: 'Draft follow-up email', client: 'Claude', status: 'completed', updatedAt: iso(d(2, 16)), outcomes: [{ summary: 'Drafted and saved' }] },
    { _id: 'x2', actionItemTitle: 'Old', client: 'Codex', status: 'completed', updatedAt: iso(d(1, 16)) },
    { _id: 'x3', actionItemTitle: 'Running', client: 'Codex', status: 'running', updatedAt: iso(d(2, 16)) },
  ],
  slackSyncedAt: d(2, 17, 50).getTime(),
});
assert.equal(wrap.firstName, 'Shrav');
assert.deepEqual(wrap.today, { meetingCount: 1, tasksFound: 1, decisions: 3 });
assert.equal(wrap.tomorrow.firstMeeting!.eventId, 'ev-tmrw-1');
assert.equal(wrap.tomorrow.firstMeeting!.agendaDrafted, true);
assert.deepEqual(wrap.tomorrow.firstMeeting!.tasksDueBefore.map((t) => t.taskId), ['due-tmrw']);
assert.deepEqual(wrap.tomorrow.overdueWithAttendees.map((t) => [t.taskId, t.attendee]), [['t-you', 'Priya Shah']]);
assert.equal(wrap.tomorrow.crunch, null);
assert.deepEqual(wrap.tomorrow.cancelledToday.map((c) => [c.eventId, c.tasks.map((t) => t.taskId)]), [['ev-cancel', ['series-task']]]);
assert.deepEqual(wrap.slackToday, [{ channelId: 'C1', threadCount: 2, taskCount: 1, decisionCount: 1 }]);
assert.deepEqual(wrap.snoozedToday.map((t) => t.taskId), ['snoozed-today']);
assert.deepEqual(wrap.receipts.map((r) => [r.executionId, r.summary]), [['x1', 'Drafted and saved']]);
assert.deepEqual(wrap.needsRetry.map((r) => r.meetingId), ['failed-rec']);
assert.equal(wrap.slackSyncedAt, d(2, 17, 50).getTime());

// One meeting count for morning and wrap: an event recorded twice is one meeting,
// placeholders and Slack threads don't count, an unscheduled recording does.
{
  const day = d(2, 9, 0);
  const ev = { id: 'ev-a', title: 'Kickoff', startTime: d(2, 16, 0), endTime: d(2, 16, 30) };
  const meetings = [
    { _id: 'r1', date: d(2, 16, 1).toISOString(), calendarEventId: 'ev-a', source: 'desktop_recording' },
    { _id: 'r2', date: d(2, 16, 5).toISOString(), calendarEventId: 'ev-a', source: 'desktop_recording' },
    { _id: 'r3', date: d(2, 11, 0).toISOString(), calendarEventId: 'ev-gone', source: 'desktop_recording' },
    { _id: 'p1', date: d(2, 16, 0).toISOString(), calendarEventId: 'ev-a', status: 'calendar_sync' },
    { _id: 's1', date: d(2, 12, 0).toISOString(), source: 'slack_thread' },
    { _id: 'adhoc', date: d(2, 13, 0).toISOString(), source: 'desktop_recording' },
  ];
  assert.equal(countDayMeetings(meetings, [ev], day), 3);
}

console.log('ollie-content tests passed');
