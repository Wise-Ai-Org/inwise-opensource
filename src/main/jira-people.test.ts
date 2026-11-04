import * as assert from 'node:assert/strict';
import { resolvePersonAccountId, storedAccountId, needsJiraLink, UNRESOLVED_RECHECK_MS } from './jira-people';
import { formatJiraDate, friendlyDatesIn, describeJiraChange } from './jira-format';

const now = new Date('2026-11-02T17:00:00Z');

async function run(): Promise<void> {
  const calls: string[] = [];
  const lookup = async (email: string) => { calls.push(email); return email === 'jordan@x.com' ? 'acc-jordan-email' : null; };

  // 1. Stored id wins, no lookup.
  {
    calls.length = 0;
    const r = await resolvePersonAccountId({ _id: 'p', email: 'jordan@x.com', jiraLink: { status: 'linked', accountId: 'acc-picked', displayName: 'Jordan', checkedAt: '' } }, lookup, now);
    assert.deepEqual([r.accountId, r.source, r.update], ['acc-picked', 'stored', null]);
    assert.equal(calls.length, 0);
    // A cached email match also counts as stored.
    const c = await resolvePersonAccountId({ _id: 'p', jiraLink: { status: 'email', accountId: 'acc-cached', displayName: null, checkedAt: '' } }, lookup, now);
    assert.equal(c.accountId, 'acc-cached');
    assert.equal(calls.length, 0);
  }

  // 2. Email lookup next, cached on the person.
  {
    calls.length = 0;
    const r = await resolvePersonAccountId({ _id: 'p', name: 'Jordan Lee', email: 'Jordan@X.com' }, lookup, now);
    assert.equal(r.source, 'email');
    assert.equal(r.accountId, 'acc-jordan-email');
    assert.equal(r.update?.status, 'email');
    assert.deepEqual(calls, ['jordan@x.com']);
    // Alternate emails are tried too.
    const alt = await resolvePersonAccountId({ _id: 'p', email: 'j@old.com', altEmails: ['jordan@x.com'] }, lookup, now);
    assert.equal(alt.accountId, 'acc-jordan-email');
  }

  // 3. Unresolved: recorded, and not re-checked for a week.
  {
    calls.length = 0;
    const r = await resolvePersonAccountId({ _id: 'p', email: 'hidden@x.com' }, lookup, now);
    assert.equal(r.source, 'unresolved');
    assert.equal(r.accountId, null);
    assert.equal(r.update?.status, 'unresolved');
    const noEmail = await resolvePersonAccountId({ _id: 'p', name: 'Sam' }, lookup, now);
    assert.equal(noEmail.update?.status, 'unresolved');
    calls.length = 0;
    const recent = await resolvePersonAccountId({ _id: 'p', email: 'hidden@x.com', jiraLink: { status: 'unresolved', accountId: null, displayName: null, checkedAt: new Date(now.getTime() - 3600_000).toISOString() } }, lookup, now);
    assert.equal(recent.update, null);
    assert.equal(calls.length, 0, 'no repeat lookup within a week');
    const old = await resolvePersonAccountId({ _id: 'p', email: 'jordan@x.com', jiraLink: { status: 'unresolved', accountId: null, displayName: null, checkedAt: new Date(now.getTime() - UNRESOLVED_RECHECK_MS - 1).toISOString() } }, lookup, now);
    assert.equal(old.source, 'email', 'retried after a week');
    // Lookup errors count as not found.
    const failing = await resolvePersonAccountId({ _id: 'p', email: 'x@x.com' }, async () => { throw new Error('403'); }, now);
    assert.equal(failing.source, 'unresolved');
  }

  // Unlinked by the user: never silently re-matched by email.
  {
    calls.length = 0;
    const r = await resolvePersonAccountId({ _id: 'p', email: 'jordan@x.com', jiraLink: { status: 'unlinked', accountId: null, displayName: null, checkedAt: '' } }, lookup, now);
    assert.equal(r.source, 'unresolved');
    assert.equal(calls.length, 0);
    assert.equal(needsJiraLink({ jiraLink: { status: 'unlinked' } }), true);
    assert.equal(needsJiraLink({ jiraLink: { status: 'linked' } }), false);
    assert.equal(storedAccountId({ jiraLink: { status: 'unresolved', accountId: 'x' } }), null);
  }

  // ── Date format ───────────────────────────────────────────────────────
  assert.equal(formatJiraDate('2026-11-04'), 'Wed, Nov 4');
  assert.equal(formatJiraDate('2026-12-25'), 'Fri, Dec 25');
  assert.equal(formatJiraDate(''), '');
  assert.equal(formatJiraDate('soon'), 'soon');
  assert.equal(friendlyDatesIn('Due 2026-11-04, not 2026-11-05.'), 'Due Wed, Nov 4, not Thu, Nov 5.');
  assert.equal(describeJiraChange({ operation: 'update', args: { issueKey: 'P-1', updates: { dueDate: '2026-11-04' } } }), 'Move the due date on P-1 to Wed, Nov 4?');
  assert.equal(describeJiraChange({ operation: 'assign', args: { issueKey: 'PILOT-40', assigneeName: 'Jordan Lee', accountId: null } }), 'Assign PILOT-40 to Jordan Lee?');
  assert.equal(describeJiraChange({ operation: 'link', args: { blockedKey: 'PILOT-33', blockerKey: 'OPS-12' } }), 'Mark PILOT-33 as blocked by OPS-12?');
  assert.equal(describeJiraChange({ operation: 'sprint', args: { issueKey: 'PILOT-41', sprintId: 14, sprintName: 'Sprint 14' } }), 'Add PILOT-41 to Sprint 14?');
  assert.equal(describeJiraChange({ operation: 'sprint', args: { issueKey: 'PILOT-41', sprintId: null, sprintName: null } }), 'Add PILOT-41 to a sprint?');

  console.log('jira-people: all tests passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
