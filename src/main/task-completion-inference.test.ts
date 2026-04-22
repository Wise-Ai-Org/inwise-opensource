import * as assert from 'node:assert/strict';
import Datastore from '@seald-io/nedb';
import {
  inferCompletedTaskIdsWith,
  buildUserMessage,
  parseInferenceResponse,
  OpenTaskForInference,
  LlmCaller,
} from './task-completion-inference';
import {
  __setTasksDbForTests,
  createTask,
  markLikelyDone,
  confirmLikelyDone,
  rejectLikelyDone,
  getTasks,
} from './database';

async function run(): Promise<void> {
  // ── parseInferenceResponse ──────────────────────────────────────────────────
  // Well-formed response with valid IDs
  const validIds = new Set(['a', 'b', 'c']);
  assert.deepEqual(
    parseInferenceResponse('{"completedTaskIds": ["a", "b"]}', validIds),
    ['a', 'b'],
  );

  // Fenced JSON (model sometimes returns ```json ... ```)
  assert.deepEqual(
    parseInferenceResponse('```json\n{"completedTaskIds": ["c"]}\n```', validIds),
    ['c'],
  );

  // Hallucinated IDs are filtered out
  assert.deepEqual(
    parseInferenceResponse('{"completedTaskIds": ["a", "zzz"]}', validIds),
    ['a'],
  );

  // Empty list
  assert.deepEqual(
    parseInferenceResponse('{"completedTaskIds": []}', validIds),
    [],
  );

  // Malformed JSON → empty (never throws)
  assert.deepEqual(parseInferenceResponse('not json', validIds), []);

  // Non-array field → empty
  assert.deepEqual(
    parseInferenceResponse('{"completedTaskIds": "a"}', validIds),
    [],
  );

  // ── buildUserMessage ────────────────────────────────────────────────────────
  const msg = buildUserMessage('hello world', [
    { _id: 't1', title: 'ship thing' },
    { _id: 't2', title: 'write docs' },
  ]);
  assert.ok(msg.includes('TRANSCRIPT:'));
  assert.ok(msg.includes('hello world'));
  assert.ok(msg.includes('OPEN TASKS:'));
  assert.ok(msg.includes('t1'));
  assert.ok(msg.includes('ship thing'));

  // ── inferCompletedTaskIdsWith — empty transcript ────────────────────────────
  {
    let called = false;
    const llm: LlmCaller = async () => { called = true; return ''; };
    const result = await inferCompletedTaskIdsWith('', [{ _id: 'a', title: 'x' }], llm);
    assert.deepEqual(result, []);
    assert.equal(called, false, 'LLM must NOT be called when transcript is empty');
  }

  // ── inferCompletedTaskIdsWith — no open tasks ──────────────────────────────
  {
    let called = false;
    const llm: LlmCaller = async () => { called = true; return ''; };
    const result = await inferCompletedTaskIdsWith('real transcript here', [], llm);
    assert.deepEqual(result, []);
    assert.equal(called, false, 'LLM must NOT be called when open tasks are empty');
  }

  // ── inferCompletedTaskIdsWith — single match ───────────────────────────────
  {
    const tasks: OpenTaskForInference[] = [
      { _id: 't1', title: 'ship login fix' },
      { _id: 't2', title: 'write onboarding docs' },
    ];
    const llm: LlmCaller = async (_sys, _user) => '{"completedTaskIds": ["t1"]}';
    const result = await inferCompletedTaskIdsWith('We shipped the login fix yesterday', tasks, llm);
    assert.deepEqual(result, ['t1']);
  }

  // ── inferCompletedTaskIdsWith — multi match ────────────────────────────────
  {
    const tasks: OpenTaskForInference[] = [
      { _id: 't1', title: 'ship login fix' },
      { _id: 't2', title: 'deploy metrics dashboard' },
      { _id: 't3', title: 'write onboarding docs' },
    ];
    const llm: LlmCaller = async () => '{"completedTaskIds": ["t1", "t2"]}';
    const result = await inferCompletedTaskIdsWith('transcript', tasks, llm);
    assert.deepEqual(result, ['t1', 't2']);
  }

  // ── inferCompletedTaskIdsWith — empty match ────────────────────────────────
  {
    const tasks: OpenTaskForInference[] = [{ _id: 't1', title: 'x' }];
    const llm: LlmCaller = async () => '{"completedTaskIds": []}';
    const result = await inferCompletedTaskIdsWith('nothing was done', tasks, llm);
    assert.deepEqual(result, []);
  }

  // ── inferCompletedTaskIdsWith — hallucinated IDs are filtered ──────────────
  {
    const tasks: OpenTaskForInference[] = [{ _id: 't1', title: 'x' }];
    const llm: LlmCaller = async () => '{"completedTaskIds": ["t1", "hallucinated"]}';
    const result = await inferCompletedTaskIdsWith('transcript', tasks, llm);
    assert.deepEqual(result, ['t1'], 'hallucinated IDs must be filtered out');
  }

  // ── inferCompletedTaskIdsWith — LLM throws → empty (never bubbles) ─────────
  {
    const tasks: OpenTaskForInference[] = [{ _id: 't1', title: 'x' }];
    const llm: LlmCaller = async () => { throw new Error('API down'); };
    const result = await inferCompletedTaskIdsWith('transcript', tasks, llm);
    assert.deepEqual(result, [], 'LLM errors must be swallowed (never break pipeline)');
  }

  // ── DB helpers: markLikelyDone, confirmLikelyDone, rejectLikelyDone ────────
  const db = new Datastore<any>();
  await db.loadDatabaseAsync();
  __setTasksDbForTests(db);

  const task = await createTask({ title: 'ship feature' });
  assert.equal(task.likelyDone, false, 'new tasks default to likelyDone=false');

  // markLikelyDone flips the flag but never touches status
  await markLikelyDone(task._id);
  {
    const updated = (await getTasks()).find((t: any) => t._id === task._id);
    assert.equal(updated.likelyDone, true);
    assert.notEqual(updated.status, 'done', 'markLikelyDone must NOT auto-set status to done');
    assert.ok(updated.updatedAt, 'updatedAt bumped');
  }

  // confirmLikelyDone clears the flag AND sets status=done
  await confirmLikelyDone(task._id);
  {
    const updated = (await getTasks()).find((t: any) => t._id === task._id);
    assert.equal(updated.likelyDone, false, 'likelyDone cleared after confirm');
    assert.equal(updated.status, 'done', 'confirm sets status=done');
  }

  // rejectLikelyDone clears the flag but leaves status alone
  const task2 = await createTask({ title: 'another task' });
  await markLikelyDone(task2._id);
  await rejectLikelyDone(task2._id);
  {
    const updated = (await getTasks()).find((t: any) => t._id === task2._id);
    assert.equal(updated.likelyDone, false, 'likelyDone cleared after reject');
    assert.equal(updated.status, 'todo', 'reject preserves original status');
  }

  console.log('task-completion-inference: all tests passed');
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { run };
