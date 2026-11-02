/**
 * Pure content builders for the Ollie card (docs/OLLIE_MOMENTS.md): morning,
 * prep, processed and wrap-up. Every input is real stored data handed in by
 * ollie-moments-service.ts; a section with nothing to show comes back empty
 * (or null) so the renderer can omit it. No Electron, no persistence.
 */
import { buildDailyBriefing } from './daily-briefing';
import { fuzzyNameScore } from './fuzzy-name';
import { localDayKey, startOfLocalDay, toMs } from './ollie-moments';
import type {
  AttendeeOwes,
  CatchUpNote,
  CatchUpPerson,
  MorningContent,
  OwedItem,
  PendingJiraApproval,
  PrepContent,
  PriorityItem,
  ProcessedContent,
  TaskRef,
  TomorrowContent,
  WelcomeBackContent,
  WrapUpContent,
} from './ollie-moments-types';

const DAY_MS = 24 * 60 * 60 * 1000;
export const CATCH_UP_MIN_DAYS = 21;
export const CATCH_UP_MAX = 2;
export const GONE_QUIET_MIN_SCORE = 60;
export const GONE_QUIET_DAYS = 7;
export const GONE_QUIET_MAX = 3;
export const CRUNCH_MIN_GAP_MS = 30 * 60_000;
const OWED_MAX = 3;

export interface ScoredLike {
  _id: string;
  score: number;
  reasoning: string;
  signals?: { commitmentLinkage?: number };
}

export interface ContentContext {
  now: Date;
  userName: string;
  isSelf: (identity: string) => boolean;
  /** Non-archived tasks; may include snoozed and done rows (filtered here). */
  tasks: any[];
  meetings: any[];
  /** getPeople() rows (enriched with lastMeeting). */
  people: any[];
  scored: ScoredLike[];
}

export interface CalendarEventLike {
  id: string;
  title: string;
  startTime: Date | number | string;
  endTime: Date | number | string;
  attendees?: string[];
  seriesUid?: string | null;
}

// ── Identity helpers ───────────────────────────────────────────────────────

export interface Identity { name: string; email: string }

/** Parse ICS-style attendee strings: "Name <email>", bare email, or bare name. */
export function parseIdentity(raw: string): Identity {
  const s = String(raw || '').trim();
  const angle = /^(.*?)\s*<([^>]+)>\s*$/.exec(s);
  if (angle) return { name: angle[1].replace(/^"|"$/g, '').trim(), email: angle[2].trim().toLowerCase() };
  if (/^[^\s@]+@[^\s@]+$/.test(s)) return { name: '', email: s.toLowerCase() };
  return { name: s, email: '' };
}

function nameFromEmail(email: string): string {
  const local = email.split('@')[0] || '';
  return local.split(/[._-]+/).filter(Boolean).map((p) => p[0].toUpperCase() + p.slice(1)).join(' ');
}

export function displayName(raw: string): string {
  const id = parseIdentity(raw);
  return id.name || (id.email ? nameFromEmail(id.email) : String(raw || ''));
}

export function firstName(userName: string): string {
  return (userName || '').trim().split(/\s+/)[0] || '';
}

export function identitiesMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const x = parseIdentity(a);
  const y = parseIdentity(b);
  if (x.email && y.email) return x.email === y.email;
  const xn = x.name || (x.email ? nameFromEmail(x.email) : '');
  const yn = y.name || (y.email ? nameFromEmail(y.email) : '');
  return fuzzyNameScore(xn, yn) >= 0.85;
}

function personIdentities(person: any): string[] {
  return [
    person?.name,
    person?.email,
    ...(Array.isArray(person?.altNames) ? person.altNames : []),
    ...(Array.isArray(person?.altEmails) ? person.altEmails : []),
  ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

function matchesAny(value: string, identities: string[]): boolean {
  return identities.some((id) => identitiesMatch(value, id));
}

export function resolvePerson(attendee: string, people: any[]): any | null {
  return people.find((p) => matchesAny(attendee, personIdentities(p))) || null;
}

// ── Task / commitment helpers ──────────────────────────────────────────────

export function isOpenTask(t: any): boolean {
  if (!t || t.archivedAt) return false;
  if (t.snoozedAt != null) return false;
  return t.status !== 'done' && t.status !== 'completed';
}

function isOpenCommitment(c: any): boolean {
  if (!c || !c.text) return false;
  if (c.done === true || c.completed === true) return false;
  return !['done', 'completed', 'resolved'].includes(String(c.status || '').toLowerCase());
}

/** Whole local days a due date is past (>= 1), else null. Date-only dues are late from the next day. */
export function daysLate(due: unknown, now: Date): number | null {
  const ms = toMs(due);
  if (ms === null) return null;
  const days = Math.round((startOfLocalDay(now).getTime() - startOfLocalDay(new Date(ms)).getTime()) / DAY_MS);
  return days >= 1 ? days : null;
}

export function taskRef(task: any, now: Date): TaskRef {
  return {
    taskId: task._id,
    title: task.title || '',
    dueDate: task.dueDate || null,
    daysLate: daysLate(task.dueDate, now),
  };
}

function taskOwner(task: any): string {
  return String(task?.owner || task?.assignee || '');
}

function taskMeetingId(task: any): string | null {
  return task?.meetingId || (task?.source?.type === 'meeting' ? task.source.id : null) || task?.provenance?.meetingId || null;
}

function normText(s: string): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function meetingIncludes(meeting: any, identities: string[]): boolean {
  return (meeting?.attendees || []).some((a: string) => matchesAny(a, identities));
}

function sortOwed(items: OwedItem[]): OwedItem[] {
  return items.sort((a, b) => (b.daysLate ?? -1) - (a.daysLate ?? -1));
}

function pushUnique(list: OwedItem[], item: OwedItem): void {
  const key = normText(item.text);
  if (key && !list.some((x) => normText(x.text) === key)) list.push(item);
}

/** What the user owes the person with these identities (open self-owned tasks + self commitments from shared meetings). */
export function youOweItems(ctx: ContentContext, identities: string[], meetingsById: Map<string, any>): OwedItem[] {
  const out: OwedItem[] = [];
  for (const task of ctx.tasks) {
    if (!isOpenTask(task)) continue;
    const owner = taskOwner(task);
    if (!owner || !ctx.isSelf(owner)) continue;
    const mid = taskMeetingId(task);
    const meeting = mid ? meetingsById.get(mid) : null;
    if (!meeting || !meetingIncludes(meeting, identities)) continue;
    pushUnique(out, { kind: 'task', taskId: task._id, meetingId: mid, text: task.title || '', dueDate: task.dueDate || null, daysLate: daysLate(task.dueDate, ctx.now) });
  }
  for (const meeting of ctx.meetings) {
    if (!meetingIncludes(meeting, identities)) continue;
    for (const c of meeting?.insights?.commitments || []) {
      if (!isOpenCommitment(c) || !c.who || !ctx.isSelf(c.who)) continue;
      pushUnique(out, { kind: 'commitment', taskId: null, meetingId: meeting._id, text: c.text, dueDate: c.deadline || null, daysLate: daysLate(c.deadline, ctx.now) });
    }
  }
  return sortOwed(out);
}

/** What the person owes the user (their open tasks + their commitments). */
export function owesYouItems(ctx: ContentContext, identities: string[]): OwedItem[] {
  const out: OwedItem[] = [];
  for (const task of ctx.tasks) {
    if (!isOpenTask(task)) continue;
    const owner = taskOwner(task);
    if (!owner || ctx.isSelf(owner) || !matchesAny(owner, identities)) continue;
    pushUnique(out, { kind: 'task', taskId: task._id, meetingId: taskMeetingId(task), text: task.title || '', dueDate: task.dueDate || null, daysLate: daysLate(task.dueDate, ctx.now) });
  }
  for (const meeting of ctx.meetings) {
    for (const c of meeting?.insights?.commitments || []) {
      if (!isOpenCommitment(c) || !c.who || ctx.isSelf(c.who) || !matchesAny(c.who, identities)) continue;
      pushUnique(out, { kind: 'commitment', taskId: null, meetingId: meeting._id, text: c.text, dueDate: c.deadline || null, daysLate: daysLate(c.deadline, ctx.now) });
    }
  }
  return sortOwed(out);
}

// ── Catch up ───────────────────────────────────────────────────────────────

export function computeCatchUp(ctx: ContentContext, limit = CATCH_UP_MAX): CatchUpPerson[] {
  const meetingsById = new Map(ctx.meetings.map((m: any) => [m._id, m]));
  const rows: CatchUpPerson[] = [];
  for (const person of ctx.people) {
    if (!person?._id || person.archived) continue;
    const identities = personIdentities(person);
    if (identities.length === 0 || identities.some((id) => ctx.isSelf(id))) continue;
    const last = toMs(person.lastMeeting);
    if (last === null) continue;
    const days = Math.floor((ctx.now.getTime() - last) / DAY_MS);
    if (days < CATCH_UP_MIN_DAYS) continue;
    const owed = youOweItems(ctx, identities, meetingsById);
    if (owed.length === 0) continue;
    rows.push({
      personId: person._id,
      name: person.name || displayName(identities[0]),
      daysSinceMet: days,
      weeksSinceMet: Math.floor(days / 7),
      waitingOn: owed[0].text,
      waitingCount: owed.length,
    });
  }
  rows.sort((a, b) => (b.waitingCount - a.waitingCount) || (b.daysSinceMet - a.daysSinceMet));
  return rows.slice(0, limit);
}

export function buildCatchUpNotes(rows: CatchUpPerson[]): CatchUpNote[] {
  return rows.map((r) => ({
    personId: r.personId,
    weeksSinceMet: r.weeksSinceMet,
    waitingOn: r.waitingOn,
    text: `${r.weeksSinceMet} ${r.weeksSinceMet === 1 ? 'week' : 'weeks'} since you met · waiting on ${r.waitingOn}`,
  }));
}

// ── Morning ────────────────────────────────────────────────────────────────

export function buildMorning(ctx: ContentContext & {
  todayEvents: CalendarEventLike[];
  welcomeBack: WelcomeBackContent | null;
}): MorningContent {
  const { now } = ctx;
  const open = ctx.tasks.filter(isOpenTask);
  const meetingsById = new Map(ctx.meetings.map((m: any) => [m._id, m]));
  const briefing = buildDailyBriefing({
    now,
    name: ctx.userName,
    tasks: open,
    meetings: ctx.meetings,
    calendarEvents: ctx.todayEvents,
    scoredTasks: ctx.scored,
  });
  const topPriorities: PriorityItem[] = briefing.topTasks.map((t: any, i: number) => {
    const mid = taskMeetingId(t);
    return {
      ...taskRef(t, now),
      rank: i + 1,
      score: t.priorityScore,
      sourceMeetingId: mid,
      sourceMeetingTitle: mid ? meetingsById.get(mid)?.title || null : null,
    };
  });

  const since = startOfLocalDay(now, -1).getTime();
  const doneSinceYesterday = open
    .filter((t) => t.likelyDone === true && (toMs(t.likelyDoneAt) ?? -1) >= since)
    .map((t) => taskRef(t, now));

  let overduePromiseCount = 0;
  const seen = new Set<string>();
  for (const m of ctx.meetings) {
    for (const c of m?.insights?.commitments || []) {
      if (!isOpenCommitment(c) || !c.who || !ctx.isSelf(c.who)) continue;
      const due = toMs(c.deadline);
      if (due === null || due >= now.getTime()) continue;
      const key = normText(c.text);
      if (seen.has(key)) continue;
      seen.add(key);
      overduePromiseCount++;
    }
  }

  return {
    firstName: firstName(ctx.userName),
    meetingCount: briefing.meetingCount,
    priorityCount: topPriorities.length,
    overduePromiseCount,
    topPriorities,
    doneSinceYesterday,
    catchUp: computeCatchUp(ctx),
    welcomeBack: ctx.welcomeBack,
  };
}

// ── Prep ───────────────────────────────────────────────────────────────────

export function findLastMet(ctx: ContentContext, event: CalendarEventLike, otherAttendees: string[]): { meetingId: string; title: string; date: string } | null {
  const start = toMs(event.startTime) ?? ctx.now.getTime();
  let best: any = null;
  let bestMs = -Infinity;
  for (const m of ctx.meetings) {
    if (!m || m.calendarEventId === event.id || m.source === 'slack_thread' || m.source === 'voice_memo') continue;
    const ms = toMs(m.date);
    if (ms === null || ms >= start) continue;
    const sameSeries = !!event.seriesUid && m.seriesUid === event.seriesUid;
    const shared = otherAttendees.length > 0 && (m.attendees || []).some((a: string) => otherAttendees.some((o) => identitiesMatch(a, o)));
    if (!sameSeries && !shared) continue;
    if (ms > bestMs) { best = m; bestMs = ms; }
  }
  return best ? { meetingId: best._id, title: best.title || '', date: best.date } : null;
}

export function buildPrep(ctx: ContentContext & {
  event: CalendarEventLike;
  draftAgenda: string[] | null;
  pendingApprovals: PendingJiraApproval[];
  recordArmed: boolean;
}): PrepContent {
  const { event, now } = ctx;
  const start = toMs(event.startTime) ?? now.getTime();
  const end = toMs(event.endTime) ?? start;
  const others = (event.attendees || []).filter((a) => a && !ctx.isSelf(a));
  const meetingsById = new Map(ctx.meetings.map((m: any) => [m._id, m]));

  const owes: AttendeeOwes[] = [];
  for (const attendee of others) {
    const person = resolvePerson(attendee, ctx.people);
    const identities = person ? Array.from(new Set([attendee, ...personIdentities(person)])) : [attendee];
    const owesYou = owesYouItems(ctx, identities).slice(0, OWED_MAX);
    const youOwe = youOweItems(ctx, identities, meetingsById).slice(0, OWED_MAX);
    if (owesYou.length === 0 && youOwe.length === 0) continue;
    owes.push({ name: person?.name || displayName(attendee), personId: person?._id || null, owesYou, youOwe });
  }

  const pendingApprovals = ctx.pendingApprovals.filter((p) => {
    const m = p.meetingId ? meetingsById.get(p.meetingId) : null;
    return !!m && others.length > 0 && (m.attendees || []).some((a: string) => others.some((o) => identitiesMatch(a, o)));
  });

  return {
    eventId: event.id,
    title: event.title,
    startTime: start,
    endTime: end,
    minutesUntil: Math.max(0, Math.ceil((start - now.getTime()) / 60_000)),
    attendees: others.map(displayName),
    lastMet: findLastMet(ctx, event, others),
    draftAgenda: ctx.draftAgenda && ctx.draftAgenda.length > 0 ? ctx.draftAgenda : null,
    owes,
    pendingApprovals,
    recordArmed: ctx.recordArmed,
  };
}

// ── Processed ──────────────────────────────────────────────────────────────

export function summarizePendingApproval(p: { _id: string; pushParams: any; meetingTitle?: string | null; createdAt: string }, meetingId: string | null): PendingJiraApproval {
  const params = p.pushParams || {};
  const args = params.args || {};
  const op = params.operation || 'create';
  const summary =
    op === 'create' ? `Create “${args.title || 'issue'}”`
      : op === 'update' ? `Update ${args.issueKey || 'issue'}${args.updates?.title ? `: ${args.updates.title}` : ''}`
        : op === 'transition' ? `Move ${args.issueKey || 'issue'} to ${args.targetStatus || 'new status'}`
          : `Comment on ${args.issueKey || 'issue'}`;
  return {
    id: p._id,
    operation: op,
    summary,
    issueKey: args.issueKey || null,
    meetingId,
    meetingTitle: p.meetingTitle || null,
    createdAt: p.createdAt,
  };
}

export function buildProcessed(input: {
  meeting: any;
  tasks: any[];
  sorWrites: any[];
  pendingApprovals: PendingJiraApproval[];
  slackConnected: boolean;
}): ProcessedContent {
  const m = input.meeting || {};
  const failure = m.recordingFailure && m.status === 'error' ? m.recordingFailure : null;
  const status: ProcessedContent['status'] = failure || m.status === 'error'
    ? 'failed'
    : m.status === 'needs_review' ? 'needs_review' : 'processed';
  const start = toMs(m.date);
  const tasks = input.tasks
    .filter((t) => !t.archivedAt && taskMeetingId(t) === m._id)
    .map((t) => ({
      taskId: t._id,
      title: t.title || '',
      owner: t.owner || t.assignee || null,
      dueDate: t.dueDate || null,
      approvalStatus: t.approval?.status || 'auto_approved',
      duplicateOf: t.dedupSuggestion
        ? { taskId: t.dedupSuggestion.candidateTaskId, title: t.dedupSuggestion.candidateTitle, wasDone: !!t.dedupSuggestion.wasDone }
        : null,
    }));
  const decisions = (m.insights?.decisions || []).map((d: any) => (typeof d === 'string' ? d : d?.text)).filter(Boolean);
  const quality = m.transcriptQuality;
  const patchy = quality && quality.ok === false;
  const jiraWrites = input.sorWrites.filter((w) => w.targetSystem === 'jira' || !w.targetSystem);
  const pushed = jiraWrites.filter((w) => w.result === 'success');
  const failedCount = jiraWrites.filter((w) => w.result === 'failed' && w.errorMessage !== 'User rejected').length;
  const jira = jiraWrites.length > 0 || input.pendingApprovals.length > 0
    ? {
        pushedCount: pushed.length,
        failedCount,
        pushed: pushed.map((w) => ({ id: w._id, issueKey: w.targetRecordId, url: w.targetRecordUrl || null, operation: w.operation })),
        pending: input.pendingApprovals,
      }
    : null;

  return {
    meetingId: m._id,
    title: m.title || 'Meeting',
    source: m.source || 'desktop_recording',
    status,
    startedAt: start,
    endedAt: start !== null && m.duration > 0 ? start + m.duration * 1000 : null,
    taskCount: Array.isArray(m.insights?.actionItems) ? m.insights.actionItems.length : tasks.length,
    decisionCount: decisions.length,
    tasks,
    decisions,
    patchyAudio: patchy ? { reasons: Array.isArray(quality.reasons) ? quality.reasons : [] } : null,
    jira,
    failure: status === 'failed'
      ? { message: failure?.message || 'Processing failed.', stage: failure?.stage || null, audioSaved: failure ? failure.audioSaved !== false : !!m.recordingRecovery }
      : null,
    slackConnected: input.slackConnected,
  };
}

// ── Wrap-up ────────────────────────────────────────────────────────────────

/**
 * Busy-day check for tomorrow. Crunch when there is no free gap of
 * CRUNCH_MIN_GAP_MS between 9:00 and 17:00, or — for a day that spans at
 * least three hours of meetings — none between the first start and last end.
 */
export function computeCrunch(events: CalendarEventLike[], day: Date): { from: number; to: number } | null {
  const spans = events
    .map((e) => ({ s: toMs(e.startTime), e: toMs(e.endTime) }))
    .filter((x): x is { s: number; e: number } => x.s !== null && x.e !== null && x.e > x.s)
    .sort((a, b) => a.s - b.s);
  if (spans.length === 0) return null;

  const hasGap = (from: number, to: number): boolean => {
    let cursor = from;
    for (const sp of spans) {
      if (sp.e <= cursor) continue;
      if (sp.s >= to) break;
      if (sp.s - cursor >= CRUNCH_MIN_GAP_MS) return true;
      cursor = Math.max(cursor, sp.e);
      if (cursor >= to) return false;
    }
    return to - cursor >= CRUNCH_MIN_GAP_MS;
  };

  const workStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9).getTime();
  const workEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 17).getTime();
  if (!hasGap(workStart, workEnd)) return { from: workStart, to: workEnd };

  const first = spans[0].s;
  const last = Math.max(...spans.map((x) => x.e));
  if (last - first >= 3 * 60 * 60_000 && !hasGap(first, last)) return { from: first, to: last };
  return null;
}

export function computeGoneQuiet(ctx: ContentContext): WrapUpContent['goneQuiet'] {
  const cutoff = ctx.now.getTime() - GONE_QUIET_DAYS * DAY_MS;
  const byId = new Map(ctx.tasks.map((t: any) => [t._id, t]));
  const rows: (WrapUpContent['goneQuiet'][number] & { rank: number })[] = [];
  for (const s of ctx.scored) {
    if (s.score < GONE_QUIET_MIN_SCORE) continue;
    const t = byId.get(s._id);
    if (!t || !isOpenTask(t)) continue;
    const mentioned = toMs(t.lastMentionedAt);
    if (mentioned !== null && mentioned >= cutoff) continue;
    const updated = toMs(t.updatedAt) ?? toMs(t.createdAt);
    if (updated !== null && updated >= cutoff) continue;
    const owner = taskOwner(t);
    const commitment = (s.signals?.commitmentLinkage ?? 0) > 0 || t.isCommitment === true;
    const commitmentToOther = commitment && (!owner || ctx.isSelf(owner));
    const lastActivity = Math.max(mentioned ?? -Infinity, updated ?? -Infinity);
    rows.push({
      ...taskRef(t, ctx.now),
      score: s.score,
      commitmentToOther,
      lastActivityAt: Number.isFinite(lastActivity) ? new Date(lastActivity).toISOString() : null,
      rank: s.score + (commitmentToOther ? 20 : 0),
    });
  }
  rows.sort((a, b) => b.rank - a.rank);
  return rows.slice(0, GONE_QUIET_MAX).map(({ rank: _rank, ...row }) => row);
}

function inDay(ms: number | null, day: Date): boolean {
  if (ms === null) return false;
  return ms >= startOfLocalDay(day).getTime() && ms < startOfLocalDay(day, 1).getTime();
}

export interface CancelledEventRecord {
  id: string;
  title: string;
  startTime: number;
  seriesUid?: string | null;
}

export function buildTomorrow(ctx: ContentContext & {
  events: CalendarEventLike[];
  agendaEventIds: Set<string>;
  cancelledToday: CancelledEventRecord[];
}): TomorrowContent {
  const { now } = ctx;
  const tomorrow = startOfLocalDay(now, 1);
  const tomorrowKey = localDayKey(tomorrow);
  const open = ctx.tasks.filter(isOpenTask);
  const tEvents = ctx.events
    .filter((e) => inDay(toMs(e.startTime), tomorrow))
    .sort((a, b) => (toMs(a.startTime) ?? 0) - (toMs(b.startTime) ?? 0));

  let firstMeeting: TomorrowContent['firstMeeting'] = null;
  if (tEvents.length > 0) {
    const first = tEvents[0];
    const firstStart = toMs(first.startTime)!;
    const tasksDueBefore = open
      .filter((t) => {
        if (typeof t.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.dueDate)) return t.dueDate === tomorrowKey;
        const due = toMs(t.dueDate);
        return due !== null && due >= tomorrow.getTime() && due < firstStart;
      })
      .map((t) => taskRef(t, now));
    firstMeeting = { eventId: first.id, title: first.title, startTime: firstStart, agendaDrafted: ctx.agendaEventIds.has(first.id), tasksDueBefore };
  }

  const tomorrowAttendees = Array.from(new Set(tEvents.flatMap((e) => (e.attendees || []).filter((a) => a && !ctx.isSelf(a)))));
  const meetingsById = new Map(ctx.meetings.map((m: any) => [m._id, m]));
  const overdueWithAttendees: TomorrowContent['overdueWithAttendees'] = [];
  for (const t of open) {
    if (overdueWithAttendees.length >= 3) break;
    if (daysLate(t.dueDate, now) === null) continue;
    const owner = taskOwner(t);
    const mid = taskMeetingId(t);
    const meeting = mid ? meetingsById.get(mid) : null;
    const attendee = tomorrowAttendees.find((a) =>
      (owner && !ctx.isSelf(owner) && identitiesMatch(owner, a))
      || (meeting && (meeting.attendees || []).some((x: string) => identitiesMatch(x, a))));
    if (!attendee) continue;
    overdueWithAttendees.push({ ...taskRef(t, now), attendee: displayName(attendee) });
  }

  let crunch: TomorrowContent['crunch'] = null;
  const window = computeCrunch(tEvents, tomorrow);
  if (window) {
    const scoreById = new Map(ctx.scored.map((s) => [s._id, s.score]));
    const topOverdue = open
      .filter((t) => daysLate(t.dueDate, now) !== null)
      .sort((a, b) => (scoreById.get(b._id) ?? 0) - (scoreById.get(a._id) ?? 0))[0];
    crunch = { ...window, topOverdue: topOverdue ? taskRef(topOverdue, now) : null };
  }

  const cancelledToday: TomorrowContent['cancelledToday'] = [];
  for (const c of ctx.cancelledToday) {
    const eventDay = new Date(c.startTime);
    const tasks = open.filter((t) => {
      const due = toMs(t.dueDate);
      if (due === null || due >= startOfLocalDay(eventDay, 1).getTime()) return false;
      const mid = taskMeetingId(t);
      const m = mid ? meetingsById.get(mid) : null;
      if (!m) return false;
      return m.calendarEventId === c.id || (!!c.seriesUid && m.seriesUid === c.seriesUid);
    });
    if (tasks.length > 0) cancelledToday.push({ eventId: c.id, title: c.title, startTime: c.startTime, tasks: tasks.map((t) => taskRef(t, now)) });
  }

  return { firstMeeting, overdueWithAttendees, crunch, cancelledToday };
}

export function buildWrapUp(ctx: ContentContext & {
  events: CalendarEventLike[];
  agendaEventIds: Set<string>;
  cancelledToday: CancelledEventRecord[];
  /** Includes snoozed tasks (getTasks({ includeSnoozed: true })). */
  allTasks: any[];
  executions: { _id: string; actionItemTitle: string; client: string; status: string; updatedAt: string; outcomes?: { summary?: string }[] }[];
  slackSyncedAt: number | null;
}): WrapUpContent {
  const { now } = ctx;
  const todayMeetings = ctx.meetings.filter((m) => inDay(toMs(m.date), now));
  const todayEventIds = new Set(ctx.events.filter((e) => inDay(toMs(e.startTime), now)).map((e) => e.id));
  const unmatched = todayMeetings.filter((m) =>
    !['slack_thread', 'voice_memo'].includes(m.source)
    && m.status !== 'calendar_sync'
    && !(m.calendarEventId && todayEventIds.has(m.calendarEventId)));
  const tasksFound = ctx.allTasks.filter((t) => !t.archivedAt && t.aiExtracted === true && inDay(toMs(t.createdAt), now)).length;
  const decisions = todayMeetings.reduce((sum, m) => sum + (m.insights?.decisions?.length || 0), 0);

  const slack = new Map<string, { channelId: string; threadCount: number; taskCount: number; decisionCount: number }>();
  for (const m of ctx.meetings) {
    if (m.source !== 'slack_thread' || !inDay(toMs(m.createdAt) ?? toMs(m.date), now)) continue;
    const channelId = m.slackChannelId || 'unknown';
    const row = slack.get(channelId) || { channelId, threadCount: 0, taskCount: 0, decisionCount: 0 };
    row.threadCount++;
    row.taskCount += m.insights?.actionItems?.length || 0;
    row.decisionCount += m.insights?.decisions?.length || 0;
    slack.set(channelId, row);
  }

  const snoozedToday = ctx.allTasks
    .filter((t) => !t.archivedAt && t.snoozedAt != null && t.snoozedReason === 'stale-30d' && inDay(toMs(t.snoozedAt), now))
    .map((t) => taskRef(t, now));

  const receipts = ctx.executions
    .filter((e) => e.status === 'completed' && inDay(toMs(e.updatedAt), now))
    .map((e) => ({
      executionId: e._id,
      title: e.actionItemTitle,
      client: e.client,
      status: e.status,
      summary: e.outcomes && e.outcomes.length > 0 ? e.outcomes[e.outcomes.length - 1].summary || null : null,
      at: e.updatedAt,
    }));

  const needsRetry = ctx.meetings
    .filter((m) => m.status === 'error' && m.recordingRecovery && m.recordingFailure?.audioSaved !== false)
    .sort((a, b) => (toMs(b.date) ?? 0) - (toMs(a.date) ?? 0))
    .slice(0, 3)
    .map((m) => ({ meetingId: m._id, title: m.title || 'Meeting', date: m.date, message: m.recordingFailure?.message || null }));

  return {
    firstName: firstName(ctx.userName),
    today: { meetingCount: todayEventIds.size + unmatched.length, tasksFound, decisions },
    tomorrow: buildTomorrow(ctx),
    goneQuiet: computeGoneQuiet(ctx),
    slackToday: Array.from(slack.values()),
    snoozedToday,
    receipts,
    needsRetry,
    slackSyncedAt: ctx.slackSyncedAt,
  };
}
