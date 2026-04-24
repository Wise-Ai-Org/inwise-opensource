import * as assert from 'node:assert/strict';
import Datastore from '@seald-io/nedb';
import {
  __setPendingApprovalsDbForTests,
  stashPending,
  getPending,
  listPending,
  removePending,
  PendingApprovalPayload,
} from './sor-pending-approvals';

async function freshDb(): Promise<Datastore<any>> {
  const db = new Datastore<any>();
  await db.loadDatabaseAsync();
  __setPendingApprovalsDbForTests(db);
  return db;
}

function makePayload(id: string, createdAt: string): PendingApprovalPayload {
  return {
    _id: id,
    targetSystem: 'jira',
    pushParams: {
      operation: 'create',
      args: { title: `Task ${id}`, projectKey: 'PROJ' },
    },
    meetingTitle: `Meeting for ${id}`,
    linkedTaskId: `task-${id}`,
    createdAt,
  };
}

async function run(): Promise<void> {
  // stash → get round-trip
  {
    await freshDb();
    await stashPending(makePayload('p1', '2026-04-20T00:00:00.000Z'));
    const got = await getPending('p1');
    assert.ok(got, 'row persisted');
    assert.equal(got!.linkedTaskId, 'task-p1');
    assert.equal(got!.pushParams.operation, 'create');
    assert.equal((got!.pushParams as any).args.title, 'Task p1');
  }

  // getPending returns null for unknown id
  {
    await freshDb();
    assert.equal(await getPending('nope'), null);
  }

  // listPending sorts newest-first
  {
    await freshDb();
    await stashPending(makePayload('old', '2026-04-10T00:00:00.000Z'));
    await stashPending(makePayload('new', '2026-04-22T00:00:00.000Z'));
    await stashPending(makePayload('mid', '2026-04-15T00:00:00.000Z'));
    const rows = await listPending();
    assert.equal(rows.length, 3);
    assert.equal(rows[0]._id, 'new', 'newest first');
    assert.equal(rows[1]._id, 'mid');
    assert.equal(rows[2]._id, 'old');
  }

  // removePending deletes by id, leaves others intact
  {
    await freshDb();
    await stashPending(makePayload('a', '2026-04-20T00:00:00.000Z'));
    await stashPending(makePayload('b', '2026-04-21T00:00:00.000Z'));
    await removePending('a');
    assert.equal(await getPending('a'), null);
    assert.ok(await getPending('b'));
    const rows = await listPending();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]._id, 'b');
  }

  // removePending on missing id is a no-op, not a throw
  {
    await freshDb();
    await stashPending(makePayload('solo', '2026-04-20T00:00:00.000Z'));
    await removePending('ghost'); // should not throw
    assert.ok(await getPending('solo'), 'unrelated row untouched');
  }

  console.log('sor-pending-approvals: all tests passed');
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { run };
