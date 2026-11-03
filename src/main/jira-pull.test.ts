import * as assert from 'node:assert/strict';
import Datastore from '@seald-io/nedb';
import { __setTasksDbForTests, __setMeetingsDbForTests, upsertPulledJiraTask, resolvePendingDedup } from './database';
import { __setMatchDecisionsDbForTests } from './match-decision-log';
import { __setLlmForTests } from './task-dedup';
import {
  computePullWindowDays, buildPullJql, mapIssueSnapshot, fetchAllPages, adfMentions, pullFields,
  __setJiraCacheDbForTests, listCachedIssues, PULL_MAX_PAGES,
} from './jira-pull';
import { __setJiraPullDepsForTests, runJiraPull } from './jira-sync';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2099-05-10T12:00:00Z');

function rawIssue(key: string, over: Record<string, any> = {}): any {
  return {
    key,
    fields: {
      summary: `Summary ${key}`,
      status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
      statuscategorychangedate: '2099-05-01T10:00:00.000+0000',
      updated: '2099-05-09T10:00:00.000+0000',
      created: '2099-04-01T10:00:00.000+0000',
      project: { key: key.split('-')[0] },
      priority: { name: 'High' },
      duedate: '2099-05-10',
      assignee: { accountId: 'me', displayName: 'Me Myself', emailAddress: 'me@x.com' },
      reporter: { accountId: 'sam', displayName: 'Sam Lee' },
      issuelinks: [
        { type: { inward: 'is blocked by', outward: 'blocks' }, inwardIssue: { key: 'OPS-1', fields: { summary: 'Vendor signs', status: { statusCategory: { key: 'new' } } } } },
        { type: { inward: 'is blocked by', outward: 'blocks' }, inwardIssue: { key: 'OPS-2', fields: { summary: 'Done thing', status: { statusCategory: { key: 'done' } } } } },
        { type: { inward: 'relates to', outward: 'relates to' }, outwardIssue: { key: 'OPS-3' } },
      ],
      customfield_10020: [
        { name: 'Sprint 11', state: 'closed', endDate: '2099-04-30T00:00:00Z' },
        { name: 'Sprint 12', state: 'active', endDate: '2099-05-11T00:00:00Z' },
      ],
      comment: {
        comments: [
          { author: { accountId: 'me', displayName: 'Me' }, created: '2099-05-02T09:00:00.000+0000', body: { type: 'doc', content: [] } },
          { author: { accountId: 'sam', displayName: 'Sam Lee' }, created: '2099-05-08T09:00:00.000+0000', body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'me', text: '@Me' } }, { type: 'text', text: ' can you check?' }] }] } },
        ],
      },
      description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body text' }] }] },
      ...over,
    },
  };
}

async function freshDbs(): Promise<{ tasks: Datastore<any>; cache: Datastore<any> }> {
  const tasks = new Datastore<any>();
  const meetings = new Datastore<any>();
  const decisions = new Datastore<any>();
  const cache = new Datastore<any>();
  await Promise.all([tasks, meetings, decisions, cache].map((d) => d.loadDatabaseAsync()));
  __setTasksDbForTests(tasks);
  __setMeetingsDbForTests(meetings);
  __setMatchDecisionsDbForTests(decisions);
  __setJiraCacheDbForTests(cache);
  __setLlmForTests(async () => JSON.stringify({ results: [] }));
  return { tasks, cache };
}

async function run(): Promise<void> {
  // ── Window ────────────────────────────────────────────────────────────
  assert.equal(computePullWindowDays(null, NOW.getTime()), 90, 'first pull looks back the max');
  assert.equal(computePullWindowDays(NOW.getTime() - 30 * 60_000, NOW.getTime()), 7, 'min 7 days');
  assert.equal(computePullWindowDays(NOW.getTime() - 20 * DAY, NOW.getTime()), 21, 'long absence widens the window');
  assert.equal(computePullWindowDays(NOW.getTime() - 400 * DAY, NOW.getTime()), 90, 'max 90 days');
  assert.equal(computePullWindowDays(NOW.getTime() + DAY, NOW.getTime()), 90, 'clock skew is treated as unknown');

  // ── JQL ───────────────────────────────────────────────────────────────
  assert.equal(
    buildPullJql({ windowDays: 21, attendeeAccountIds: ['a1', 'a2', 'a1'], defaultProject: 'PILOT' }),
    '(assignee = currentUser() OR reporter = currentUser() OR assignee in ("a1", "a2") OR project = "PILOT") AND updated >= -21d ORDER BY updated DESC',
  );
  assert.equal(
    buildPullJql({ windowDays: 7, defaultProject: 'bad project; drop' }),
    '(assignee = currentUser() OR reporter = currentUser()) AND updated >= -7d ORDER BY updated DESC',
    'odd project keys are not interpolated',
  );
  assert.ok(buildPullJql({ windowDays: 7, attendeeAccountIds: Array.from({ length: 40 }, (_, i) => `id${i}`) }).split('"id').length - 1 <= 15, 'attendee scope is bounded');
  assert.ok(pullFields('customfield_10101').includes('customfield_10101'));
  assert.ok(pullFields(null).includes('customfield_10020'));
  for (const f of ['duedate', 'assignee', 'reporter', 'issuelinks', 'comment']) assert.ok(pullFields(null).includes(f));

  // ── Field mapping ─────────────────────────────────────────────────────
  {
    const s = mapIssueSnapshot(rawIssue('PILOT-42'), { cloudUrl: 'https://x.atlassian.net', myAccountId: 'me', sprintFieldId: null, now: NOW });
    assert.equal(s.key, 'PILOT-42');
    assert.equal(s.url, 'https://x.atlassian.net/browse/PILOT-42');
    assert.equal(s.dueDate, '2099-05-10');
    assert.equal(s.statusCategory, 'indeterminate');
    assert.deepEqual(s.assignee, { accountId: 'me', name: 'Me Myself', email: 'me@x.com' });
    assert.equal(s.reporter?.name, 'Sam Lee');
    assert.deepEqual(s.blockedBy, [{ key: 'OPS-1', title: 'Vendor signs', done: false }], 'only open blockers');
    assert.deepEqual(s.sprint, { name: 'Sprint 12', state: 'active', endDate: '2099-05-11T00:00:00Z' });
    assert.equal(s.comments.length, 2);
    assert.equal(s.comments[1].mentionsMe, true);
    assert.equal(s.comments[0].mentionsMe, false);
    assert.equal(s.lastMyCommentAt, '2099-05-02T09:00:00.000+0000');
    assert.equal(s.assignedToMe, true);
    assert.equal(s.reportedByMe, false);
    assert.equal(adfMentions(null, 'me'), false);
  }

  // ── Pagination ────────────────────────────────────────────────────────
  {
    const tokens: (string | null)[] = [];
    const res = await fetchAllPages(async (token) => {
      tokens.push(token);
      if (token === null) return { issues: [1, 2], nextPageToken: 'p2' };
      if (token === 'p2') return { issues: [3], nextPageToken: 'p3' };
      return { issues: [4], nextPageToken: null };
    });
    assert.deepEqual(res.issues, [1, 2, 3, 4]);
    assert.equal(res.complete, true);
    assert.deepEqual(tokens, [null, 'p2', 'p3']);
    let calls = 0;
    const capped = await fetchAllPages(async () => { calls++; return { issues: [calls], nextPageToken: 'more' }; });
    assert.equal(calls, PULL_MAX_PAGES);
    assert.equal(capped.complete, false);
  }

  // ── runJiraPull end to end with a mocked Jira ─────────────────────────
  {
    const { tasks } = await freshDbs();
    // An existing local task linked to a different key must never be taken over.
    await tasks.insertAsync({ _id: 'other', title: 'Summary PILOT-2', status: 'todo', source: { type: 'jira', id: 'PILOT-99' }, jiraKey: 'PILOT-99', approval: { status: 'approved' }, archivedAt: null, createdAt: NOW.toISOString() });
    let lastSuccess: number | null = NOW.getTime() - 20 * DAY;
    const pages: Record<string, any> = {
      first: { issues: [rawIssue('PILOT-1'), rawIssue('PILOT-2')], nextPageToken: 'p2' },
      p2: { issues: [rawIssue('PILOT-3', { assignee: { accountId: 'sam', displayName: 'Sam Lee' } })], nextPageToken: null },
    };
    const seenJql: string[] = [];
    __setJiraPullDepsForTests({
      connected: () => true,
      lastSuccessMs: () => lastSuccess,
      markSuccess: (ms) => { lastSuccess = ms; },
      defaultProject: () => 'PILOT',
      cloudUrl: () => 'https://x.atlassian.net',
      myAccountId: () => 'me',
      attendeeEmails: async () => ['sam@x.com', 'nobody@x.com'],
      accountIdFor: async (email) => (email === 'sam@x.com' ? 'sam' : null),
      sprintFieldId: async () => null,
      fetchPage: async (jql, _f, token) => { seenJql.push(jql); return pages[token || 'first']; },
    });
    const res = await runJiraPull(NOW);
    assert.equal(res.ran, true);
    assert.equal(res.fetched, 3);
    assert.equal(res.pages, 'complete');
    assert.match(seenJql[0], /assignee in \("sam"\)/);
    assert.match(seenJql[0], /updated >= -21d/);
    assert.equal(lastSuccess, NOW.getTime(), 'success is recorded');
    const cached = await listCachedIssues();
    assert.equal(cached.length, 3, 'every issue lands in the cache for the moments');
    // PILOT-1 and PILOT-2 are mine -> local tasks; PILOT-3 is Sam's -> cache only.
    assert.equal(res.tasks.created, 2);
    const all = await tasks.findAsync({});
    assert.ok(all.some((t: any) => t.jiraKey === 'PILOT-1' && t.dueDate === '2099-05-10' && t.status === 'inProgress' && t.priority === 'high'));
    const other = all.find((t: any) => t._id === 'other');
    assert.equal(other.jiraKey, 'PILOT-99', 'a task linked to another key is never relinked');
    assert.ok(!all.some((t: any) => t.jiraKey === 'PILOT-3'));

    // Second pull: nothing new on Jira's side -> unchanged, no duplicates.
    const again = await runJiraPull(new Date(NOW.getTime() + 60_000));
    assert.equal(again.tasks.created, 0);
    assert.equal((await tasks.findAsync({})).length, all.length);
  }

  // ── Dedup 'ask' during pull goes to the queue, nothing dropped ─────────
  {
    const { tasks } = await freshDbs();
    await tasks.insertAsync({ _id: 'local', title: 'Chase legal on the MSA redline', status: 'todo', approval: { status: 'approved' }, archivedAt: null, createdAt: NOW.toISOString(), source: { type: 'manual' } });
    __setLlmForTests(async () => JSON.stringify({ results: [{ index: 0, verdict: 'same_task', confidence: 72 }] }));
    const res = await upsertPulledJiraTask({ key: 'OPS-9', url: 'u/OPS-9', title: 'Chase legal about the MSA redline', status: 'todo', dueDate: null, updatedAt: NOW.toISOString() });
    assert.equal(res.kind, 'ask');
    const queued: any = await tasks.findOneAsync({ _id: res.taskId });
    assert.ok(queued.dedupSuggestion, 'lands in the dedup queue');
    assert.equal(queued.jiraKey, 'OPS-9');
    // "Same task": the link moves to the local task (it had none).
    await resolvePendingDedup(res.taskId, 'same');
    const local: any = await tasks.findOneAsync({ _id: 'local' });
    assert.equal(local.jiraKey, 'OPS-9');
  }

  // A pulled issue never merges into a task linked to a different key, even via the dedup queue.
  {
    const { tasks } = await freshDbs();
    await tasks.insertAsync({ _id: 'linked', title: 'Chase legal on the MSA redline', status: 'todo', approval: { status: 'approved' }, archivedAt: null, createdAt: NOW.toISOString(), source: { type: 'jira', id: 'OPS-1' }, jiraKey: 'OPS-1' });
    __setLlmForTests(async () => JSON.stringify({ results: [{ index: 0, verdict: 'same_task', confidence: 95 }] }));
    const res = await upsertPulledJiraTask({ key: 'OPS-2', url: null, title: 'Chase legal on the MSA redline', status: 'todo', dueDate: null, updatedAt: NOW.toISOString() });
    assert.equal(res.kind, 'created', 'the linked task is not a dedup candidate for another key');
    assert.equal(((await tasks.findOneAsync({ _id: 'linked' })) as any).jiraKey, 'OPS-1');
  }

  __setJiraPullDepsForTests(null);
  console.log('jira-pull: all tests passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
