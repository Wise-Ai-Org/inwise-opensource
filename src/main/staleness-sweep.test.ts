import * as assert from 'node:assert/strict';
import Datastore from '@seald-io/nedb';
import { __setTasksDbForTests, createTask, getSnoozedTasks, getTasks, updateTask } from './database';
import { __resetLastSweepResultForTests, getLastSweepResult, sweepStaleTasks } from './staleness-sweep';

const NOW = new Date('2026-04-21T12:00:00.000Z');
const NOW_MS = NOW.getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

function iso(daysAgo: number): string {
  return new Date(NOW_MS - daysAgo * DAY_MS).toISOString();
}

async function freshDb(): Promise<void> {
  const db = new Datastore<any>();
  await db.loadDatabaseAsync();
  __setTasksDbForTests(db);
  __resetLastSweepResultForTests();
}

// Build a task and backdate its timestamps so eligibility windows are controllable.
async function makeTask(opts: {
  title: string;
  priority?: string;
  status?: string;
  updatedDaysAgo: number;
  lastMentionedDaysAgo?: number | null;
}): Promise<any> {
  const t = await createTask({ title: opts.title, priority: opts.priority });
  const updates: Record<string, any> = {
    updatedAt: iso(opts.updatedDaysAgo),
    status: opts.status ?? 'todo',
  };
  if (opts.lastMentionedDaysAgo !== undefined) {
    updates.lastMentionedAt = opts.lastMentionedDaysAgo === null ? null : iso(opts.lastMentionedDaysAgo);
  }
  return updateTask(t._id, updates);
}

async function run(): Promise<void> {
  // Happy path: a single clearly-stale task gets snoozed.
  {
    await freshDb();
    const stale = await makeTask({ title: 'stale-happy', updatedDaysAgo: 60 });
    const result = await sweepStaleTasks(NOW);
    assert.equal(result.snoozed.length, 1, 'happy path: one task snoozed');
    assert.equal(result.snoozed[0]._id, stale._id);

    const snoozedTasks = await getSnoozedTasks();
    assert.equal(snoozedTasks.length, 1);
    assert.equal(snoozedTasks[0].snoozedReason, 'stale-30d');
    assert.ok(snoozedTasks[0].snoozedAt, 'snoozedAt is set');

    // getTasks() default no longer returns the snoozed task.
    const remaining = await getTasks();
    assert.equal(remaining.length, 0);

    // lastSweepResult is stashed for downstream consumption.
    const cached = getLastSweepResult();
    assert.ok(cached, 'lastSweepResult stashed');
    assert.equal(cached!.snoozed.length, 1);
    assert.equal(cached!.eligible, 1);
    assert.equal(cached!.totalActive, 1);
    assert.ok(cached!.ranAt);
  }

  // Age gate: task updated recently (<30d) is NOT eligible.
  {
    await freshDb();
    await makeTask({ title: 'fresh', updatedDaysAgo: 5 });
    const result = await sweepStaleTasks(NOW);
    assert.equal(result.snoozed.length, 0, 'age gate: recent task not snoozed');
    assert.equal((await getSnoozedTasks()).length, 0);
  }

  // Mention gate: task recently mentioned (<14d) is NOT eligible even if old.
  {
    await freshDb();
    await makeTask({ title: 'old-but-mentioned', updatedDaysAgo: 60, lastMentionedDaysAgo: 3 });
    const result = await sweepStaleTasks(NOW);
    assert.equal(result.snoozed.length, 0, 'mention gate: recent mention blocks snooze');
  }

  // Mention gate (inverse): mention older than 14d does NOT block snooze.
  {
    await freshDb();
    const t = await makeTask({ title: 'old-old-mention', updatedDaysAgo: 60, lastMentionedDaysAgo: 30 });
    const result = await sweepStaleTasks(NOW);
    assert.equal(result.snoozed.length, 1, 'stale mention does not block snooze');
    assert.equal(result.snoozed[0]._id, t._id);
  }

  // Priority gate: high-priority task is NOT eligible.
  {
    await freshDb();
    await makeTask({ title: 'important', priority: 'high', updatedDaysAgo: 60 });
    const result = await sweepStaleTasks(NOW);
    assert.equal(result.snoozed.length, 0, 'priority gate: high-priority not snoozed');

    // Critical is also excluded (higher than high).
    await makeTask({ title: 'critical', priority: 'critical', updatedDaysAgo: 90 });
    const result2 = await sweepStaleTasks(NOW);
    assert.equal(result2.snoozed.length, 0, 'priority gate: critical not snoozed');
  }

  // Already-snoozed gate: already-snoozed tasks are NOT re-processed.
  {
    await freshDb();
    const t = await makeTask({ title: 'already', updatedDaysAgo: 60 });
    await updateTask(t._id, {
      snoozedAt: iso(10),
      snoozedReason: 'manual',
    });
    const result = await sweepStaleTasks(NOW);
    assert.equal(result.snoozed.length, 0, 'already-snoozed tasks skipped');
    // And we did not overwrite its existing reason.
    const snoozed = await getSnoozedTasks();
    assert.equal(snoozed.length, 1);
    assert.equal(snoozed[0].snoozedReason, 'manual', 'did not clobber existing snoozedReason');
  }

  // Log line counts reflect reality: 2 stale of 3 active (1 fresh, 1 high, 2 stale-eligible).
  {
    await freshDb();
    const stale1 = await makeTask({ title: 'stale-1', updatedDaysAgo: 45 });
    const stale2 = await makeTask({ title: 'stale-2', updatedDaysAgo: 90 });
    await makeTask({ title: 'fresh', updatedDaysAgo: 1 });
    await makeTask({ title: 'high', priority: 'high', updatedDaysAgo: 90 });
    const result = await sweepStaleTasks(NOW);
    assert.equal(result.snoozed.length, 2, 'two stale tasks snoozed');
    const ids = result.snoozed.map((t: any) => t._id).sort();
    assert.deepEqual(ids, [stale1._id, stale2._id].sort());

    const cached = getLastSweepResult();
    assert.equal(cached!.eligible, 2);
    assert.equal(cached!.totalActive, 4, 'totalActive counts all status==todo before sweep');
  }

  // Status gate: non-todo (e.g. 'done') tasks are NOT eligible.
  {
    await freshDb();
    await makeTask({ title: 'done-task', status: 'done', updatedDaysAgo: 90 });
    const result = await sweepStaleTasks(NOW);
    assert.equal(result.snoozed.length, 0, 'status gate: non-todo not snoozed');
  }

  console.log('staleness-sweep: all tests passed');
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { run };
