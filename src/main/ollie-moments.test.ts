import * as assert from 'node:assert/strict';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  eventsInPrepWindow,
  formatClock,
  mergeNotificationSettings,
  normalizeNotificationSettings,
  prepNotificationCopy,
  processedNotificationCopy,
  pruneMomentKeys,
  selectOllieMoment,
  wrapUpNotificationCopy,
  wrapUpStartsAt,
} from './ollie-moments';
import type { PrepContent, ProcessedContent, WrapUpContent } from './ollie-moments-types';

const at = (h: number, m = 0, day = 2) => new Date(2026, 10, day, h, m);

// ── Settings defaults + migration ───────────────────────────────────────────
assert.deepEqual(normalizeNotificationSettings(undefined), DEFAULT_NOTIFICATION_SETTINGS);
assert.deepEqual(DEFAULT_NOTIFICATION_SETTINGS, {
  morning: 'window', prep: { mode: 'notify', leadMinutes: 10 }, processed: 'notify', wrapUp: 'notify', recordingProblems: true,
});
// Existing install that had turned the daily plan window off keeps it off.
assert.equal(normalizeNotificationSettings(undefined, false).morning, 'tray');
assert.equal(normalizeNotificationSettings({ morning: 'window' }, false).morning, 'window');
// Garbage / partial values fall back per field; recordingProblems is not editable.
const partial = normalizeNotificationSettings({ morning: 'loud', prep: { leadMinutes: 15 }, processed: 'off', recordingProblems: false });
assert.deepEqual(partial, { morning: 'window', prep: { mode: 'notify', leadMinutes: 15 }, processed: 'off', wrapUp: 'notify', recordingProblems: true });
assert.equal(normalizeNotificationSettings({ prep: { leadMinutes: 7 } }).prep.leadMinutes, 10);
const merged = mergeNotificationSettings(DEFAULT_NOTIFICATION_SETTINGS, { prep: { mode: 'tray' } });
assert.deepEqual(merged.prep, { mode: 'tray', leadMinutes: 10 });

// ── Selection ───────────────────────────────────────────────────────────────
const events = [
  { id: 'a', title: 'Standup', startTime: at(9), endTime: at(9, 30) },
  { id: 'b', title: 'Design review', startTime: at(14), endTime: at(15) },
  { id: 't', title: 'Tomorrow sync', startTime: at(10, 0, 3), endTime: at(11, 0, 3) },
];
const base = { events, settings: DEFAULT_NOTIFICATION_SETTINGS, dismissedKeys: [] as string[], recordingActive: false };

assert.deepEqual(selectOllieMoment({ ...base, now: at(8) }), { kind: 'morning', key: 'morning:2026-11-02', dateKey: '2026-11-02' });
assert.deepEqual(selectOllieMoment({ ...base, now: at(8, 51) }), { kind: 'prep', key: 'prep:a', eventId: 'a', dateKey: '2026-11-02' });
assert.equal(selectOllieMoment({ ...base, now: at(8, 49) })!.kind, 'morning', 'outside 10-min lead');
assert.equal(selectOllieMoment({ ...base, now: at(9) })!.kind, 'morning', 'prep ends at start');
assert.equal(wrapUpStartsAt(events, at(8)), at(15, 5).getTime());
assert.equal(selectOllieMoment({ ...base, now: at(15, 4) })!.kind, 'morning');
assert.deepEqual(selectOllieMoment({ ...base, now: at(15, 5) }), { kind: 'wrap', key: 'wrap:2026-11-02', dateKey: '2026-11-02' });
// Wrap-up waits while a recording is active.
assert.equal(selectOllieMoment({ ...base, now: at(16), recordingActive: true })!.kind, 'morning');
// Prep wins over wrap-up (evening meeting after the wrap point is impossible, so use custom lead).
const lateEvents = [...events, { id: 'c', title: 'Late call', startTime: at(15, 10), endTime: at(15, 20) }];
assert.equal(selectOllieMoment({ ...base, events: lateEvents, now: at(15, 1) })!.kind, 'prep');
// Dismissal hides the card until the next moment begins.
assert.equal(selectOllieMoment({ ...base, now: at(8, 55), dismissedKeys: ['prep:a'] }), null);
assert.equal(selectOllieMoment({ ...base, now: at(9, 5), dismissedKeys: ['prep:a'] })!.kind, 'morning');
assert.equal(selectOllieMoment({ ...base, now: at(16), dismissedKeys: ['wrap:2026-11-02'] }), null);
// Settings off removes moments.
const off = { ...DEFAULT_NOTIFICATION_SETTINGS, prep: { mode: 'off' as const, leadMinutes: 10 as const }, morning: 'off' as const };
assert.equal(selectOllieMoment({ ...base, settings: off, now: at(8, 55) }), null);
// Lead minutes honored; no meetings today → no wrap-up.
assert.equal(eventsInPrepWindow(events, at(8, 46), 15)[0].id, 'a');
assert.equal(selectOllieMoment({ ...base, events: [], now: at(20) })!.kind, 'morning');

assert.deepEqual(pruneMomentKeys(['morning:2026-10-01', 'wrap:2026-11-01', 'prep:x'], at(8)), ['wrap:2026-11-01', 'prep:x']);

// ── Notification copy ───────────────────────────────────────────────────────
assert.equal(formatClock(at(9, 5).getTime()), '9:05 AM');
assert.equal(formatClock(at(12, 0).getTime()), '12:00 PM');
assert.equal(formatClock(at(0, 30).getTime()), '12:30 AM');

const prep: PrepContent = {
  eventId: 'a', title: 'Standup', startTime: at(9).getTime(), endTime: at(9, 30).getTime(), minutesUntil: 10,
  attendees: ['Priya'], lastMet: null, draftAgenda: null, recordArmed: false,
  owes: [{
    name: 'Priya', personId: 'p1',
    owesYou: [{ kind: 'task', taskId: 't1', meetingId: null, text: 'Send pricing deck', dueDate: '2026-10-30', daysLate: 3 }],
    youOwe: [{ kind: 'task', taskId: 't2', meetingId: null, text: 'Review contract', dueDate: null, daysLate: null }],
  }],
  pendingApprovals: [{ id: 's1', operation: 'create', summary: 'Create', issueKey: null, meetingId: 'm', meetingTitle: null, createdAt: '' }],
};
assert.deepEqual(prepNotificationCopy(prep), {
  title: 'Standup in 10 min',
  body: 'Priya owes you: Send pricing deck (3 days late). 1 Jira update needs your OK.',
});
assert.deepEqual(prepNotificationCopy({ ...prep, owes: [], pendingApprovals: [] }).body, 'Your prep is ready in Inwise.');
assert.match(prepNotificationCopy({ ...prep, owes: [], pendingApprovals: [], lastMet: { meetingId: 'm', title: 'Kickoff', date: '2026-10-20T17:00:00.000Z' } }).body, /^Last met Oct 20 · Kickoff\.$/);

const processed: ProcessedContent = {
  meetingId: 'm1', title: 'Design review', source: 'desktop_recording', status: 'processed', startedAt: null, endedAt: null,
  taskCount: 3, decisionCount: 1, tasks: [], decisions: ['Ship'], patchyAudio: null,
  jira: { pushedCount: 2, failedCount: 0, pushed: [], pending: [prep.pendingApprovals[0]] }, failure: null, slackConnected: false,
};
assert.deepEqual(processedNotificationCopy(processed), {
  title: 'Inwise processed Design review',
  body: 'Found 3 tasks and 1 decision. Pushed 2 Jira updates, 1 needs your OK.',
});
assert.equal(processedNotificationCopy({ ...processed, jira: null }).body, 'Found 3 tasks and 1 decision.');
assert.deepEqual(processedNotificationCopy({ ...processed, status: 'failed', failure: { message: 'x', stage: 'transcribing', audioSaved: true } }), {
  title: "Couldn't process Design review", body: 'The audio is saved.',
});
assert.match(processedNotificationCopy({ ...processed, status: 'needs_review' }).body, /patchy/);

const wrap: WrapUpContent = {
  firstName: 'Shrav', today: { meetingCount: 4, tasksFound: 6, decisions: 2 },
  tomorrow: { firstMeeting: { eventId: 't', title: 'Tomorrow sync', startTime: at(10, 0, 3).getTime(), agendaDrafted: false, tasksDueBefore: [] }, overdueWithAttendees: [], crunch: null, cancelledToday: [] },
  goneQuiet: [], slackToday: [{ channelId: 'C1', threadCount: 3, taskCount: 1, decisionCount: 0 }], snoozedToday: [], receipts: [], needsRetry: [], slackSyncedAt: null,
};
assert.deepEqual(wrapUpNotificationCopy(wrap), {
  title: 'Tomorrow starts at 10:00 AM with Tomorrow sync',
  body: 'Today: 4 meetings, 6 tasks found. Slack brought in 3 threads.',
});
assert.deepEqual(wrapUpNotificationCopy({ ...wrap, slackToday: [], tomorrow: { ...wrap.tomorrow, firstMeeting: null } }), {
  title: 'Day wrapped', body: 'Today: 4 meetings, 6 tasks found.',
});

console.log('ollie-moments tests passed');
