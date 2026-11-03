/**
 * Jira pull (docs/JIRA_SAFETY.md, "Pull").
 *
 * Runs whenever Jira is connected (independent of the meeting push setting):
 * at launch and every 30 minutes while the app is open. Window: since the
 * last successful pull, at least 7 and at most 90 days. Follows nextPageToken.
 * Scope: issues assigned to me or reported by me, issues assigned to people I
 * met recently (bounded), and the default project if one is set.
 *
 * Every issue lands in a small local cache (jira-issues.db) that the Ollie
 * moments read. Only issues assigned to me (or already linked to a local task)
 * become local tasks.
 */
import * as path from 'path';
import { app } from 'electron';
import Datastore from '@seald-io/nedb';
import { adfToText, JIRA_TO_PRIORITY } from './jira-client';
import { localStatusForCategory } from './jira-transitions';

const DAY_MS = 24 * 60 * 60 * 1000;
export const PULL_INTERVAL_MS = 30 * 60 * 1000;
export const PULL_MIN_DAYS = 7;
export const PULL_MAX_DAYS = 90;
export const PULL_MAX_PAGES = 10;
export const PULL_MAX_ATTENDEES = 15;
const COMMENTS_KEPT = 5;

export interface JiraPerson { accountId: string; name: string; email: string | null }

export interface JiraIssueSnapshot {
  _id: string; // issue key
  key: string;
  title: string;
  url: string | null;
  projectKey: string;
  status: string;
  statusCategory: string | null;
  statusCategoryChangedAt: string | null;
  updatedAt: string;
  createdAt: string | null;
  dueDate: string | null;
  priority: string | null;
  assignee: JiraPerson | null;
  reporter: JiraPerson | null;
  /** Open issues this one "is blocked by". */
  blockedBy: { key: string; title: string; done: boolean }[];
  sprint: { name: string; state: string | null; endDate: string | null } | null;
  /** Last few comments, oldest first. */
  comments: { authorId: string | null; authorName: string; created: string; mentionsMe: boolean }[];
  /** My newest comment on this issue among those returned. */
  lastMyCommentAt: string | null;
  assignedToMe: boolean;
  reportedByMe: boolean;
  pulledAt: string;
}

// ── Pure helpers ───────────────────────────────────────────────────────────

export function computePullWindowDays(lastSuccessMs: number | null | undefined, nowMs: number): number {
  if (!lastSuccessMs || !Number.isFinite(lastSuccessMs) || lastSuccessMs > nowMs) return PULL_MAX_DAYS;
  const days = Math.ceil((nowMs - lastSuccessMs) / DAY_MS) + 1;
  return Math.max(PULL_MIN_DAYS, Math.min(PULL_MAX_DAYS, days));
}

const quote = (s: string) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function buildPullJql(input: { windowDays: number; attendeeAccountIds?: string[]; defaultProject?: string | null }): string {
  const scope = ['assignee = currentUser()', 'reporter = currentUser()'];
  const ids = Array.from(new Set((input.attendeeAccountIds || []).filter(Boolean))).slice(0, PULL_MAX_ATTENDEES);
  if (ids.length > 0) scope.push(`assignee in (${ids.map(quote).join(', ')})`);
  if (input.defaultProject && /^[A-Z][A-Z0-9_]+$/.test(input.defaultProject)) scope.push(`project = ${quote(input.defaultProject)}`);
  const days = Math.max(1, Math.round(input.windowDays));
  return `(${scope.join(' OR ')}) AND updated >= -${days}d ORDER BY updated DESC`;
}

export function pullFields(sprintFieldId: string | null): string[] {
  const fields = [
    'summary', 'status', 'priority', 'updated', 'created', 'project', 'description', 'duedate',
    'assignee', 'reporter', 'issuelinks', 'comment', 'statuscategorychangedate', 'issuetype',
  ];
  fields.push(sprintFieldId || 'customfield_10020');
  return fields;
}

function person(raw: any): JiraPerson | null {
  if (!raw || !raw.accountId) return null;
  return { accountId: raw.accountId, name: raw.displayName || '', email: raw.emailAddress || null };
}

/** True when an ADF body contains a mention node for this account. */
export function adfMentions(adf: any, accountId: string | null): boolean {
  if (!adf || !accountId) return false;
  const stack = [adf];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'mention' && node.attrs?.id === accountId) return true;
    if (Array.isArray(node.content)) stack.push(...node.content);
  }
  return false;
}

function pickSprint(raw: any): JiraIssueSnapshot['sprint'] {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  if (list.length === 0) return null;
  const active = list.find((s: any) => s?.state === 'active') || list[list.length - 1];
  if (!active || !active.name) return null;
  return { name: active.name, state: active.state || null, endDate: active.endDate || null };
}

export function mapIssueSnapshot(
  raw: any,
  opts: { cloudUrl: string | null; myAccountId: string | null; sprintFieldId: string | null; now?: Date },
): JiraIssueSnapshot {
  const f = raw?.fields || {};
  const key = raw?.key || '';
  const blockedBy = (Array.isArray(f.issuelinks) ? f.issuelinks : [])
    .filter((l: any) => l?.inwardIssue && /blocked by/i.test(l?.type?.inward || ''))
    .map((l: any) => ({
      key: l.inwardIssue.key,
      title: l.inwardIssue.fields?.summary || '',
      done: l.inwardIssue.fields?.status?.statusCategory?.key === 'done',
    }))
    .filter((b: any) => !b.done);
  const allComments = Array.isArray(f.comment?.comments) ? f.comment.comments : [];
  const me = opts.myAccountId;
  let lastMyCommentAt: string | null = null;
  for (const c of allComments) {
    if (me && c?.author?.accountId === me && (!lastMyCommentAt || c.created > lastMyCommentAt)) lastMyCommentAt = c.created;
  }
  const comments = allComments.slice(-COMMENTS_KEPT).map((c: any) => ({
    authorId: c?.author?.accountId || null,
    authorName: c?.author?.displayName || '',
    created: c?.created || '',
    mentionsMe: adfMentions(c?.body, me),
  }));
  const assignee = person(f.assignee);
  const reporter = person(f.reporter);
  return {
    _id: key,
    key,
    title: f.summary || '',
    url: opts.cloudUrl ? `${opts.cloudUrl}/browse/${key}` : null,
    projectKey: f.project?.key || key.split('-')[0] || '',
    status: f.status?.name || '',
    statusCategory: f.status?.statusCategory?.key || null,
    statusCategoryChangedAt: f.statuscategorychangedate || null,
    updatedAt: f.updated || '',
    createdAt: f.created || null,
    dueDate: f.duedate || null,
    priority: f.priority?.name || null,
    assignee,
    reporter,
    blockedBy,
    sprint: pickSprint(f[opts.sprintFieldId || 'customfield_10020']),
    comments,
    lastMyCommentAt,
    assignedToMe: !!me && assignee?.accountId === me,
    reportedByMe: !!me && reporter?.accountId === me,
    pulledAt: (opts.now || new Date()).toISOString(),
  };
}

/** Local task fields for a pulled issue. */
export function localTaskFieldsFor(snap: JiraIssueSnapshot, description: string) {
  return {
    key: snap.key,
    url: snap.url,
    title: snap.title,
    description,
    priority: snap.priority ? (JIRA_TO_PRIORITY[snap.priority] || 'medium') : 'medium',
    status: localStatusForCategory(snap.statusCategory),
    dueDate: snap.dueDate,
    updatedAt: snap.updatedAt,
  };
}

/** Follow nextPageToken until the last page or maxPages. */
export async function fetchAllPages(
  fetchPage: (token: string | null) => Promise<{ issues: any[]; nextPageToken: string | null }>,
  maxPages = PULL_MAX_PAGES,
): Promise<{ issues: any[]; complete: boolean }> {
  const issues: any[] = [];
  let token: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchPage(token);
    issues.push(...(res.issues || []));
    if (!res.nextPageToken) return { issues, complete: true };
    token = res.nextPageToken;
  }
  return { issues, complete: false };
}

export { adfToText };

// ── Cache store ────────────────────────────────────────────────────────────

let cacheDb: Datastore<JiraIssueSnapshot> | null = null;

export function initJiraCache(): void {
  cacheDb = new Datastore<JiraIssueSnapshot>({ filename: path.join(app.getPath('userData'), 'jira-issues.db'), autoload: true });
}

export function __setJiraCacheDbForTests(db: Datastore<any> | null): void {
  cacheDb = db as Datastore<JiraIssueSnapshot> | null;
}

export async function saveIssueSnapshots(snaps: JiraIssueSnapshot[]): Promise<void> {
  if (!cacheDb) return;
  for (const s of snaps) {
    if (!s.key) continue;
    await cacheDb.updateAsync({ _id: s.key }, s, { upsert: true });
  }
}

export async function listCachedIssues(): Promise<JiraIssueSnapshot[]> {
  if (!cacheDb) return [];
  return (await cacheDb.findAsync({})) as JiraIssueSnapshot[];
}

/** Drop issues not seen for 120 days so the cache stays small. */
export async function pruneIssueCache(now = new Date()): Promise<number> {
  if (!cacheDb) return 0;
  const cutoff = new Date(now.getTime() - 120 * DAY_MS).toISOString();
  return cacheDb.removeAsync({ pulledAt: { $lt: cutoff } }, { multi: true });
}

/** Drop cached issues (personal data reporting: closed or updated accounts). */
export async function removeCachedIssues(keys: string[]): Promise<void> {
  if (!cacheDb || keys.length === 0) return;
  await cacheDb.removeAsync({ _id: { $in: keys } }, { multi: true });
}
