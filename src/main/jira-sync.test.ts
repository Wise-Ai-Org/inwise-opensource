import * as assert from 'node:assert/strict';
import Datastore from '@seald-io/nedb';
import { __setTasksDbForTests, __setMeetingsDbForTests, saveInsights, resolvePendingDedup, onInsightsSaved, remapMeetingItemTask } from './database';
import { __setMatchDecisionsDbForTests } from './match-decision-log';
import { __setLlmForTests } from './task-dedup';
import { __setSorWritesDbForTests, listRecent, markCompleted } from './sor-write-log';
import { __setPendingApprovalsDbForTests, listPending } from './sor-pending-approvals';
import { __setJiraWriteDepsForTests, approveHeldWrite, linkedIssueKey } from './jira-writes';
import { __setJiraSyncDepsForTests, syncMeetingToJira, afterInsightsSaved, replanTaskAfterDedup, waitForMeetingSync, type StoryLike } from './jira-sync';
import type { PushParams } from './sor-write-log';

const DAY = 24 * 60 * 60 * 1000;
let tasks: Datastore<any>;
let meetings: Datastore<any>;
let mode: 'ask' | 'auto' = 'ask';
let stories: StoryLike[] = [];
let semanticAnswer: Record<string, string | null> = {};
const executed: PushParams[] = [];
let nextKey = 500;

async function fresh(): Promise<void> {
  tasks = new Datastore<any>();
  meetings = new Datastore<any>();
  const writes = new Datastore<any>();
  const pending = new Datastore<any>();
  const decisions = new Datastore<any>();
  await Promise.all([tasks, meetings, writes, pending, decisions].map((d) => d.loadDatabaseAsync()));
  __setTasksDbForTests(tasks);
  __setMeetingsDbForTests(meetings);
  __setSorWritesDbForTests(writes);
  __setPendingApprovalsDbForTests(pending);
  __setMatchDecisionsDbForTests(decisions);
  __setLlmForTests(async () => JSON.stringify({ results: [] }));
  executed.length = 0;
  mode = 'ask';
  stories = [];
  semanticAnswer = {};
  __setJiraWriteDepsForTests({
    prefs: () => ({ mode, threshold: 0.9 }),
    fetchBrief: async (key) => ({ key, title: `T ${key}`, status: 'To Do', statusCategory: 'new', dueDate: null, description: null, priority: null }),
    issueUrl: (key) => `https://x/browse/${key}`,
    execute: async (id, p) => {
      executed.push(p);
      const key = p.operation === 'create' ? `PILOT-${nextKey++}` : (p.args as any).issueKey;
      await markCompleted(id, 'success', undefined, p.operation === 'create' ? { targetRecordId: key } : undefined);
      return { ok: true, key, url: null };
    },
  });
  __setJiraSyncDepsForTests({
    loadStories: async () => stories,
    semantic: async () => semanticAnswer,
    settings: () => ({ autoPush: true, connected: true, projectKey: 'PILOT' }),
  });
  onInsightsSaved((meetingId, result) => { void afterInsightsSaved(meetingId, result); });
}

const EMPTY = { summary: '', decisions: [] as any[], blockers: [] as any[] };
const item = (text: string, extra: Record<string, any> = {}) => ({ text, owner: 'Sam', certainty: 0.95, dueDate: '2099-03-01', dueDateExplicit: true, ...extra });

async function settle(meetingId: string): Promise<void> {
  // The listener fires the Jira pass without awaiting; wait for it.
  await new Promise((r) => setImmediate(r));
  await waitForMeetingSync(meetingId);
}

async function run(): Promise<void> {
  // ── Reprocess twice -> exactly one create ─────────────────────────────
  {
    await fresh();
    mode = 'auto';
    await meetings.insertAsync({ _id: 'm1', title: 'Pilot sync', date: new Date().toISOString(), attendees: [], source: 'desktop_recording' });
    await saveInsights('m1', { ...EMPTY, actionItems: [item('Send onboarding survey to pilot customers')] });
    await settle('m1');
    // Task is still pending review, but very sure + auto -> pushed once.
    assert.equal(executed.filter((p) => p.operation === 'create').length, 1);
    const linkedTask = (await tasks.findAsync({}))[0];
    assert.ok(linkedIssueKey(linkedTask), 'the created issue is linked to the task');

    // Segment merge / retry re-runs extraction and the pass, twice.
    await saveInsights('m1', { ...EMPTY, actionItems: [item('Send onboarding survey to pilot customers')] });
    await settle('m1');
    await saveInsights('m1', { ...EMPTY, actionItems: [item('Send onboarding survey to pilot customers!')] });
    await settle('m1');
    await syncMeetingToJira('m1');
    assert.equal(executed.filter((p) => p.operation === 'create').length, 1, 'never a second create');
    assert.equal((await tasks.findAsync({})).length, 1, 'one task, not orphaned or duplicated');
    const m: any = await meetings.findOneAsync({ _id: 'm1' });
    assert.equal(m.insights.actionItems[0].taskId, linkedTask._id);
  }

  // ── Ask mode: held, linked to the task; approve once ──────────────────
  {
    await fresh();
    await meetings.insertAsync({ _id: 'm1', title: 'Pilot sync', date: new Date().toISOString(), attendees: [], source: 'zoom' });
    await saveInsights('m1', { ...EMPTY, actionItems: [item('Draft pricing page copy')] });
    await settle('m1');
    assert.equal(executed.length, 0);
    const pending = await listPending();
    assert.equal(pending.length, 1);
    const task = (await tasks.findAsync({}))[0];
    assert.equal(pending[0].linkedTaskId, task._id);
    // Reprocess does not queue a second approval.
    await saveInsights('m1', { ...EMPTY, actionItems: [item('Draft pricing page copy')] });
    await settle('m1');
    assert.equal((await listPending()).length, 1);
    assert.equal((await approveHeldWrite(pending[0]._id)).ok, true);
    assert.equal(executed.length, 1);

    // An item dropped by reprocessing takes its held write with it.
    await saveInsights('m1', { ...EMPTY, actionItems: [item('Draft pricing page copy'), item('Book the offsite venue')] });
    await settle('m1');
    assert.equal((await listPending()).length, 1);
    await saveInsights('m1', { ...EMPTY, actionItems: [item('Draft pricing page copy')] });
    await settle('m1');
    assert.equal((await listPending()).length, 0, 'held write of the removed task is skipped');
    const rows = await listRecent();
    assert.ok(rows.some((r) => r.errorMessage === 'User rejected'));
  }

  // ── Dedup 'ask' holds the Jira write until answered ───────────────────
  {
    await fresh();
    mode = 'auto';
    await meetings.insertAsync({ _id: 'm1', title: 'A', date: new Date(Date.now() - 3 * DAY).toISOString(), attendees: [], source: 'desktop_recording' });
    await meetings.insertAsync({ _id: 'm2', title: 'B', date: new Date().toISOString(), attendees: [], source: 'desktop_recording' });
    // An existing task, already linked to Jira.
    await tasks.insertAsync({ _id: 'old', title: 'Chase legal on the MSA redline', status: 'todo', source: { type: 'jira', id: 'OPS-3' }, jiraKey: 'OPS-3', approval: { status: 'approved' }, createdAt: new Date(Date.now() - 5 * DAY).toISOString(), archivedAt: null });
    __setLlmForTests(async () => JSON.stringify({ results: [{ index: 0, verdict: 'same_task', confidence: 72 }] }));
    await saveInsights('m2', { ...EMPTY, actionItems: [item('Still blocked on legal for the MSA redline')] });
    await settle('m2');
    const askTask = (await tasks.findAsync({})).find((t: any) => t._id !== 'old');
    assert.ok(askTask?.dedupSuggestion, 'the dedup question is pending');
    assert.equal((await listRecent()).length, 0, 'no Jira write while the dedup question is open');
    assert.equal(executed.length, 0);

    // The user says "same task": the item now targets the linked ticket -> comment, not create.
    const res = await resolvePendingDedup(askTask._id, 'same');
    assert.equal(res.mergedInto, 'old');
    await remapMeetingItemTask('m2', askTask._id, 'old');
    await replanTaskAfterDedup('m2', 'old');
    const rows = await listRecent();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].operation, 'comment');
    assert.equal(rows[0].targetRecordId, 'OPS-3');
    assert.equal(executed.filter((p) => p.operation === 'create').length, 0);
  }

  // ── Match before create: linked task, spoken key, middle band ─────────
  {
    await fresh();
    mode = 'auto';
    stories = [
      { jiraKey: 'PILOT-42', title: 'Send onboarding survey to pilot customers', description: '', jiraUrl: '' },
      { jiraKey: 'PILOT-7', title: 'Fix login timeout on mobile', description: '', jiraUrl: '' },
    ];
    await meetings.insertAsync({ _id: 'm1', title: 'Sync', date: new Date().toISOString(), attendees: [], source: 'desktop_recording' });
    await saveInsights('m1', { ...EMPTY, actionItems: [
      item('Close out PILOT-7 before the release'),
      item('Send the onboarding survey to our pilot customers'),
    ] });
    await settle('m1');
    const rows = await listRecent();
    const spoken = rows.find((r) => r.targetRecordId === 'PILOT-7')!;
    assert.equal(spoken.operation, 'comment', 'a spoken key gets an update, not a new ticket');
    const middle = rows.find((r) => r.targetRecordId === 'PILOT-42')!;
    assert.equal(middle.operation, 'comment');
    assert.equal(middle.result, 'pending-approval', 'a likely match is a suggestion, never silent');
    assert.equal(middle.suggestion, 'Update PILOT-42 instead?');
    assert.equal(executed.filter((p) => p.operation === 'create').length, 0);
  }

  // Middle band where the LLM says "no match" -> a create (through the gate).
  {
    await fresh();
    stories = [{ jiraKey: 'PILOT-42', title: 'Send onboarding survey to pilot customers', description: '', jiraUrl: '' }];
    semanticAnswer = { '1': null };
    await meetings.insertAsync({ _id: 'm1', title: 'Sync', date: new Date().toISOString(), attendees: [], source: 'desktop_recording' });
    await saveInsights('m1', { ...EMPTY, actionItems: [item('Send the onboarding survey to our pilot customers')] });
    await settle('m1');
    const rows = await listRecent();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].operation, 'create');
    assert.equal(rows[0].result, 'pending-approval', 'ask mode holds it');
  }

  // ── Ticket intents ────────────────────────────────────────────────────
  {
    await fresh();
    mode = 'ask';
    stories = [
      { jiraKey: 'PILOT-42', title: 'Send onboarding survey to pilot customers', description: '', jiraUrl: '' },
      { jiraKey: 'PILOT-9', title: 'Login timeout fix for mobile', description: '', jiraUrl: '', statusCategory: 'done' },
    ];
    await meetings.insertAsync({ _id: 'm1', title: 'Sync', date: new Date().toISOString(), attendees: [], source: 'desktop_recording' });
    await saveInsights('m1', { ...EMPTY, actionItems: [], ticketIntents: [
      { kind: 'done', issueKey: 'PILOT-42', ticketHint: 'survey', text: 'The survey is done', evidence: 'the survey is done', dueDate: null, certainty: 0.95 },
      { kind: 'due_moved', issueKey: null, ticketHint: 'onboarding survey pilot customers', text: 'Slipped to Tuesday', evidence: 'slipped to Tuesday', dueDate: '2099-03-03', certainty: 0.8 },
      { kind: 'done', issueKey: 'PILOT-9', ticketHint: '', text: 'login fix done', evidence: null, dueDate: null, certainty: 0.9 },
      { kind: 'decision', issueKey: null, ticketHint: 'something unrelated entirely', text: 'We go with vendor B', evidence: null, dueDate: null, certainty: 0.9 },
    ] } as any);
    await settle('m1');
    const rows = await listRecent();
    const transition = rows.find((r) => r.operation === 'transition')!;
    assert.equal(transition.targetRecordId, 'PILOT-42');
    assert.equal(transition.intent, 'done');
    assert.equal(transition.evidence, 'the survey is done');
    const update = rows.find((r) => r.operation === 'update')!;
    assert.deepEqual((update.pushParams as any).args.updates, { dueDate: '2099-03-03' });
    assert.equal(rows.length, 2, 'already-done ticket and unmatched decision produce no rows');
    // Re-running the pass changes nothing.
    await syncMeetingToJira('m1');
    assert.equal((await listRecent()).length, 2);
  }

  // ── Settings off / disconnected / demo meetings -> nothing ─────────────
  {
    await fresh();
    __setJiraSyncDepsForTests({ loadStories: async () => [], settings: () => ({ autoPush: false, connected: true, projectKey: 'PILOT' }) });
    await meetings.insertAsync({ _id: 'm1', title: 'Sync', date: new Date().toISOString(), attendees: [], source: 'desktop_recording' });
    await saveInsights('m1', { ...EMPTY, actionItems: [item('Anything')] });
    await settle('m1');
    assert.equal((await listRecent()).length, 0);
    __setJiraSyncDepsForTests({ loadStories: async () => [], settings: () => ({ autoPush: true, connected: true, projectKey: 'PILOT' }) });
    await meetings.insertAsync({ _id: 'demo', title: 'Demo', date: new Date().toISOString(), attendees: [], source: 'demo_seed' });
    await saveInsights('demo', { ...EMPTY, actionItems: [item('Demo item')] });
    await settle('demo');
    assert.equal((await listRecent()).length, 0, 'demo data never proposes Jira writes');
  }

  onInsightsSaved(null);
  console.log('jira-sync: all tests passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
