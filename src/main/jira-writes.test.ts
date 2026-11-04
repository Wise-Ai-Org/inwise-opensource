import * as assert from 'node:assert/strict';
import Datastore from '@seald-io/nedb';
import { setConfig } from './config';
import { __setTasksDbForTests, __setMeetingsDbForTests } from './database';
import { __setSorWritesDbForTests, listRecent, getWriteEntry, USER_REJECTED, recordWrite } from './sor-write-log';
import { __setPendingApprovalsDbForTests, listPending } from './sor-pending-approvals';
import {
  __setJiraWriteDepsForTests, submitJiraWrite, approveHeldWrite, rejectHeldWrite, retryJiraWrite,
  onTaskReviewed, linkTaskToIssue, linkedIssueKey, meetingItemKey,
} from './jira-writes';
import { executeJiraPush } from './jira-client';
import type { PushParams } from './sor-write-log';

let tasks: Datastore<any>;
let mode: 'ask' | 'auto' = 'ask';
const executed: { id: string; op: string }[] = [];
let nextKey = 100;
let executeResult: (p: PushParams) => { ok: boolean; error?: string; key?: string; url?: string | null } = (p) =>
  p.operation === 'create' ? { ok: true, key: `PILOT-${nextKey++}`, url: 'u' } : { ok: true, key: (p.args as any).issueKey };

async function fresh(): Promise<void> {
  tasks = new Datastore<any>();
  const meetings = new Datastore<any>();
  const writes = new Datastore<any>();
  const pending = new Datastore<any>();
  await Promise.all([tasks.loadDatabaseAsync(), meetings.loadDatabaseAsync(), writes.loadDatabaseAsync(), pending.loadDatabaseAsync()]);
  __setTasksDbForTests(tasks);
  __setMeetingsDbForTests(meetings);
  __setSorWritesDbForTests(writes);
  __setPendingApprovalsDbForTests(pending);
  executed.length = 0;
  mode = 'ask';
  __setJiraWriteDepsForTests({
    prefs: () => ({ mode, threshold: 0.9 }),
    fetchBrief: async (key) => ({ key, title: `Title of ${key}`, status: 'To Do', statusCategory: 'new', dueDate: null, description: null, priority: null }),
    issueUrl: (key) => `https://x.atlassian.net/browse/${key}`,
    execute: async (id, p) => {
      executed.push({ id, op: p.operation });
      const r = executeResult(p);
      const { markCompleted } = await import('./sor-write-log');
      await markCompleted(id, r.ok ? 'success' : 'failed', r.error, r.key && p.operation === 'create' ? { targetRecordId: r.key } : undefined);
      return r;
    },
  });
}

const create = (title: string): PushParams => ({ operation: 'create', args: { title, projectKey: 'PILOT' } });

async function run(): Promise<void> {
  // ── System create, ask mode: held, nothing pushed ─────────────────────
  {
    await fresh();
    await tasks.insertAsync({ _id: 't1', title: 'Send survey', approval: { status: 'pending' } });
    const out = await submitJiraWrite({ pushParams: create('Send survey'), initiator: 'system', confidence: 0.99, linkedTaskId: 't1', idempotencyKey: 'meeting:m1:send survey', sourceMeetingId: 'm1', meetingTitle: 'Pilot sync' });
    assert.equal(out.status, 'held');
    assert.equal(executed.length, 0);
    const rows = await listRecent();
    assert.equal(rows[0].result, 'pending-approval');
    assert.equal(rows[0].confidence, 0.99);
    assert.equal(rows[0].idempotencyKey, 'meeting:m1:send survey');
    assert.equal(rows[0].linkedTaskId, 't1');
    assert.equal(rows[0].sourceMeetingId, 'm1');
    assert.equal((await listPending()).length, 1);

    // Same item again (reprocess): duplicate, no second entry.
    const again = await submitJiraWrite({ pushParams: create('Send survey'), initiator: 'system', confidence: 0.99, linkedTaskId: 't1', idempotencyKey: 'meeting:m1:send survey' });
    assert.equal(again.status, 'duplicate');
    assert.equal((await listRecent()).length, 1);

    // Approve: pushes once, links the task, keeps the task.
    const res = await approveHeldWrite(rows[0]._id);
    assert.equal(res.ok, true);
    assert.equal(executed.length, 1);
    const t1 = await tasks.findOneAsync({ _id: 't1' });
    assert.equal(linkedIssueKey(t1), res.key);
    assert.equal(t1.approval.status, 'approved', 'approving the Jira change keeps the task');
    assert.equal((await listPending()).length, 0);
    assert.equal((await getWriteEntry(rows[0]._id))!.approvalPath, 'user');

    // A later create for the linked task (any path) is refused.
    const third = await submitJiraWrite({ pushParams: create('Send survey'), initiator: 'user', confidence: 1, linkedTaskId: 't1' });
    assert.equal(third.status, 'duplicate');
    assert.equal(executed.length, 1);
  }

  // ── Auto mode ─────────────────────────────────────────────────────────
  {
    await fresh();
    mode = 'auto';
    await tasks.insertAsync({ _id: 't1', title: 'A', approval: { status: 'pending' } });
    await tasks.insertAsync({ _id: 't2', title: 'B', approval: { status: 'pending' } });
    const sure = await submitJiraWrite({ pushParams: create('A'), initiator: 'system', confidence: 0.95, linkedTaskId: 't1', idempotencyKey: 'k1' });
    assert.equal(sure.status, 'pushed');
    assert.equal((await getWriteEntry((sure as any).id))!.approvalPath, 'auto');
    const unsure = await submitJiraWrite({ pushParams: create('B'), initiator: 'system', confidence: 0.6, linkedTaskId: 't2', idempotencyKey: 'k2' });
    assert.equal(unsure.status, 'held');
    // Keeping the task under auto releases the held write.
    assert.equal(await onTaskReviewed('t2', 'approved'), 1);
    assert.ok(linkedIssueKey(await tasks.findOneAsync({ _id: 't2' })));
    assert.equal(executed.length, 2);

    // Suggestions are never released by Keep.
    await tasks.insertAsync({ _id: 't3', title: 'C', approval: { status: 'pending' } });
    const sug = await submitJiraWrite({
      pushParams: { operation: 'comment', args: { issueKey: 'PILOT-42', comment: 'x' } },
      initiator: 'system', confidence: 0.99, linkedTaskId: 't3', idempotencyKey: 'k3', forceReview: true, suggestion: 'Update PILOT-42 instead?',
    });
    assert.equal(sug.status, 'held');
    assert.equal(await onTaskReviewed('t3', 'approved'), 0);
    assert.equal(executed.length, 2);
  }

  // ── Ask mode: keeping the task never pushes; skipping drops the write ──
  {
    await fresh();
    await tasks.insertAsync({ _id: 't1', title: 'A', approval: { status: 'pending' } });
    const held = await submitJiraWrite({ pushParams: create('A'), initiator: 'system', confidence: 0.99, linkedTaskId: 't1', idempotencyKey: 'k1' });
    assert.equal(held.status, 'held');
    assert.equal(await onTaskReviewed('t1', 'approved'), 0);
    assert.equal(executed.length, 0);
    assert.equal(await onTaskReviewed('t1', 'rejected'), 1);
    const entry = await getWriteEntry((held as any).id);
    assert.equal(entry!.errorMessage, USER_REJECTED);
    assert.equal((await listPending()).length, 0);
  }

  // ── Dedup pending -> waiting (no entry); skipped task -> dropped ───────
  {
    await fresh();
    await tasks.insertAsync({ _id: 'ask', title: 'A', approval: { status: 'pending' }, dedupSuggestion: { candidateTaskId: 'x' } });
    await tasks.insertAsync({ _id: 'no', title: 'B', approval: { status: 'rejected' } });
    assert.equal((await submitJiraWrite({ pushParams: create('A'), initiator: 'system', confidence: 1, linkedTaskId: 'ask', idempotencyKey: 'a' })).status, 'waiting');
    assert.equal((await submitJiraWrite({ pushParams: create('B'), initiator: 'system', confidence: 1, linkedTaskId: 'no', idempotencyKey: 'b' })).status, 'dropped');
    assert.equal((await listRecent()).length, 0, 'nothing recorded until the question is answered');
  }

  // ── User-initiated writes (renderer IPC, task edits): pushed + logged ──
  {
    await fresh();
    for (const p of [
      { operation: 'transition', args: { issueKey: 'PILOT-1', targetStatus: 'completed' } },
      { operation: 'update', args: { issueKey: 'PILOT-1', updates: { dueDate: '2099-01-01' } } },
      { operation: 'comment', args: { issueKey: 'PILOT-1', comment: 'hello', meetingTitle: 'M' } },
      create('Manual'),
    ] as PushParams[]) {
      const out = await submitJiraWrite({ pushParams: p, initiator: 'user', confidence: 1 });
      assert.equal(out.status, 'pushed', `user ${p.operation} pushes`);
    }
    const rows = await listRecent();
    assert.equal(rows.length, 4);
    assert.ok(rows.every((r) => r.approvalPath === 'user' && r.initiator === 'user' && r.confidence === 1));
    const transition = rows.find((r) => r.operation === 'transition')!;
    assert.deepEqual(transition.fieldDiffs, [{ field: 'status', before: 'To Do', after: 'Done' }]);
    assert.equal(transition.issueTitle, 'Title of PILOT-1');
    const comment = rows.find((r) => r.operation === 'comment')!;
    assert.ok(comment.commentBody!.startsWith('[Inwise] From "M"'));
  }

  // ── Reject + retry paths ──────────────────────────────────────────────
  {
    await fresh();
    await tasks.insertAsync({ _id: 't1', title: 'A', approval: { status: 'approved' } });
    const held = await submitJiraWrite({ pushParams: create('A'), initiator: 'system', confidence: 0.5, linkedTaskId: 't1', idempotencyKey: 'k' });
    assert.equal((await rejectHeldWrite((held as any).id)).ok, true);
    assert.equal((await retryJiraWrite((held as any).id)).ok, false, 'a skipped change cannot be retried');
    assert.equal((await rejectHeldWrite('missing')).ok, false);

    // A failed create is retried once the user clicks; never re-created if the task got linked meanwhile.
    executeResult = () => ({ ok: false, error: 'Jira API error 500' });
    await tasks.insertAsync({ _id: 't2', title: 'B', approval: { status: 'approved' } });
    const failed = await submitJiraWrite({ pushParams: create('B'), initiator: 'user', confidence: 1, linkedTaskId: 't2' });
    assert.equal(failed.status, 'failed');
    executeResult = (p) => p.operation === 'create' ? { ok: true, key: `PILOT-${nextKey++}`, url: 'u' } : { ok: true };
    const dupOfFailed = await submitJiraWrite({ pushParams: create('B'), initiator: 'system', confidence: 1, linkedTaskId: 't2' });
    assert.equal(dupOfFailed.status, 'duplicate', 'a failed create is retried, not created again');
    await linkTaskToIssue('t2', 'PILOT-9', null);
    const retried = await retryJiraWrite((failed as any).id);
    assert.equal(retried.ok, false);
    assert.match(retried.error!, /already linked to PILOT-9/);
  }

  // ── linkTaskToIssue never steals a task linked to another key ──────────
  {
    await fresh();
    await tasks.insertAsync({ _id: 't1', title: 'A', source: { type: 'jira', id: 'PILOT-1' } });
    assert.equal(await linkTaskToIssue('t1', 'PILOT-2'), false);
    assert.equal(linkedIssueKey(await tasks.findOneAsync({ _id: 't1' })), 'PILOT-1');
    assert.equal(await linkTaskToIssue(undefined, 'PILOT-2'), false, 'no task id -> no write');
    assert.equal(meetingItemKey('m1', '  Send the Survey!! '), 'meeting:m1:send the survey');
  }

  // ── executeJiraPush transition mapping against a mocked Jira ───────────
  {
    await fresh();
    __setJiraWriteDepsForTests(null);
    setConfig({ jiraTokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000, cloudId: 'c', cloudName: 'x', cloudUrl: 'https://x.atlassian.net', accountId: 'me', email: '', displayName: '' } } as any);
    const calls: { url: string; method: string; body?: any }[] = [];
    let transitions: any[] = [{ id: '21', name: 'Start', to: { name: 'Doing', statusCategory: { key: 'indeterminate' } } }];
    (globalThis as any).fetch = async (url: string, opts: any = {}) => {
      calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
      const body = url.endsWith('/transitions') && (opts.method || 'GET') === 'GET' ? { transitions } : {};
      return { ok: true, status: opts.method === 'POST' ? 204 : 200, json: async () => body, text: async () => (opts.method === 'POST' ? '' : JSON.stringify(body)) } as any;
    };
    const id = await recordWrite({ targetSystem: 'jira', targetRecordId: 'PILOT-42', operation: 'transition' });
    const miss = await executeJiraPush(id, { operation: 'transition', args: { issueKey: 'PILOT-42', targetStatus: 'completed' } });
    assert.equal(miss.ok, false);
    assert.equal(miss.error, 'PILOT-42 has no transition to Done');
    assert.equal((await getWriteEntry(id))!.errorMessage, 'PILOT-42 has no transition to Done');
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);

    transitions = [...transitions, { id: '31', name: 'Ship it', to: { name: 'Shipped', statusCategory: { key: 'done' } } }];
    const id2 = await recordWrite({ targetSystem: 'jira', targetRecordId: 'PILOT-42', operation: 'transition' });
    const hit = await executeJiraPush(id2, { operation: 'transition', args: { issueKey: 'PILOT-42', targetStatus: 'completed' } });
    assert.equal(hit.ok, true);
    const post = calls.find((c) => c.method === 'POST')!;
    assert.deepEqual(post.body, { transition: { id: '31' } });
    assert.equal((await getWriteEntry(id2))!.result, 'success');
  }

  console.log('jira-writes: all tests passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
