import * as assert from 'node:assert/strict';
import Datastore from '@seald-io/nedb';
import {
  __setTasksDbForTests,
  bringBackTask,
  createTask,
  getSnoozedTasks,
  getTasks,
  isSnoozed,
  snoozeTask,
  touchLastMentioned,
  updateTask,
} from './database';

async function run(): Promise<void> {
  // isSnoozed — pure helper
  assert.equal(isSnoozed(null), false);
  assert.equal(isSnoozed(undefined), false);
  assert.equal(isSnoozed({}), false);
  assert.equal(isSnoozed({ snoozedAt: null }), false);
  assert.equal(isSnoozed({ snoozedAt: '2026-04-21T00:00:00.000Z' }), true);

  // In-memory NeDB for all DB-backed tests
  const db = new Datastore<any>();
  await db.loadDatabaseAsync();
  __setTasksDbForTests(db);

  // createTask initialises the new fields to null
  const a = await createTask({ title: 'alpha', priority: 'high' });
  const b = await createTask({ title: 'bravo' });
  const c = await createTask({ title: 'charlie' });
  assert.equal(a.snoozedAt, null);
  assert.equal(a.snoozedReason, null);
  assert.equal(a.lastMentionedAt, null);
  assert.ok(a.updatedAt, 'createTask sets updatedAt');

  // snoozeTask → default getTasks excludes it
  await snoozeTask(b._id, 'stale-30d');
  const afterSnooze = await getTasks();
  assert.equal(afterSnooze.length, 2, 'default getTasks excludes snoozed');
  assert.ok(!afterSnooze.some((t: any) => t._id === b._id));

  // getTasks({ includeSnoozed: true }) returns everything
  const all = await getTasks({ includeSnoozed: true });
  assert.equal(all.length, 3, 'includeSnoozed: true returns all');

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
  assert.equal(afterBring.length, 3, 'bringBack restores to default list');
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

  console.log('database: all tests passed');
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { run };
