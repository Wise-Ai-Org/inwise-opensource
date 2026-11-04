import * as assert from 'node:assert/strict';
import { parseStatusChanges } from './jira-client';
import { statusChangesForIssues, __clearChangelogCacheForTests } from './jira-changelog';
import { buildPrepJira, changelogCandidates, lastStatusMoveSince } from './ollie-jira';
import { identitiesMatch } from './ollie-content';
import type { JiraIssueSnapshot } from './jira-pull';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-11-02T17:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const lastMet = now.getTime() - 10 * DAY;
const jordan = { accountId: 'acc-j', name: 'Jordan Lee', email: null };

function issue(key: string, over: Partial<JiraIssueSnapshot> = {}): JiraIssueSnapshot {
  return {
    _id: key, key, title: `Title ${key}`, url: null, projectKey: 'PILOT', status: 'QA', statusCategory: 'indeterminate',
    statusCategoryChangedAt: iso(now.getTime() - 30 * DAY), // category unchanged since long before the last meeting
    updatedAt: iso(now.getTime() - 2 * DAY), createdAt: null, dueDate: null, priority: null,
    assignee: jordan, reporter: null, blockedBy: [], sprint: null, comments: [], lastMyCommentAt: null,
    assignedToMe: false, reportedByMe: false, pulledAt: iso(now.getTime()), ...over,
  };
}

const changelog = (entries: { at: number; from: string; to: string; field?: string }[]) => ({
  values: entries.map((e) => ({ created: iso(e.at), items: [{ field: e.field || 'status', fromString: e.from, toString: e.to }] })),
});

async function run(): Promise<void> {
  // Parsing: only status items, oldest first, both payload shapes.
  {
    const c = parseStatusChanges(changelog([
      { at: now.getTime() - DAY, from: 'In Review', to: 'QA' },
      { at: now.getTime() - 5 * DAY, from: 'Med', to: 'High', field: 'priority' },
      { at: now.getTime() - 20 * DAY, from: 'In Progress', to: 'In Review' },
    ]));
    assert.deepEqual(c.map((x) => x.to), ['In Review', 'QA']);
    assert.equal(parseStatusChanges({ changelog: { histories: [{ created: iso(1), items: [{ field: 'status', fromString: 'A', toString: 'B' }] }] } }).length, 1);
    assert.deepEqual(parseStatusChanges(null), []);
    assert.equal(lastStatusMoveSince(c, lastMet, now.getTime())?.to, 'QA');
    assert.equal(lastStatusMoveSince(c, now.getTime(), now.getTime()), null);
  }

  // Within-category move (In Review to QA) shows only with the changelog.
  {
    const issues = [issue('PILOT-41')];
    const base = { issues, attendees: ['Jordan Lee'], lastMetMs: lastMet, now, identitiesMatch };
    assert.equal(buildPrepJira(base), null, 'the category heuristic alone misses it');
    const statusChanges = new Map([['PILOT-41', parseStatusChanges(changelog([{ at: now.getTime() - DAY, from: 'In Review', to: 'QA' }]))]]);
    const prep = buildPrepJira({ ...base, statusChanges })!;
    assert.equal(prep.rows[0].kind, 'moved');
    assert.equal(prep.rows[0].detail, 'Moved from In Review to QA since you last met');
    // A changelog with no move since the meeting: not moved, even if the category heuristic would say so.
    const quiet = new Map([['PILOT-41', parseStatusChanges(changelog([{ at: now.getTime() - 20 * DAY, from: 'To Do', to: 'QA' }]))]]);
    const notMoved = buildPrepJira({ ...base, issues: [issue('PILOT-41', { statusCategoryChangedAt: iso(now.getTime() - DAY) })], statusChanges: quiet });
    assert.equal(notMoved, null);
    // Failed fetch (null) falls back to the category heuristic.
    const fallback = buildPrepJira({ ...base, issues: [issue('PILOT-41', { statusCategoryChangedAt: iso(now.getTime() - DAY) })], statusChanges: new Map([['PILOT-41', null]]) })!;
    assert.equal(fallback.rows[0].detail, 'Moved to QA since you last met');
  }

  // Stored accountId wins over names: "Jordan" in the calendar, a different display name in Jira.
  {
    const renamed = issue('PILOT-50', { assignee: { accountId: 'acc-j', name: 'J. Lee (Contractor)', email: null }, statusCategoryChangedAt: iso(now.getTime() - DAY) });
    const without = buildPrepJira({ issues: [renamed], attendees: ['Jordan Lee'], lastMetMs: lastMet, now, identitiesMatch });
    assert.equal(without, null, 'name match fails');
    const withId = buildPrepJira({ issues: [renamed], attendees: ['Jordan Lee'], lastMetMs: lastMet, now, identitiesMatch, accountIdFor: () => 'acc-j' })!;
    assert.equal(withId.rows[0].key, 'PILOT-50');
  }

  // Bounded: only candidates are fetched, each once per updated timestamp.
  {
    __clearChangelogCacheForTests();
    const issues = [
      issue('PILOT-1'), issue('PILOT-2'), issue('PILOT-3'), issue('PILOT-4'), issue('PILOT-5'), issue('PILOT-6'),
      issue('PILOT-7', { updatedAt: iso(lastMet - DAY) }), // not updated since the meeting
      issue('PILOT-8', { blockedBy: [{ key: 'OPS-1', title: '', done: false }] }), // shown as blocked instead
      issue('PILOT-9', { assignee: { accountId: 'other', name: 'Zed', email: null } }), // not an attendee's
    ];
    const candidates = changelogCandidates({ issues, attendees: ['Jordan Lee'], lastMetMs: lastMet, identitiesMatch });
    assert.equal(candidates.length, 4, 'at most the 4 rows the card can show');
    assert.ok(!candidates.some((c) => ['PILOT-7', 'PILOT-8', 'PILOT-9'].includes(c.key)));
    assert.deepEqual(changelogCandidates({ issues, attendees: ['Jordan Lee'], lastMetMs: null, identitiesMatch }), [], 'no last meeting, no fetch');

    const fetched: string[] = [];
    const fetcher = async (key: string) => { fetched.push(key); if (key === 'PILOT-3') throw new Error('500'); return parseStatusChanges(changelog([{ at: now.getTime() - DAY, from: 'A', to: 'B' }])); };
    const first = await statusChangesForIssues(candidates, fetcher);
    assert.equal(fetched.length, 4);
    assert.equal(first.get('PILOT-3'), null, 'a failed call maps to null (heuristic fallback)');
    await statusChangesForIssues(candidates, fetcher);
    assert.equal(fetched.length, 5, 'cached results are reused; only the failed one is retried');
    const bumped = candidates.map((c, i) => (i === 0 ? { ...c, updatedAt: iso(now.getTime()) } : c));
    await statusChangesForIssues(bumped, fetcher);
    assert.equal(fetched.filter((k) => k === bumped[0].key).length, 2, 'a newer updated timestamp refetches');
  }

  console.log('jira-changelog: all tests passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
