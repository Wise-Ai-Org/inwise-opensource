import * as assert from 'node:assert/strict';
import { buildDailyBriefing } from './daily-briefing';

const now = new Date(2026, 8, 10, 10, 0, 0);
const tasks = [
  { _id: 'today', title: 'Today task', status: 'todo', dueDate: '2026-09-10' },
  { _id: 'tomorrow', title: 'Tomorrow task', status: 'todo', dueDate: '2026-09-11' },
];
const scoredTasks = [
  { _id: 'today', score: 90, reasoning: 'Due today' },
  { _id: 'tomorrow', score: 70, reasoning: 'Due soon' },
];
const meetings = [
  {
    _id: 'm-today', title: 'Today meeting', date: new Date(2026, 8, 10, 9).toISOString(),
    insights: { actionItems: [{ text: 'Follow up' }], decisions: [{ text: 'Ship' }], blockers: [] },
  },
  {
    _id: 'm-tomorrow', title: 'Tomorrow meeting', date: new Date(2026, 8, 11, 9).toISOString(),
    insights: { actionItems: [], decisions: [], blockers: [{ text: 'Blocked' }] },
  },
];

const today = buildDailyBriefing({ requestedDateKey: '2026-09-10', now, name: 'Shrav', tasks, meetings, scoredTasks });
assert.equal(today.isToday, true);
assert.equal(today.dateKey, '2026-09-10');
assert.equal(today.meetingCount, 1);
assert.equal(today.actionItemCount, 1);
assert.equal(today.decisionCount, 1);
assert.deepEqual(today.topTasks.map(task => task._id), ['today', 'tomorrow']);

const tomorrow = buildDailyBriefing({ requestedDateKey: '2026-09-11', now, name: 'Shrav', tasks, meetings, scoredTasks });
assert.equal(tomorrow.isToday, false);
assert.match(tomorrow.title, /Friday, September 11 brief/);
assert.equal(tomorrow.meetingCount, 1);
assert.equal(tomorrow.blockerCount, 1);
assert.deepEqual(tomorrow.topTasks.map(task => task._id), ['tomorrow']);

const invalid = buildDailyBriefing({ requestedDateKey: '2026-02-31', now, name: '', tasks, meetings, scoredTasks });
assert.equal(invalid.dateKey, '2026-09-10');

console.log('daily-briefing tests passed');
