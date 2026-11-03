import * as assert from 'node:assert/strict';
import Datastore from '@seald-io/nedb';
import { __setSorWritesDbForTests, redactClosedAccount, FORMER_JIRA_USER } from './sor-write-log';
import {
  applyVerdicts, batches, collectAccounts, isReportDue, runPersonalDataReport,
  REPORT_INTERVAL_MS, ReportDeps, ReportedAccount,
} from './jira-personal-data';

const now = new Date('2026-11-02T18:00:00.000Z');
const issues = [
  { key: 'P-1', pulledAt: '2026-11-01T10:00:00.000Z', assignee: { accountId: 'a' }, reporter: { accountId: 'b' }, comments: [{ authorId: 'c' }, { authorId: null }] },
  { key: 'P-2', pulledAt: '2026-11-02T10:00:00.000Z', assignee: { accountId: 'a' }, reporter: null, comments: [] },
  { key: 'P-3', pulledAt: '2026-11-02T11:00:00.000Z', assignee: null, reporter: { accountId: 'me' } },
];
const people = [
  { _id: 'p1', jiraLink: { accountId: 'b', checkedAt: '2026-10-01T00:00:00.000Z' } },
  { _id: 'p2', jiraLink: { accountId: null, checkedAt: '2026-10-01T00:00:00.000Z' } },
  { _id: 'p3' },
];
const writes = [
  { _id: 'w1', createdAt: '2026-10-20T00:00:00.000Z', pushParams: { operation: 'assign', args: { issueKey: 'P-1', accountId: 'd' } } },
  { _id: 'w2', createdAt: '2026-10-20T00:00:00.000Z', pushParams: { operation: 'comment', args: {} } },
];

async function run(): Promise<void> {
  // Collects every account once, with the newest time we fetched it.
  const accts = collectAccounts({ selfAccountId: 'me', issues, people, writes, now });
  assert.deepEqual(accts.map(a => a.accountId), ['a', 'b', 'c', 'd', 'me']);
  assert.equal(accts.find(a => a.accountId === 'a')!.updatedAt, '2026-11-02T10:00:00.000Z');
  assert.equal(accts.find(a => a.accountId === 'b')!.updatedAt, '2026-11-01T10:00:00.000Z');
  assert.equal(accts.find(a => a.accountId === 'me')!.updatedAt, now.toISOString());

  // Batches of at most 90.
  const many = Array.from({ length: 200 }, (_, i) => i);
  assert.deepEqual(batches(many).map(b => b.length), [90, 90, 20]);

  // Due weekly.
  assert.equal(isReportDue(null, now), true);
  assert.equal(isReportDue(new Date(now.getTime() - REPORT_INTERVAL_MS + 1000).toISOString(), now), false);
  assert.equal(isReportDue(new Date(now.getTime() - REPORT_INTERVAL_MS).toISOString(), now), true);
  assert.equal(isReportDue('garbage', now), true);

  // Closed erases; updated drops the cached copy and the link.
  {
    const removed: string[][] = []; const cleared: string[] = []; const redacted: string[] = []; let disconnected = false;
    const res = await applyVerdicts(
      [{ accountId: 'b', status: 'closed' }, { accountId: 'd', status: 'closed' }, { accountId: 'a', status: 'updated' }],
      { selfAccountId: 'me', issues, people, writes },
      {
        removeIssues: async k => { removed.push(k); },
        clearPersonLink: async id => { cleared.push(id); },
        redactWrite: async id => { redacted.push(id); },
        disconnect: () => { disconnected = true; },
      },
    );
    assert.deepEqual(res, { closed: 2, updated: 1 });
    assert.deepEqual(removed, [['P-1', 'P-2']]);
    assert.deepEqual(cleared, ['p1']);
    assert.deepEqual(redacted, ['w1']);
    assert.equal(disconnected, false);
  }

  // My own account closed: disconnect Jira.
  {
    let disconnected = false;
    await applyVerdicts([{ accountId: 'me', status: 'closed' }], { selfAccountId: 'me', issues, people, writes }, {
      removeIssues: async () => {}, clearPersonLink: async () => {}, redactWrite: async () => {}, disconnect: () => { disconnected = true; },
    });
    assert.equal(disconnected, true);
  }

  // Full run: not connected or not due does nothing; due posts batches and records the time.
  const makeDeps = (over: Partial<ReportDeps> = {}) => {
    const state = { posts: [] as ReportedAccount[][], last: null as string | null, logs: [] as string[] };
    const deps: ReportDeps = {
      isConnected: () => true,
      selfAccountId: () => 'me',
      listIssues: async () => issues,
      listPeople: async () => people,
      listWrites: async () => writes,
      post: async a => { state.posts.push(a); return null; },
      removeIssues: async () => {}, clearPersonLink: async () => {}, redactWrite: async () => {}, disconnect: () => {},
      getLastReportAt: () => state.last,
      setLastReportAt: iso => { state.last = iso; },
      log: (_l, m) => { state.logs.push(m); },
      ...over,
    };
    return { deps, state };
  };
  {
    const { deps, state } = makeDeps({ isConnected: () => false });
    assert.equal((await runPersonalDataReport(deps, now)).ran, false);
    assert.equal(state.posts.length, 0);
  }
  {
    const { deps, state } = makeDeps();
    const r = await runPersonalDataReport(deps, now);
    assert.deepEqual(r, { ran: true, reported: 5, closed: 0, updated: 0 });
    assert.equal(state.posts.length, 1);
    assert.equal(state.last, now.toISOString());
    // Next day: not due.
    assert.equal((await runPersonalDataReport(deps, new Date(now.getTime() + 86_400_000))).ran, false);
  }
  {
    // Rate limited: not marked as reported, so tomorrow retries.
    const { deps, state } = makeDeps({ post: async () => { throw Object.assign(new Error('429'), { status: 429, retryAfterSec: 60 }); } });
    const r = await runPersonalDataReport(deps, now);
    assert.equal(r.error, 'rate limited, retry after 60s');
    assert.equal(state.last, null);
  }
  {
    // Ignores unknown statuses from the API.
    const { deps } = makeDeps({ post: async () => [{ accountId: 'a', status: 'bogus' as any }, { accountId: 'c', status: 'closed' }] });
    const r = await runPersonalDataReport(deps, now);
    assert.equal(r.closed, 1);
    assert.equal(r.updated, 0);
  }

  // Write log: a closed account's id and name are erased; a waiting suggestion is closed out.
  {
    const db = new Datastore({ inMemoryOnly: true });
    __setSorWritesDbForTests(db);
    await db.insertAsync({ _id: 'w9', operation: 'assign', result: 'pending-approval', suggestion: 'Assign P-1 to Jordan Lee?',
      fieldDiffs: [{ field: 'assignee', before: 'Sam', after: 'Jordan Lee' }],
      pushParams: { operation: 'assign', args: { issueKey: 'P-1', accountId: 'd', assigneeName: 'Jordan Lee', personId: 'p9' } } });
    await redactClosedAccount('w9');
    const e: any = await db.findOneAsync({ _id: 'w9' });
    assert.equal(e.pushParams.args.accountId, null);
    assert.equal(e.pushParams.args.assigneeName, FORMER_JIRA_USER);
    assert.equal(e.pushParams.args.personId, null);
    assert.ok(!JSON.stringify(e).includes('Jordan'));
    assert.equal(e.result, 'failed');
  }

  console.log('jira-personal-data: all tests passed');
}

if (require.main === module) {
  run().catch(e => { console.error(e); process.exit(1); });
}

export { run };
