import * as assert from 'node:assert/strict';
import Datastore from '@seald-io/nedb';
import { setConfig } from './config';
import { __setTasksDbForTests, __setMeetingsDbForTests, saveInsights, onInsightsSaved } from './database';
import { __setMatchDecisionsDbForTests } from './match-decision-log';
import { __setLlmForTests } from './task-dedup';
import { __setSorWritesDbForTests, listRecent, recordWrite, getWriteEntry, markCompleted } from './sor-write-log';
import { __setPendingApprovalsDbForTests, listPending } from './sor-pending-approvals';
import { executeJiraPush, searchJiraUsers, findSprintForIssue, fetchIssueStatusChanges } from './jira-client';
import { __setJiraWriteDepsForTests, approveHeldWrite, resolveHeldAssignee, submitJiraWrite } from './jira-writes';
import { __setJiraSyncDepsForTests, afterInsightsSaved, waitForMeetingSync, type StoryLike } from './jira-sync';
import type { PushParams } from './sor-write-log';

type Route = (url: string, method: string, body: any) => { status?: number; json?: any; empty?: boolean } | undefined;
let route: Route = () => undefined;
const calls: { url: string; method: string; body: any }[] = [];
(globalThis as any).fetch = async (url: string, opts: any = {}) => {
  const method = opts.method || 'GET';
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  calls.push({ url, method, body });
  const r = route(url, method, body) || {};
  const status = r.status ?? 200;
  return { ok: status < 400, status, json: async () => { if (r.empty) throw new SyntaxError('Unexpected end of JSON input'); return r.json ?? {}; }, text: async () => (r.empty ? '' : JSON.stringify(r.json ?? {})) } as any;
};

async function freshDbs(): Promise<{ tasks: Datastore<any>; meetings: Datastore<any> }> {
  const tasks = new Datastore<any>(), meetings = new Datastore<any>(), writes = new Datastore<any>(), pending = new Datastore<any>(), decisions = new Datastore<any>();
  await Promise.all([tasks, meetings, writes, pending, decisions].map((d) => d.loadDatabaseAsync()));
  __setTasksDbForTests(tasks); __setMeetingsDbForTests(meetings); __setSorWritesDbForTests(writes);
  __setPendingApprovalsDbForTests(pending); __setMatchDecisionsDbForTests(decisions);
  __setLlmForTests(async () => JSON.stringify({ results: [] }));
  return { tasks, meetings };
}

async function run(): Promise<void> {
  setConfig({ jiraTokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000, cloudId: 'c1', cloudName: 'x', cloudUrl: 'https://x.atlassian.net', accountId: 'me', email: '', displayName: '' } } as any);
  await freshDbs();

  // ── jira-client: user search ──────────────────────────────────────────
  {
    route = (url) => url.includes('/rest/api/3/user/search') ? { json: [
      { accountId: 'acc-j', displayName: 'Jordan Lee', accountType: 'atlassian', active: true },
      { accountId: 'app-1', displayName: 'Automation', accountType: 'app' },
      { accountId: 'gone', displayName: 'Old Jordan', accountType: 'atlassian', active: false },
    ] } : undefined;
    const users = await searchJiraUsers('Jordan');
    assert.deepEqual(users.map((u) => u.accountId), ['acc-j'], 'people only, active only');
    assert.match(calls[calls.length - 1].url, /query=Jordan/);
    assert.deepEqual(await searchJiraUsers('J'), [], 'too short: no call');
  }

  // ── jira-client: assign, link, sprint pushes ──────────────────────────
  {
    route = () => ({ status: 204 });
    const assignId = await recordWrite({ targetSystem: 'jira', targetRecordId: 'PILOT-40', operation: 'assign' });
    const a = await executeJiraPush(assignId, { operation: 'assign', args: { issueKey: 'PILOT-40', accountId: 'acc-j', assigneeName: 'Jordan Lee' } });
    assert.equal(a.ok, true);
    assert.deepEqual(calls[calls.length - 1], { url: 'https://api.atlassian.com/ex/jira/c1/rest/api/3/issue/PILOT-40/assignee', method: 'PUT', body: { accountId: 'acc-j' } });

    const unresolvedId = await recordWrite({ targetSystem: 'jira', targetRecordId: 'PILOT-40', operation: 'assign' });
    const before = calls.length;
    const u = await executeJiraPush(unresolvedId, { operation: 'assign', args: { issueKey: 'PILOT-40', accountId: null, assigneeName: 'Jordan Lee' } });
    assert.equal(u.ok, false);
    assert.equal(calls.length, before, 'never sends an assignment without an account');

    // Jira answers POST /issueLink with 201 and an empty body.
    const prevLinkRoute = route;
    route = (url, m, b) => url.endsWith('/rest/api/3/issueLink') ? { status: 201, empty: true } : prevLinkRoute(url, m, b);
    const linkId = await recordWrite({ targetSystem: 'jira', targetRecordId: 'PILOT-33', operation: 'link' });
    assert.equal((await executeJiraPush(linkId, { operation: 'link', args: { blockedKey: 'PILOT-33', blockerKey: 'OPS-12' } })).ok, true);
    route = prevLinkRoute;
    assert.deepEqual(calls[calls.length - 1].body, { type: { name: 'Blocks' }, inwardIssue: { key: 'OPS-12' }, outwardIssue: { key: 'PILOT-33' } }, 'reads "OPS-12 blocks PILOT-33"');

    const prevRoute = route;
    route = (url, m, b) => url.endsWith('/rest/api/3/field') ? { json: [{ id: 'customfield_10020', schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } }] } : prevRoute(url, m, b);
    const sprintId = await recordWrite({ targetSystem: 'jira', targetRecordId: 'PILOT-41', operation: 'sprint' });
    assert.equal((await executeJiraPush(sprintId, { operation: 'sprint', args: { issueKey: 'PILOT-41', sprintId: 14, sprintName: 'Sprint 14' } })).ok, true);
    assert.deepEqual(calls[calls.length - 1], { url: 'https://api.atlassian.com/ex/jira/c1/rest/api/3/issue/PILOT-41', method: 'PUT', body: { fields: { customfield_10020: 14 } } });
    assert.ok(!calls.some(c => c.url.includes('/rest/agile/')), 'no Jira Software API (no extra scopes)');

    route = (url) => url.endsWith('/rest/api/3/field')
      ? { json: [{ id: 'customfield_10020', schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } }] }
      : { status: 403, json: { errorMessages: ['no'] } };
    const denied = await recordWrite({ targetSystem: 'jira', targetRecordId: 'PILOT-41', operation: 'sprint' });
    const d = await executeJiraPush(denied, { operation: 'sprint', args: { issueKey: 'PILOT-41', sprintId: 14, sprintName: 'Sprint 14' } });
    assert.match(d.error!, /did not allow this change \(403\)\. Reconnect Jira/);
    assert.match((await getWriteEntry(denied))!.errorMessage!, /Reconnect Jira/, 'the reason is logged, not a silent failure');
  }

  // ── jira-client: sprint lookup (issue search, no Jira Software API) ──
  {
    const field = { id: 'customfield_10020', schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } };
    const site = (open: any[], future: any[]) => (url: string, _m: string, b: any) => {
      if (url.endsWith('/rest/api/3/field')) return { json: [field] };
      if (url.endsWith('/rest/api/3/search/jql')) {
        const list = /openSprints/.test(b?.jql) ? open : future;
        return { json: { issues: list.map(sp => ({ fields: { customfield_10020: [sp] } })), isLast: true } };
      }
      return undefined;
    };
    route = site(
      [{ id: 14, name: 'Sprint 14', state: 'active', boardId: 7 }, { id: 13, name: 'Sprint 13', state: 'closed', boardId: 7 }],
      [{ id: 16, name: 'Sprint 16', state: 'future', boardId: 7, startDate: '2026-11-30T00:00:00Z' }, { id: 15, name: 'Sprint 15', state: 'future', boardId: 7, startDate: '2026-11-16T00:00:00Z' }],
    );
    assert.deepEqual(await findSprintForIssue('PILOT-41'), { ok: true, sprintId: 14, sprintName: 'Sprint 14', state: 'active', boardId: 7 });
    const next = await findSprintForIssue('PILOT-41', 'next');
    assert.equal(next.ok && next.sprintName, 'Sprint 15');
    assert.match(calls.filter(c => c.url.endsWith('/search/jql')).pop()!.body.jql, /^project = "PILOT" AND sprint in futureSprints\(\)$/);

    route = site([], []);
    const none = await findSprintForIssue('PILOT-41');
    assert.equal(!none.ok && none.reason, 'PILOT has no active or upcoming sprint');

    route = site([], [{ id: 15, name: 'Sprint 15', state: 'future', boardId: 7 }]);
    const onlyFuture = await findSprintForIssue('PILOT-41');
    assert.equal(onlyFuture.ok && onlyFuture.sprintName, 'Sprint 15');

    route = (url) => url.endsWith('/rest/api/3/field') ? { json: [] } : undefined;
    const noField = await findSprintForIssue('PILOT-41');
    assert.match(!noField.ok ? noField.reason : '', /has no sprints/);
  }

  // ── jira-client: changelog paging jumps to the newest page ────────────
  {
    route = (url) => url.includes('startAt=')
      ? { json: { values: [{ created: '2026-11-01T10:00:00Z', items: [{ field: 'status', fromString: 'In Review', toString: 'QA' }] }], isLast: true } }
      : url.includes('/changelog') ? { json: { values: [{ created: '2025-01-01T10:00:00Z', items: [{ field: 'status', fromString: 'To Do', toString: 'In Progress' }] }], total: 250, isLast: false } } : undefined;
    const changes = await fetchIssueStatusChanges('PILOT-41');
    assert.deepEqual(changes.map((c) => c.to), ['QA']);
    assert.match(calls[calls.length - 1].url, /changelog\?startAt=150&maxResults=100/);
  }

  // ── Recap actions from ticket intents, through the gate ───────────────
  {
    const { meetings } = await freshDbs();
    const executed: PushParams[] = [];
    __setJiraWriteDepsForTests({
      prefs: () => ({ mode: 'auto', threshold: 0.9 }),
      fetchBrief: async () => null,
      issueUrl: (k) => `u/${k}`,
      execute: async (id, p) => { executed.push(p); await markCompleted(id, 'success'); return { ok: true, key: (p.args as any).issueKey || (p.args as any).blockedKey }; },
    });
    const stories: StoryLike[] = [
      { jiraKey: 'PILOT-40', title: 'Pilot onboarding emails', description: '', jiraUrl: '' },
      { jiraKey: 'PILOT-41', title: 'Pilot pricing page', description: '', jiraUrl: '' },
      { jiraKey: 'PILOT-33', title: 'Pilot SSO setup', description: '', jiraUrl: '' },
      { jiraKey: 'PILOT-50', title: 'Pilot audit log', description: '', jiraUrl: '', blockedByKeys: ['OPS-12'] },
      { jiraKey: 'OPS-12', title: 'SSO certificate rotation', description: '', jiraUrl: '' },
    ];
    const savedLinks: Record<string, any> = {};
    const people: Record<string, any> = {
      jordan: { _id: 'p-jordan', name: 'Jordan Lee', email: 'jordan@hidden.com' },
      priya: { _id: 'p-priya', name: 'Priya Shah', jiraLink: { status: 'linked', accountId: 'acc-priya', displayName: 'Priya Shah', checkedAt: '' } },
    };
    let semanticAnswer: Record<string, string | null> = {};
    __setJiraSyncDepsForTests({
      loadStories: async () => stories,
      semantic: async () => semanticAnswer,
      settings: () => ({ autoPush: true, connected: true, projectKey: 'PILOT' }),
      linkedTasks: async () => [],
      findPerson: async (name) => (/jordan/i.test(name) ? people.jordan : /priya/i.test(name) ? people.priya : null),
      lookupEmail: async () => null,
      saveLink: async (id, link) => { savedLinks[id] = link; },
      self: () => ({ accountId: 'acc-me', displayName: 'Shravani Vatti' }),
      findSprint: async (key, prefer) => (key === 'PILOT-41' ? { ok: true, sprintId: 14, sprintName: 'Sprint 14', state: 'active', boardId: 7 } : { ok: false, reason: `PILOT's board has no active or upcoming sprint` }),
    });
    onInsightsSaved((id, r) => { void afterInsightsSaved(id, r); });
    await meetings.insertAsync({ _id: 'm1', title: 'Pilot sync', date: new Date().toISOString(), attendees: [], source: 'desktop_recording' });
    await saveInsights('m1', { summary: '', decisions: [], blockers: [], actionItems: [], ticketIntents: [
      { kind: 'reassign', issueKey: 'PILOT-40', ticketHint: '', text: 'Jordan will take PILOT-40', assigneeName: 'Jordan', evidence: 'Jordan will take PILOT-40', certainty: 0.95 },
      { kind: 'reassign', issueKey: 'PILOT-33', ticketHint: '', text: 'Priya takes PILOT-33', assigneeName: 'Priya', evidence: 'Priya takes PILOT-33', certainty: 0.95 },
      { kind: 'blocked_by', issueKey: 'PILOT-33', ticketHint: '', text: 'blocked on the SSO work', blockerKey: 'OPS-12', blockerHint: null, evidence: 'PILOT-33 is blocked on OPS-12', certainty: 0.9 },
      { kind: 'blocked_by', issueKey: 'PILOT-50', ticketHint: '', text: 'audit log waits on certs', blockerKey: 'OPS-12', blockerHint: null, evidence: 'PILOT-50 is blocked by OPS-12', certainty: 0.9 },
      { kind: 'blocked_by', issueKey: 'PILOT-41', ticketHint: '', text: 'blocked on some legal thing', blockerKey: null, blockerHint: 'some legal thing', evidence: 'waiting on legal', certainty: 0.9 },
      { kind: 'sprint', issueKey: 'PILOT-41', ticketHint: '', text: 'pull it into this sprint', sprint: 'active', evidence: "let's pull PILOT-41 into this sprint", certainty: 0.9 },
      { kind: 'sprint', issueKey: 'PILOT-40', ticketHint: '', text: 'next sprint', sprint: 'next', evidence: 'PILOT-40 next sprint', certainty: 0.9 },
    ] } as any);
    await new Promise((r) => setImmediate(r));
    await waitForMeetingSync('m1');
    const rows = await listRecent();
    const byOp = (op: string, key: string) => rows.find((r) => r.operation === op && r.targetRecordId === key)!;

    // a. Reassign: unresolved person -> held with "Find in Jira", never guessed, even under auto.
    const jordanRow = byOp('assign', 'PILOT-40');
    assert.equal(jordanRow.result, 'pending-approval');
    assert.equal(jordanRow.needs, 'jira-user');
    assert.match(jordanRow.blockedReason!, /Jordan Lee is not linked to Jira yet/);
    assert.equal((jordanRow.pushParams as any).args.accountId, null);
    assert.equal(savedLinks['p-jordan'].status, 'unresolved');
    assert.equal((await approveHeldWrite(jordanRow._id)).ok, false, 'Approve is refused until the person is found');
    // Resolved person (stored id) -> an ordinary held row (0.88 is under the 0.9 auto line), approvable as is.
    const priyaRow = byOp('assign', 'PILOT-33');
    assert.equal(priyaRow.result, 'pending-approval');
    assert.equal(priyaRow.blockedReason, null);
    assert.equal(priyaRow.confidence, 0.88);
    assert.equal((priyaRow.pushParams as any).args.accountId, 'acc-priya');
    // "Find in Jira" fills the account; Approve then assigns.
    assert.equal((await resolveHeldAssignee(jordanRow._id, 'acc-j', 'Jordan Lee')).ok, true);
    assert.equal((await getWriteEntry(jordanRow._id))!.needs, null);
    assert.equal((await approveHeldWrite(jordanRow._id)).ok, true);
    assert.deepEqual(executed.find((p) => p.operation === 'assign' && p.args.issueKey === 'PILOT-40'), { operation: 'assign', args: { issueKey: 'PILOT-40', accountId: 'acc-j', assigneeName: 'Jordan Lee', personId: 'p-jordan' } });

    // b. Blocking link: both keys said -> suggested; weak blocker -> skipped.
    const link = byOp('link', 'PILOT-33');
    assert.deepEqual((link.pushParams as any).args, { blockedKey: 'PILOT-33', blockerKey: 'OPS-12' });
    assert.equal(rows.filter((r) => r.operation === 'link').length, 1, 'an unidentified blocker produces no suggestion');
    assert.ok(!rows.some((r) => r.operation === 'link' && r.targetRecordId === 'PILOT-50'), 'a link Jira already has is not suggested again');

    // c. Sprint: found -> "Add PILOT-41 to Sprint 14?"; not found -> held with the reason, never silent.
    const sprint = byOp('sprint', 'PILOT-41');
    assert.equal((sprint.pushParams as any).args.sprintName, 'Sprint 14');
    const noSprint = byOp('sprint', 'PILOT-40');
    assert.equal(noSprint.result, 'pending-approval');
    assert.equal(noSprint.blockedReason, "PILOT's board has no active or upcoming sprint");
    assert.equal((await approveHeldWrite(noSprint._id)).ok, false);
    assert.equal(executed.filter((p) => p.operation === 'sprint' && p.args.issueKey === 'PILOT-40').length, 0);

    // A click cannot push a blocked change either.
    const click = await submitJiraWrite({ initiator: 'user', confidence: 1, pushParams: { operation: 'assign', args: { issueKey: 'PILOT-1', accountId: null, assigneeName: 'Sam' } } });
    assert.equal(click.status, 'failed');

    // LLM-confirmed blocker counts as identified.
    semanticAnswer = { '1': 'OPS-12' };
    await meetings.insertAsync({ _id: 'm2', title: 'Pilot sync 2', date: new Date().toISOString(), attendees: [], source: 'desktop_recording' });
    await saveInsights('m2', { summary: '', decisions: [], blockers: [], actionItems: [], ticketIntents: [
      { kind: 'blocked_by', issueKey: 'PILOT-41', ticketHint: '', text: 'x', blockerKey: null, blockerHint: 'the certificate work', evidence: 'waiting on certs', certainty: 0.9 },
    ] } as any);
    await new Promise((r) => setImmediate(r));
    await waitForMeetingSync('m2');
    assert.ok((await listRecent()).some((r) => r.operation === 'link' && r.targetRecordId === 'PILOT-41' && (r.pushParams as any).args.blockerKey === 'OPS-12'));
    assert.ok((await listPending()).length >= 1);

    // Live-run fixes: "started" -> In Progress; "assign to me" -> the connected
    // account; an action item that only restates an intent gets no extra comment.
    await meetings.insertAsync({ _id: 'm3', title: 'Pilot sync 3', date: new Date().toISOString(), attendees: [], source: 'desktop_recording' });
    await saveInsights('m3', { summary: '', decisions: [], blockers: [],
      actionItems: [
        { text: 'Move PILOT-40 to In Progress', owner: 'Shravani Vatti', issueKey: 'PILOT-40', evidence: 'I started PILOT-40, move PILOT-40 to In Progress', certainty: 0.9 },
        { text: 'Pull PILOT-41 into this sprint', owner: 'Jordan', issueKey: 'PILOT-41', evidence: "Yes, let's pull PILOT-41 into this sprint. Also I started PILOT-40.", certainty: 0.9 },
        { text: 'Write the SSO runbook for PILOT-33', owner: 'Priya', issueKey: 'PILOT-33', evidence: 'Priya will write the runbook for PILOT-33', certainty: 0.9 },
      ],
      ticketIntents: [
        { kind: 'started', issueKey: 'PILOT-40', ticketHint: '', text: 'PILOT-40 is in progress', evidence: 'I started PILOT-40, move PILOT-40 to In Progress', certainty: 0.9 },
        { kind: 'sprint', issueKey: 'PILOT-41', ticketHint: '', text: 'this sprint', sprint: 'active', evidence: "Can we pull PILOT-41 in? Yes, let's pull PILOT-41 into this sprint.", certainty: 0.9 },
        { kind: 'reassign', issueKey: 'PILOT-41', ticketHint: '', text: 'Shravani takes PILOT-41', assigneeName: 'Shravani Vatti', evidence: 'assign PILOT-41 to Shravani Vatti', certainty: 0.9 },
      ] } as any);
    await new Promise((r) => setImmediate(r));
    await waitForMeetingSync('m3');
    const m3 = (await listRecent(200)).filter((r) => r.sourceMeetingId === 'm3');
    const started = m3.find((r) => r.operation === 'transition' && r.targetRecordId === 'PILOT-40')!;
    assert.equal((started.pushParams as any).args.targetStatus, 'in_progress');
    const selfAssign = m3.find((r) => r.operation === 'assign' && r.targetRecordId === 'PILOT-41')!;
    assert.equal((selfAssign.pushParams as any).args.accountId, 'acc-me');
    assert.equal(selfAssign.needs ?? null, null, 'no Find in Jira for yourself');
    assert.equal(m3.filter((r) => r.operation === 'comment' && r.targetRecordId === 'PILOT-40').length, 0, 'no comment restating the status change');
    assert.equal(m3.filter((r) => r.operation === 'comment' && r.targetRecordId === 'PILOT-41').length, 0, 'partly overlapping quote still counts as a restatement');
    assert.equal(m3.filter((r) => r.operation === 'comment' && r.targetRecordId === 'PILOT-33').length, 1, 'real action items still comment');
    onInsightsSaved(null);
  }

  console.log('jira-actions: all tests passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
