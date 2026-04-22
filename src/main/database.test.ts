import * as assert from 'node:assert/strict';
import Datastore from '@seald-io/nedb';
import {
  __setMeetingsDbForTests,
  __setPeopleDbForTests,
  __setTasksDbForTests,
  bringBackTask,
  convertActionItemToTask,
  createTask,
  dismissActionItem,
  getPerson,
  getSnoozedTasks,
  getTasks,
  isSnoozed,
  snoozeTask,
  touchLastMentioned,
  undismissActionItem,
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

  // ── Action item lifecycle (US-001) ────────────────────────────────────────
  {
    const tasksForActionItems = new Datastore<any>();
    await tasksForActionItems.loadDatabaseAsync();
    const meetings = new Datastore<any>();
    await meetings.loadDatabaseAsync();
    const people = new Datastore<any>();
    await people.loadDatabaseAsync();
    __setTasksDbForTests(tasksForActionItems);
    __setMeetingsDbForTests(meetings);
    __setPeopleDbForTests(people);

    const meetingId = 'm-001';
    await meetings.insertAsync({
      _id: meetingId,
      title: 'Sync with Dana',
      date: new Date().toISOString(),
      attendees: ['Dana Smith'],
      insights: {
        summary: 'stuff',
        actionItems: [
          { text: 'Send recap', owner: 'Dana Smith', dueDate: '' },
          { text: 'Update roadmap', owner: 'Dana Smith', dueDate: '' },
          { text: 'Archive old doc', owner: 'Dana Smith', dueDate: '' },
          { text: 'Unrelated side task', owner: 'Dana Smith', dueDate: '' },
          { text: 'Already wrapped', owner: 'Dana Smith', dueDate: '' },
        ],
        decisions: [],
        blockers: [],
        commitments: [],
      },
    });
    await people.insertAsync({
      _id: 'p-001',
      name: 'Dana Smith',
      email: 'dana@example.com',
      archived: false,
    });

    // convertActionItemToTask creates a task AND writes back convertedToTaskId
    const converted = await convertActionItemToTask(meetingId, 1, {
      title: 'Update roadmap',
    });
    assert.ok(converted.taskId, 'convertActionItemToTask returns taskId');
    const savedMeeting: any = await meetings.findOneAsync({ _id: meetingId });
    assert.equal(
      savedMeeting.insights.actionItems[1].convertedToTaskId,
      converted.taskId,
      'convertActionItemToTask writes back convertedToTaskId on insight',
    );
    assert.equal(
      savedMeeting.insights.actionItems[0].convertedToTaskId,
      undefined,
      'other indices untouched',
    );
    const createdTask: any = await tasksForActionItems.findOneAsync({ _id: converted.taskId });
    assert.ok(createdTask, 'task exists');
    assert.equal(createdTask.status, 'todo');
    assert.equal(createdTask.source.type, 'meeting');
    assert.equal(createdTask.source.id, meetingId);

    // Convert a second item and mark its task completed (for doneActionItems)
    const doneConvert = await convertActionItemToTask(meetingId, 4, {
      title: 'Already wrapped',
    });
    await updateTask(doneConvert.taskId, { status: 'completed' });

    // dismissActionItem sets the flag
    await dismissActionItem(meetingId, 2);
    const afterDismiss: any = await meetings.findOneAsync({ _id: meetingId });
    assert.equal(afterDismiss.insights.actionItems[2].dismissed, true, 'dismissed flag set');
    assert.notEqual(afterDismiss.insights.actionItems[0].dismissed, true, 'others not dismissed');

    // undismissActionItem clears it
    await undismissActionItem(meetingId, 2);
    const afterUndismiss: any = await meetings.findOneAsync({ _id: meetingId });
    assert.notEqual(
      afterUndismiss.insights.actionItems[2].dismissed,
      true,
      'undismiss clears flag',
    );

    // Re-dismiss for partitioning test
    await dismissActionItem(meetingId, 2);

    // getPerson partitions pending / active / done, excludes dismissed
    const person: any = await getPerson('p-001');
    assert.ok(person, 'person returned');
    // Pending: indices 0 and 3 (not converted, not dismissed)
    assert.equal(person.pendingActionItems.length, 2, 'two pending items');
    const pendingTexts = person.pendingActionItems.map((i: any) => i.text).sort();
    assert.deepEqual(pendingTexts, ['Send recap', 'Unrelated side task']);
    // Active: index 1 (converted, task status=todo)
    assert.equal(person.activeActionItems.length, 1, 'one active item');
    assert.equal(person.activeActionItems[0].text, 'Update roadmap');
    assert.equal(person.activeActionItems[0].taskStatus, 'todo');
    // Done: index 4 (converted, task status=completed)
    assert.equal(person.doneActionItems.length, 1, 'one done item');
    assert.equal(person.doneActionItems[0].text, 'Already wrapped');
    assert.equal(person.doneActionItems[0].taskStatus, 'completed');
    // Dismissed (index 2) appears in none
    const allReturned = [
      ...person.pendingActionItems,
      ...person.activeActionItems,
      ...person.doneActionItems,
    ];
    assert.ok(
      !allReturned.some((i: any) => i.text === 'Archive old doc'),
      'dismissed item excluded from all three tiers',
    );

    // Summary counts match
    assert.equal(person.summary.pendingActionItems, 2);
    assert.equal(person.summary.activeActionItems, 1);
    assert.equal(person.summary.doneActionItems, 1);
  }

  console.log('database: all tests passed');
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { run };
