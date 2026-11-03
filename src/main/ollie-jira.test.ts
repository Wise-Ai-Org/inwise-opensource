import * as assert from 'node:assert/strict';
import { buildMorningJira, buildPrepJira, buildWrapJira, describeWrite, keysDiscussedIn, unansweredMention } from './ollie-jira';
import { identitiesMatch, summarizePendingApproval } from './ollie-content';
import type { JiraIssueSnapshot } from './jira-pull';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date(2026, 10, 2, 9, 0, 0); // Nov 2, 09:00 local
const iso = (ms: number) => new Date(ms).toISOString();
const ymd = (offsetDays: number) => {
  const d = new Date(now.getTime() + offsetDays * DAY);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function issue(key: string, over: Partial<JiraIssueSnapshot> = {}): JiraIssueSnapshot {
  return {
    _id: key, key, title: `Title ${key}`, url: `https://x/browse/${key}`, projectKey: 'PILOT',
    status: 'In Progress', statusCategory: 'indeterminate', statusCategoryChangedAt: iso(now.getTime() - 20 * DAY),
    updatedAt: iso(now.getTime() - DAY), createdAt: null, dueDate: null, priority: null,
    assignee: { accountId: 'me', name: 'Shravani Vatti', email: 'me@x.com' }, reporter: null,
    blockedBy: [], sprint: null, comments: [], lastMyCommentAt: null,
    assignedToMe: true, reportedByMe: false, pulledAt: iso(now.getTime()),
    ...over,
  };
}
const priya = { accountId: 'p', name: 'Priya Shah', email: 'priya@x.com' };

function run(): void {
  // ── Prep: their Jira ──────────────────────────────────────────────────
  {
    const lastMet = now.getTime() - 10 * DAY;
    const issues = [
      issue('PILOT-1', { assignee: priya, assignedToMe: false, status: 'Blocked', statusCategoryChangedAt: iso(now.getTime() - 4 * DAY) }),
      issue('PILOT-2', { assignee: priya, assignedToMe: false, blockedBy: [{ key: 'OPS-1', title: 'Vendor', done: false }] }),
      issue('PILOT-3', { assignee: priya, assignedToMe: false, status: 'In Review', statusCategoryChangedAt: iso(now.getTime() - 2 * DAY) }),
      issue('PILOT-4', { assignee: priya, assignedToMe: false, updatedAt: iso(now.getTime() - 9 * DAY) }),
      issue('PILOT-5', { reporter: priya }),
      issue('PILOT-6', { assignee: { accountId: 'z', name: 'Zed', email: null }, assignedToMe: false, status: 'Blocked' }),
      issue('PILOT-7', { assignee: priya, assignedToMe: false, statusCategory: 'done', status: 'Done', statusCategoryChangedAt: iso(now.getTime() - 40 * DAY), updatedAt: iso(now.getTime() - 30 * DAY) }),
    ];
    const prep = buildPrepJira({ issues, attendees: ['Priya Shah <priya@x.com>'], lastMetMs: lastMet, now, identitiesMatch })!;
    assert.deepEqual(prep.rows.map((r) => [r.key, r.kind]), [
      ['PILOT-1', 'blocked'], ['PILOT-2', 'blocked'], ['PILOT-5', 'yours'], ['PILOT-3', 'moved'],
    ], 'blocked first, then yours, moved, stale; capped at 4; non-attendees and done work left out');
    assert.equal(prep.rows[0].detail, 'Blocked 4 days');
    assert.equal(prep.rows[1].detail, 'Blocked by OPS-1');
    assert.equal(prep.rows[0].owner, 'Priya Shah');
    assert.equal(prep.rows[0].url, 'https://x/browse/PILOT-1');
    const onlyStale = buildPrepJira({ issues: [issues[3]], attendees: ['Priya Shah'], lastMetMs: null, now, identitiesMatch })!;
    assert.equal(onlyStale.rows[0].detail, 'No update for 9 days');
    assert.equal(buildPrepJira({ issues: null, attendees: ['Priya'], lastMetMs: null, now, identitiesMatch }), null);
    assert.equal(buildPrepJira({ issues, attendees: [], lastMetMs: null, now, identitiesMatch }), null);
  }

  // ── Morning: your Jira ────────────────────────────────────────────────
  {
    const issues = [
      issue('PILOT-10', { dueDate: ymd(0) }),
      issue('PILOT-11', { dueDate: ymd(-3) }),
      issue('PILOT-12', { dueDate: ymd(-1) }),
      issue('PILOT-13', { dueDate: ymd(-5), statusCategory: 'done' }),
      issue('PILOT-14', { sprint: { name: 'Sprint 12', state: 'active', endDate: iso(now.getTime() + 8 * 3600_000) } }),
      issue('PILOT-15', { sprint: { name: 'Sprint 12', state: 'active', endDate: iso(now.getTime() + 8 * 3600_000) } }),
      issue('PILOT-16', { sprint: { name: 'Sprint 13', state: 'active', endDate: iso(now.getTime() + 5 * DAY) } }),
      issue('PILOT-17', {
        assignedToMe: false,
        comments: [
          { authorId: 'p', authorName: 'Priya Shah', created: iso(now.getTime() - 3 * DAY), mentionsMe: true },
          { authorId: 'me', authorName: 'Me', created: iso(now.getTime() - 2 * DAY), mentionsMe: false },
        ],
        lastMyCommentAt: iso(now.getTime() - 2 * DAY),
      }),
      issue('PILOT-18', {
        comments: [{ authorId: 'p', authorName: 'Priya Shah', created: iso(now.getTime() - 3600_000), mentionsMe: true }],
        lastMyCommentAt: iso(now.getTime() - 2 * DAY),
      }),
    ];
    const m = buildMorningJira({ issues, now })!;
    assert.deepEqual(m.dueToday.map((r) => r.key), ['PILOT-10']);
    assert.deepEqual(m.overdue.map((r) => r.key), ['PILOT-11', 'PILOT-12'], 'most overdue first; done tickets left out');
    assert.equal(m.overdue[0].detail, '3 days overdue · In Progress');
    assert.equal(m.sprintEnding?.name, 'Sprint 12');
    assert.equal(m.sprintEnding?.openCount, 2);
    assert.deepEqual(m.mentions.map((r) => r.key), ['PILOT-18'], 'a mention you already answered is not shown');
    assert.equal(m.mentions[0].detail, 'Priya Shah mentioned you');
    assert.equal(buildMorningJira({ issues: [issue('X-1')], now }), null, 'nothing to say -> null');
    assert.equal(buildMorningJira({ issues: null, now }), null);
    assert.equal(unansweredMention(issue('X-2', { comments: [{ authorId: 'p', authorName: 'P', created: iso(now.getTime()), mentionsMe: true }] }))?.by, 'P');
  }

  // ── Wrap: Jira today ──────────────────────────────────────────────────
  {
    const writes = [
      { _id: 'w1', operation: 'transition', result: 'success', targetRecordId: 'PILOT-42', targetRecordUrl: 'u42', sourceMeetingId: 'm1', createdAt: iso(now.getTime()), fieldDiffs: [{ field: 'status', after: 'Done' }] },
      { _id: 'w2', operation: 'create', result: 'success', targetRecordId: 'PILOT-50', targetRecordUrl: 'u50', sourceMeetingId: 'm1', createdAt: iso(now.getTime()), pushParams: { args: { title: 'Draft copy' } } },
      { _id: 'w3', operation: 'comment', result: 'success', targetRecordId: 'PILOT-9', targetRecordUrl: null, sourceMeetingId: null, createdAt: iso(now.getTime()) },
      { _id: 'w4', operation: 'create', result: 'pending-approval', targetRecordId: '(pending-create)', targetRecordUrl: null, sourceMeetingId: 'm1', createdAt: iso(now.getTime()) },
      { _id: 'w5', operation: 'update', result: 'success', targetRecordId: 'PILOT-7', targetRecordUrl: null, sourceMeetingId: 'm1', createdAt: iso(now.getTime()), pushParams: { args: { updates: { dueDate: '2026-11-04' } } } },
    ];
    const meetingsToday = [{ _id: 'm1', insights: { actionItems: [{ text: 'Follow up on PILOT-30', issueKey: null }], ticketIntents: [{ issueKey: 'PILOT-31', text: 'x' }], decisions: [] } }];
    const issues = [
      issue('PILOT-30', { updatedAt: iso(now.getTime() - 12 * DAY), assignee: priya, assignedToMe: false }),
      issue('PILOT-31', { updatedAt: iso(now.getTime() - 2 * DAY) }),
      issue('PILOT-32', { updatedAt: iso(now.getTime() - 20 * DAY) }),
    ];
    const w = buildWrapJira({ connected: true, writesToday: writes, pendingCount: 2, issues, meetingsToday, linkedKeysToday: ['PILOT-32'], now })!;
    assert.deepEqual(w.changedToday.map((c) => c.summary), ['Moved PILOT-42 to Done', 'Created PILOT-50: Draft copy', 'Moved the due date on PILOT-7 to 2026-11-04'], 'only meeting writes that landed');
    assert.equal(w.waitingCount, 2);
    assert.deepEqual(w.staleDiscussed.map((r) => r.key).sort(), ['PILOT-30', 'PILOT-32']);
    assert.match(w.staleDiscussed.find((r) => r.key === 'PILOT-30')!.detail, /no Jira update for 12 days/);
    assert.equal(buildWrapJira({ connected: false, writesToday: writes, pendingCount: 2, issues, meetingsToday, linkedKeysToday: [], now }), null);
    assert.equal(buildWrapJira({ connected: true, writesToday: [], pendingCount: 0, issues: [], meetingsToday: [], linkedKeysToday: [], now }), null);
    assert.deepEqual(keysDiscussedIn(meetingsToday[0]).sort(), ['PILOT-30', 'PILOT-31']);
    assert.equal(describeWrite({ _id: 'c', operation: 'comment', result: 'success', targetRecordId: 'A-1', targetRecordUrl: null, sourceMeetingId: 'm', createdAt: '' }), 'Commented on A-1');
  }

  // ── Recap rows read as questions with the target ticket ───────────────
  {
    const pending = summarizePendingApproval(
      { _id: 'p1', pushParams: { operation: 'transition', args: { issueKey: 'PILOT-42', targetStatus: 'done' } }, meetingTitle: 'Sync', createdAt: '' },
      'm1',
      { issueTitle: 'Send survey', evidence: 'the survey is done', suggestion: null, intent: 'done', confidence: 0.82, targetRecordUrl: 'u' },
    );
    assert.equal(pending.summary, 'Move PILOT-42 to Done?');
    assert.equal(pending.issueTitle, 'Send survey');
    assert.equal(pending.evidence, 'the survey is done');
    assert.equal(pending.url, 'u');
    const due = summarizePendingApproval({ _id: 'p2', pushParams: { operation: 'update', args: { issueKey: 'PILOT-7', updates: { dueDate: '2026-11-04' } } }, createdAt: '' }, null);
    assert.equal(due.summary, 'Move the due date on PILOT-7 to 2026-11-04?');
    const sug = summarizePendingApproval({ _id: 'p3', pushParams: { operation: 'comment', args: { issueKey: 'PILOT-42', comment: 'x' } }, createdAt: '' }, null, { suggestion: 'Update PILOT-42 instead?' });
    assert.equal(sug.summary, 'Update PILOT-42 instead?');
    const decision = summarizePendingApproval({ _id: 'p4', pushParams: { operation: 'comment', args: { issueKey: 'PILOT-42', comment: 'Decision: x' } }, createdAt: '' }, null, { intent: 'decision' });
    assert.equal(decision.summary, 'Add the decision to PILOT-42 as a comment?');
  }

  console.log('ollie-jira: all tests passed');
}

run();
