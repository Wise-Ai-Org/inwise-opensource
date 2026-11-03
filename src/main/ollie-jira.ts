/**
 * Pure Jira sections for the Ollie moments (docs/OLLIE_MOMENTS.md, "Jira").
 * Inputs are the pulled issue cache (jira-pull.ts) and the write log; every
 * section is empty or null when there is nothing real to show.
 */
import type { JiraIssueSnapshot } from './jira-pull';
import type { JiraTicketRow, MorningJira, PrepJira, WrapJira } from './ollie-moments-types';
import { startOfLocalDay, toMs } from './ollie-moments';
import { spokenIssueKeys } from './jira-confidence';

const DAY_MS = 24 * 60 * 60 * 1000;
export const JIRA_STALE_DAYS = 7;
export const PREP_JIRA_MAX = 4;
const MORNING_SECTION_MAX = 3;
const WRAP_SECTION_MAX = 4;

type IdentityMatch = (a: string, b: string) => boolean;

const isOpen = (i: JiraIssueSnapshot) => i.statusCategory !== 'done';
const daysBetween = (fromMs: number, toMsValue: number) => Math.max(0, Math.floor((toMsValue - fromMs) / DAY_MS));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function row(i: JiraIssueSnapshot, kind: JiraTicketRow['kind'], detail: string, owner: string | null = null): JiraTicketRow {
  return { key: i.key, title: i.title, url: i.url, detail, kind, owner };
}

/** Local calendar day of a Jira date ('YYYY-MM-DD') or timestamp. */
function dayStartMs(value: string | null): number | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y, m - 1, d).getTime();
  }
  const ms = toMs(value);
  return ms === null ? null : startOfLocalDay(new Date(ms)).getTime();
}

function personMatches(p: { name: string; email: string | null } | null, attendee: string, match: IdentityMatch): boolean {
  if (!p) return false;
  const id = p.email ? `${p.name} <${p.email}>` : p.name;
  return !!id && match(id, attendee);
}

// ── Before a meeting ──────────────────────────────────────────────────────

export function buildPrepJira(input: {
  issues: JiraIssueSnapshot[] | null;
  attendees: string[];
  lastMetMs: number | null;
  now: Date;
  identitiesMatch: IdentityMatch;
}): PrepJira | null {
  if (!input.issues || input.issues.length === 0 || input.attendees.length === 0) return null;
  const now = input.now.getTime();
  const owned = (i: JiraIssueSnapshot) => input.attendees.find((a) => personMatches(i.assignee, a, input.identitiesMatch)) || null;
  const blocked: JiraTicketRow[] = [];
  const yours: JiraTicketRow[] = [];
  const moved: JiraTicketRow[] = [];
  const stale: JiraTicketRow[] = [];

  for (const i of input.issues) {
    const attendee = owned(i);
    if (attendee && !i.assignedToMe) {
      const owner = i.assignee?.name || null;
      const statusBlocked = /block/i.test(i.status || '');
      if (isOpen(i) && (statusBlocked || i.blockedBy.length > 0)) {
        const since = statusBlocked ? toMs(i.statusCategoryChangedAt) : null;
        const by = i.blockedBy[0] ? ` by ${i.blockedBy[0].key}` : '';
        const detail = since !== null ? `Blocked ${plural(daysBetween(since, now), 'day')}${by}` : `Blocked${by}`;
        blocked.push(row(i, 'blocked', detail, owner));
        continue;
      }
      const changed = toMs(i.statusCategoryChangedAt);
      if (input.lastMetMs !== null && changed !== null && changed > input.lastMetMs && changed <= now) {
        moved.push(row(i, 'moved', `Moved to ${i.status} since you last met`, owner));
        continue;
      }
      const updated = toMs(i.updatedAt);
      if (isOpen(i) && updated !== null && now - updated >= JIRA_STALE_DAYS * DAY_MS) {
        stale.push(row(i, 'stale', `No update for ${plural(daysBetween(updated, now), 'day')}`, owner));
      }
      continue;
    }
    // Your open tickets that involve them: they reported it or commented on it.
    if (i.assignedToMe && isOpen(i)) {
      const who = input.attendees.find((a) =>
        personMatches(i.reporter, a, input.identitiesMatch)
        || i.comments.some((c) => c.authorName && input.identitiesMatch(c.authorName, a)));
      if (who) yours.push(row(i, 'yours', `Yours · ${i.status}`, null));
    }
  }
  const rows = [...blocked, ...yours, ...moved, ...stale].slice(0, PREP_JIRA_MAX);
  return rows.length > 0 ? { rows } : null;
}

// ── Day begins ────────────────────────────────────────────────────────────

/** A mention of me newer than my last comment on that issue. */
export function unansweredMention(i: JiraIssueSnapshot): { by: string; at: string } | null {
  const last = i.lastMyCommentAt ? toMs(i.lastMyCommentAt) : null;
  for (let k = i.comments.length - 1; k >= 0; k--) {
    const c = i.comments[k];
    if (!c.mentionsMe) continue;
    const at = toMs(c.created);
    if (at === null) continue;
    if (last === null || at > last) return { by: c.authorName || 'Someone', at: c.created };
  }
  return null;
}

export function buildMorningJira(input: { issues: JiraIssueSnapshot[] | null; now: Date }): MorningJira | null {
  if (!input.issues || input.issues.length === 0) return null;
  const today = startOfLocalDay(input.now).getTime();
  const now = input.now.getTime();
  const mine = input.issues.filter((i) => i.assignedToMe && isOpen(i));

  const dueToday: JiraTicketRow[] = [];
  const overdue: JiraTicketRow[] = [];
  for (const i of mine) {
    const due = dayStartMs(i.dueDate);
    if (due === null) continue;
    if (due === today) dueToday.push(row(i, 'due_today', `Due today · ${i.status}`));
    else if (due < today) {
      const days = daysBetween(due, today);
      overdue.push(row(i, 'overdue', `${plural(days, 'day')} overdue · ${i.status}`));
    }
  }
  overdue.sort((a, b) => parseInt(b.detail, 10) - parseInt(a.detail, 10));

  let sprintEnding: MorningJira['sprintEnding'] = null;
  const bySprint = new Map<string, JiraIssueSnapshot[]>();
  for (const i of mine) {
    const s = i.sprint;
    if (!s || s.state !== 'active' || !s.endDate) continue;
    const end = toMs(s.endDate);
    if (end === null || end < now || end - now > DAY_MS) continue;
    bySprint.set(s.name, [...(bySprint.get(s.name) || []), i]);
  }
  const ending = Array.from(bySprint.entries()).sort((a, b) => b[1].length - a[1].length)[0];
  if (ending) {
    const [name, issues] = ending;
    sprintEnding = {
      name,
      endsAt: issues[0].sprint!.endDate!,
      openCount: issues.length,
      rows: issues.slice(0, MORNING_SECTION_MAX).map((i) => row(i, 'sprint', i.status)),
    };
  }

  const mentions: JiraTicketRow[] = [];
  for (const i of input.issues) {
    const m = unansweredMention(i);
    if (m) mentions.push(row(i, 'mention', `${m.by} mentioned you`));
  }

  const out: MorningJira = {
    dueToday: dueToday.slice(0, MORNING_SECTION_MAX),
    overdue: overdue.slice(0, MORNING_SECTION_MAX),
    sprintEnding,
    mentions: mentions.slice(0, MORNING_SECTION_MAX),
  };
  const empty = !out.dueToday.length && !out.overdue.length && !out.sprintEnding && !out.mentions.length;
  return empty ? null : out;
}

// ── End of day ────────────────────────────────────────────────────────────

export interface WriteLike {
  _id: string;
  operation: string;
  result: string;
  targetRecordId: string;
  targetRecordUrl: string | null;
  sourceMeetingId: string | null;
  createdAt: string;
  completedAt?: string | null;
  fieldDiffs?: { field: string; after: any }[];
  issueTitle?: string | null;
  pushParams?: any;
}

export function describeWrite(w: WriteLike): string {
  const key = w.targetRecordId;
  const p = w.pushParams?.args || {};
  if (w.operation === 'create') return `Created ${key}${p.title ? `: ${p.title}` : ''}`;
  if (w.operation === 'transition') {
    const after = w.fieldDiffs?.find((d) => d.field === 'status')?.after;
    return `Moved ${key}${after ? ` to ${after}` : ''}`;
  }
  if (w.operation === 'update') {
    const fields = Object.keys(p.updates || {});
    if (fields.length === 1 && fields[0] === 'dueDate') return `Moved the due date on ${key} to ${p.updates.dueDate}`;
    return `Updated ${key}`;
  }
  return `Commented on ${key}`;
}

/** Keys mentioned in a meeting's stored insights (items, intents, decisions). */
export function keysDiscussedIn(meeting: any): string[] {
  const out = new Set<string>();
  const ins = meeting?.insights || {};
  for (const it of ins.actionItems || []) {
    if (it?.issueKey) out.add(it.issueKey);
    for (const k of spokenIssueKeys(`${it?.text || ''} ${it?.evidence || ''}`)) out.add(k);
  }
  for (const t of ins.ticketIntents || []) {
    if (t?.issueKey) out.add(t.issueKey);
    for (const k of spokenIssueKeys(`${t?.text || ''} ${t?.evidence || ''}`)) out.add(k);
  }
  for (const d of ins.decisions || []) for (const k of spokenIssueKeys(typeof d === 'string' ? d : d?.text || '')) out.add(k);
  return Array.from(out);
}

export function buildWrapJira(input: {
  connected: boolean;
  writesToday: WriteLike[];
  pendingCount: number;
  issues: JiraIssueSnapshot[] | null;
  /** Today's meetings (insights read for discussed keys). */
  meetingsToday: any[];
  /** Jira keys of local tasks touched by today's meetings. */
  linkedKeysToday: string[];
  now: Date;
}): WrapJira | null {
  if (!input.connected) return null;
  const now = input.now.getTime();
  const changedToday = input.writesToday
    .filter((w) => w.result === 'success' && !!w.sourceMeetingId && w.targetRecordId && w.targetRecordId !== '(pending-create)')
    .map((w) => ({ id: w._id, issueKey: w.targetRecordId, url: w.targetRecordUrl, operation: w.operation, summary: describeWrite(w) }))
    .slice(0, WRAP_SECTION_MAX);

  const discussed = new Set<string>(input.linkedKeysToday);
  for (const m of input.meetingsToday) for (const k of keysDiscussedIn(m)) discussed.add(k);
  for (const w of input.writesToday) if (w.sourceMeetingId && w.targetRecordId !== '(pending-create)') discussed.add(w.targetRecordId);
  const byKey = new Map((input.issues || []).map((i) => [i.key, i]));
  const staleDiscussed: JiraTicketRow[] = [];
  for (const key of discussed) {
    const i = byKey.get(key);
    if (!i || !isOpen(i)) continue;
    const updated = toMs(i.updatedAt);
    if (updated === null || now - updated < JIRA_STALE_DAYS * DAY_MS) continue;
    staleDiscussed.push(row(i, 'stale', `Discussed today, no Jira update for ${plural(daysBetween(updated, now), 'day')}`, i.assignee?.name || null));
  }

  const out: WrapJira = { changedToday, waitingCount: Math.max(0, input.pendingCount), staleDiscussed: staleDiscussed.slice(0, WRAP_SECTION_MAX) };
  return !out.changedToday.length && !out.waitingCount && !out.staleDiscussed.length ? null : out;
}
