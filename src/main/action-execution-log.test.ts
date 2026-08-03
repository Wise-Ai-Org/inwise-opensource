import * as assert from 'node:assert/strict';
import Datastore from '@seald-io/nedb';
import {
  __setActionExecutionsDbForTests,
  appendExecutionOutcome,
  createActionExecution,
  getActionExecution,
  listActionExecutionsByActionItem,
  recordActionStatusUpdate,
} from './action-execution-log';

async function run(): Promise<void> {
  const db = new Datastore<any>();
  await db.loadDatabaseAsync();
  await db.ensureIndexAsync({ fieldName: 'startIdempotencyKey', unique: true });
  __setActionExecutionsDbForTests(db);

  const input = {
    actionItemId: 'task-1',
    actionItemTitle: 'Send launch follow-up',
    objective: 'Send the reviewed launch follow-up to the product group',
    plan: ['Draft the message', 'Ask for final confirmation', 'Send it'],
    proposedTools: [
      { name: 'gmail.send', purpose: 'Send the approved message', target: 'product@example.com', dataShared: 'Task summary' },
    ],
    client: 'codex',
    approval: {
      approvedBy: 'Test User',
      approvedAt: new Date().toISOString(),
      scope: 'Send only to product@example.com after final draft review',
      approvedTools: ['gmail.send'],
    },
    idempotencyKey: 'start-task-1-001',
  };

  const started = await createActionExecution(input);
  assert.equal(started.replayed, false);
  assert.equal(started.execution.status, 'running');
  assert.equal(started.execution.auditTrail[0].type, 'execution-started');

  const startReplay = await createActionExecution(input);
  assert.equal(startReplay.replayed, true);
  assert.equal(startReplay.execution._id, started.execution._id);

  await assert.rejects(
    () => createActionExecution({ ...input, objective: 'A conflicting objective' }),
    /idempotencyKey was already used/,
  );
  await assert.rejects(
    () => createActionExecution({ ...input, plan: ['A conflicting plan'] }),
    /idempotencyKey was already used/,
  );

  const outcomeInput = {
    idempotencyKey: 'outcome-task-1-001',
    result: 'completed' as const,
    summary: 'Sent the approved launch follow-up.',
    artifacts: [
      { type: 'email', label: 'Sent follow-up', url: 'https://mail.example/message/1', externalId: 'message-1' },
    ],
    remainingWork: null,
    client: 'codex',
  };
  const appended = await appendExecutionOutcome(started.execution._id, outcomeInput);
  assert.equal(appended.replayed, false);
  assert.equal(appended.execution.status, 'completed');
  assert.equal(appended.execution.outcomes.length, 1);

  const outcomeReplay = await appendExecutionOutcome(started.execution._id, outcomeInput);
  assert.equal(outcomeReplay.replayed, true);
  assert.equal(outcomeReplay.execution.outcomes.length, 1);

  await assert.rejects(
    () => appendExecutionOutcome(started.execution._id, { ...outcomeInput, summary: 'Conflicting replay' }),
    /idempotencyKey was already used/,
  );
  await assert.rejects(
    () => appendExecutionOutcome(started.execution._id, { ...outcomeInput, artifacts: [] }),
    /idempotencyKey was already used/,
  );
  await assert.rejects(
    () => appendExecutionOutcome(started.execution._id, { ...outcomeInput, idempotencyKey: 'outcome-other-client', client: 'claude' }),
    /belongs to client/,
  );

  const statusInput = {
    actionItemId: 'task-1',
    fromStatus: 'todo',
    toStatus: 'completed',
    note: 'Verified from the sent-message artifact',
    client: 'codex',
    idempotencyKey: 'status-task-1-001',
  };
  const status = await recordActionStatusUpdate(started.execution._id, statusInput);
  assert.equal(status.replayed, false);
  assert.equal(status.execution.auditTrail.filter((e) => e.type === 'action-status-updated').length, 1);

  const statusReplay = await recordActionStatusUpdate(started.execution._id, statusInput);
  assert.equal(statusReplay.replayed, true);
  assert.equal(statusReplay.execution.auditTrail.filter((e) => e.type === 'action-status-updated').length, 1);
  await assert.rejects(
    () => recordActionStatusUpdate(started.execution._id, { ...statusInput, note: 'Conflicting note' }),
    /idempotencyKey was already used/,
  );

  const fetched = await getActionExecution(started.execution._id);
  assert.equal(fetched?.actionItemId, 'task-1');
  const byTask = await listActionExecutionsByActionItem('task-1');
  assert.equal(byTask.length, 1);

  console.log('action-execution-log: all tests passed');
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
