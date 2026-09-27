import * as assert from 'node:assert/strict';
import Datastore from '@seald-io/nedb';
import {
  __setTasksDbForTests,
  __setMeetingsDbForTests,
  __setPeopleDbForTests,
  bringBackTask,
  createTask,
  getPeople,
  getSuggestedPeople,
  getSnoozedTasks,
  getTasks,
  isSnoozed,
  snoozeTask,
  touchLastMentioned,
  updateTask,
} from './database';
import { setConfig } from './config';

async function run(): Promise<void> {
  // isSnoozed — pure helper
  assert.equal(isSnoozed(null), false);
  assert.equal(isSnoozed(undefined), false);
  assert.equal(isSnoozed({}), false);
  assert.equal(isSnoozed({ snoozedAt: null }), false);
  assert.equal(isSnoozed({ snoozedAt: '2026-04-21T00:00:00.000Z' }), true);

  // In-memory NeDB for all DB-backed tests
  const db = new Datastore<any>();
  const meetingsDb = new Datastore<any>();
  const peopleDb = new Datastore<any>();
  await Promise.all([db.loadDatabaseAsync(), meetingsDb.loadDatabaseAsync(), peopleDb.loadDatabaseAsync()]);
  __setTasksDbForTests(db);
  __setMeetingsDbForTests(meetingsDb);
  __setPeopleDbForTests(peopleDb);

  // createTask initialises the new fields to null
  const a = await createTask({ title: 'alpha', priority: 'high' });
  const b = await createTask({ title: 'bravo' });
  const c = await createTask({ title: 'charlie' });
  assert.equal(a.snoozedAt, null);
  assert.equal(a.snoozedReason, null);
  assert.equal(a.lastMentionedAt, null);
  assert.ok(a.updatedAt, 'createTask sets updatedAt');

  // createTask preserves provenance/approval/assignment fields supplied by callers.
  await meetingsDb.insertAsync({ _id: 'M1', title: 'Planning', date: '2026-07-28T17:00:00.000Z', attendees: [] });
  const reviewTask: any = await createTask({
    title: 'Publish the launch notes',
    source: 'meeting-review',
    meetingId: 'M1',
    approval: { status: 'approved' },
    assignee: 'Ravi',
    aiExtracted: true,
  });
  assert.deepEqual(reviewTask.source, { type: 'meeting', id: 'M1' });
  assert.equal(reviewTask.meetingId, 'M1');
  assert.deepEqual(reviewTask.approval, { status: 'approved' });
  assert.equal(reviewTask.assignee, 'Ravi');
  assert.equal(reviewTask.owner, 'Ravi');
  assert.equal(reviewTask.aiExtracted, true);
  assert.equal(reviewTask.taskMentions[0].sourceTitle, 'Planning');

  const fallback: any = await createTask({ title: 'A plain standalone task' });
  assert.deepEqual(fallback.source, { type: 'manual' });
  assert.equal(fallback.aiExtracted, false);

  // snoozeTask → default getTasks excludes it
  await snoozeTask(b._id, 'stale-30d');
  const afterSnooze = await getTasks();
  assert.equal(afterSnooze.length, 4, 'default getTasks excludes snoozed');
  assert.ok(!afterSnooze.some((t: any) => t._id === b._id));

  // getTasks({ includeSnoozed: true }) returns everything
  const all = await getTasks({ includeSnoozed: true });
  assert.equal(all.length, 5, 'includeSnoozed: true returns all');

  // getSnoozedTasks → only snoozed
  const snoozed = await getSnoozedTasks();
  assert.equal(snoozed.length, 1);
  assert.equal(snoozed[0]._id, b._id);
  assert.equal(snoozed[0].snoozedReason, 'stale-30d');
  assert.ok(snoozed[0].snoozedAt, 'snoozedAt timestamp set');
  assert.ok(snoozed[0].updatedAt > a.updatedAt, 'snoozeTask bumps updatedAt');

  // bringBackTask → reappears in default getTasks, clears reason
  await bringBackTask(b._id);
  const afterBring = await getTasks();
  assert.equal(afterBring.length, 5, 'bringBack restores to default list');
  const restored = afterBring.find((t: any) => t._id === b._id);
  assert.ok(restored);
  assert.equal(restored.snoozedAt, null);
  assert.equal(restored.snoozedReason, null);
  const snoozedAfterBring = await getSnoozedTasks();
  assert.equal(snoozedAfterBring.length, 0, 'getSnoozedTasks empty after bringBack');

  // touchLastMentioned persists
  const when = '2026-04-01T10:00:00.000Z';
  await touchLastMentioned(c._id, when);
  const touched = (await getTasks()).find((t: any) => t._id === c._id);
  assert.equal(touched.lastMentionedAt, when);
  assert.ok(touched.updatedAt >= when);

  // archived tasks still excluded regardless of includeSnoozed
  await updateTask(a._id, { archivedAt: new Date().toISOString() });
  assert.ok(!(await getTasks()).some((t: any) => t._id === a._id));
  assert.ok(!(await getTasks({ includeSnoozed: true })).some((t: any) => t._id === a._id));

  // Self is returned and tagged; suggestions still exclude every known alias.
  setConfig({ userName: 'Ravi Kumar', selfEmails: ['ravi@example.com'] });
  await peopleDb.insertAsync({
    _id: 'self', name: 'Ravi Kumar', email: 'ravi@example.com',
    altNames: ['R. Kumar'], altEmails: ['rk@example.com'], archived: false,
  });
  const people = await getPeople();
  assert.equal(people.find((p: any) => p._id === 'self')?.isSelf, true);
  await meetingsDb.insertAsync({
    _id: 'recent-self', title: 'Solo sync', date: new Date().toISOString(), attendees: ['R. Kumar'],
  });
  assert.equal((await getSuggestedPeople()).some((p: any) => p.name === 'R. Kumar'), false);

  console.log('database: all tests passed');
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { run };
