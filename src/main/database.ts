import * as path from 'path';
import { app } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import Datastore from '@seald-io/nedb';
import { getConfig } from './config';
import { isSelf } from './self-identity';

let meetingsDb: Datastore;
let tasksDb: Datastore;
let peopleDb: Datastore;
let voicePrintsDb: Datastore;

export function initDatabase(): void {
  const userDataPath = app.getPath('userData');
  meetingsDb = new Datastore({ filename: path.join(userDataPath, 'meetings.db'), autoload: true });
  tasksDb = new Datastore({ filename: path.join(userDataPath, 'tasks.db'), autoload: true });
  peopleDb = new Datastore({ filename: path.join(userDataPath, 'people.db'), autoload: true });
  voicePrintsDb = new Datastore({ filename: path.join(userDataPath, 'voiceprints.db'), autoload: true });
}

// ── Meetings ──────────────────────────────────────────────────────────────────

export async function createMeeting(data: {
  title: string;
  date: string;
  duration?: number;
  calendarEventId?: string;
  source?: string;
  attendees?: string[];
}): Promise<string> {
  const doc = await meetingsDb.insertAsync({
    _id: uuidv4(),
    title: data.title,
    date: data.date,
    duration: data.duration || 0,
    attendees: data.attendees || [],
    transcript: null,
    status: 'pending',
    source: data.source || 'desktop_recording',
    calendarEventId: data.calendarEventId || null,
    insights: null,
    createdAt: new Date().toISOString(),
  });
  return (doc as any)._id;
}

export async function updateMeetingTranscript(id: string, transcript: string, duration: number): Promise<void> {
  await meetingsDb.updateAsync({ _id: id }, { $set: { transcript, duration, status: 'transcribed' } }, {});
}

export async function updateMeetingStatus(id: string, status: string): Promise<void> {
  await meetingsDb.updateAsync({ _id: id }, { $set: { status } }, {});
}

export async function saveInsights(meetingId: string, insights: {
  summary: string;
  actionItems: { text: string; owner?: string; dueDate?: string; priority?: string; isCommitment?: boolean }[];
  decisions: { text: string; rationale?: string }[];
  blockers: { text: string; severity?: string }[];
  commitments?: { text: string; who: string; deadline?: string; context?: string }[];
  contradictions?: { text: string; previousDecision: string; previousMeetingTitle?: string; previousMeetingDate?: string }[];
  people?: { name: string; email?: string; role?: string; company?: string }[];
}): Promise<void> {
  await meetingsDb.updateAsync(
    { _id: meetingId },
    {
      $set: {
        status: 'processed',
        insights: {
          summary: insights.summary,
          actionItems: insights.actionItems,
          decisions: insights.decisions,
          blockers: insights.blockers,
          commitments: insights.commitments || [],
          contradictions: insights.contradictions || [],
        },
      },
    },
    {}
  );

  // Auto-create tasks from action items
  for (const item of insights.actionItems) {
    await tasksDb.insertAsync({
      _id: uuidv4(),
      title: item.text,
      description: '',
      status: 'todo',
      priority: item.priority || 'medium',
      dueDate: item.dueDate || null,
      source: { type: 'meeting', id: meetingId },
      aiExtracted: true,
      approval: { status: 'pending' },
      provenance: {
        meetingId,
        extractionMethod: 'transcript_analysis',
        extractedAt: new Date().toISOString(),
      },
      archivedAt: null,
      createdAt: new Date().toISOString(),
    });
  }

}

export async function getMeetings(): Promise<any[]> {
  const meetings = await (meetingsDb as any).findAsync({}).sort({ date: -1 });
  return meetings.map((m: any) => ({
    ...m,
    hasTranscript: !!m.transcript,
    hasInsights: !!(m.insights?.summary || m.insights?.actionItems?.length),
    actionItemCount: m.insights?.actionItems?.length || 0,
    blockerCount: m.insights?.blockers?.length || 0,
    decisionCount: m.insights?.decisions?.length || 0,
    commitmentCount: m.insights?.commitments?.length || 0,
    contradictionCount: m.insights?.contradictions?.length || 0,
  }));
}

export async function getMeeting(id: string): Promise<any> {
  return meetingsDb.findOneAsync({ _id: id });
}

export async function getOverdueCommitments(): Promise<any[]> {
  const now = new Date();
  const meetings = await meetingsDb.findAsync({});
  const overdue: any[] = [];
  for (const m of meetings as any[]) {
    for (const c of (m.insights?.commitments || [])) {
      if (c.deadline) {
        const deadline = new Date(c.deadline);
        if (deadline < now) {
          overdue.push({
            text: c.text,
            who: c.who,
            deadline: c.deadline,
            meetingTitle: m.title,
            meetingDate: m.date,
            meetingId: m._id,
            daysOverdue: Math.floor((now.getTime() - deadline.getTime()) / (24 * 60 * 60 * 1000)),
          });
        }
      }
    }
  }
  return overdue.sort((a, b) => b.daysOverdue - a.daysOverdue);
}

export async function getAllPastDecisions(): Promise<{ text: string; meetingTitle: string; meetingDate: string }[]> {
  const meetings = await meetingsDb.findAsync({});
  const decisions: { text: string; meetingTitle: string; meetingDate: string }[] = [];
  for (const m of meetings as any[]) {
    if (m.insights?.decisions) {
      for (const d of m.insights.decisions) {
        decisions.push({
          text: d.text || d,
          meetingTitle: m.title,
          meetingDate: new Date(m.date).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }),
        });
      }
    }
  }
  return decisions;
}

export async function deleteMeeting(id: string): Promise<void> {
  await meetingsDb.removeAsync({ _id: id }, {});
  // Remove linked tasks
  await tasksDb.removeAsync({ 'source.id': id }, { multi: true });
}

export async function createMeetingFromTranscript(data: {
  title: string;
  content: string;
  date: string;
}): Promise<any> {
  const doc = await meetingsDb.insertAsync({
    _id: uuidv4(),
    title: data.title,
    date: data.date,
    duration: 0,
    attendees: [],
    transcript: data.content,
    status: 'pending',
    source: 'manual_upload',
    calendarEventId: null,
    insights: null,
    createdAt: new Date().toISOString(),
  });
  return doc;
}

// ── Calendar Sync ────────────────────────────────────────────────────────────

export async function syncCalendarEventsToDb(events: {
  id: string;
  title: string;
  startTime: Date;
  endTime: Date;
  attendees: string[];
}[]): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;

  // Only sync past events (already happened) — future events aren't meetings yet
  const now = new Date();

  for (const event of events) {
    if (event.startTime > now) continue;
    if (!event.attendees || event.attendees.length === 0) continue;

    const date = event.startTime.toISOString();
    const duration = Math.max(0, Math.round((event.endTime.getTime() - event.startTime.getTime()) / 1000));

    // NeDB doesn't support $setOnInsert — find then insert-or-update to stay idempotent.
    const existing = await meetingsDb.findOneAsync({ calendarEventId: event.id });
    if (existing) {
      await meetingsDb.updateAsync(
        { _id: (existing as any)._id },
        { $set: { title: event.title, attendees: event.attendees, date, duration } },
        {}
      );
      updated++;
    } else {
      await meetingsDb.insertAsync({
        _id: uuidv4(),
        title: event.title,
        date,
        duration,
        attendees: event.attendees,
        transcript: null,
        status: 'calendar_sync',
        source: 'calendar',
        calendarEventId: event.id,
        insights: null,
        createdAt: new Date().toISOString(),
      });
      created++;
    }
  }

  return { created, updated };
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

export function isSnoozed(t: any): boolean {
  return !!(t && t.snoozedAt != null);
}

function sortTasks(tasks: any[]): any[] {
  const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  return tasks.sort((a: any, b: any) => {
    const pa = priorityOrder[a.priority] ?? 2;
    const pb = priorityOrder[b.priority] ?? 2;
    if (pa !== pb) return pa - pb;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

export async function getTasks(opts?: { includeSnoozed?: boolean }): Promise<any[]> {
  const query: any = { archivedAt: null };
  if (!opts?.includeSnoozed) {
    query.snoozedAt = null;
  }
  const tasks = await tasksDb.findAsync(query);
  return sortTasks(tasks);
}

export async function getSnoozedTasks(): Promise<any[]> {
  const tasks = await tasksDb.findAsync({ archivedAt: null, snoozedAt: { $ne: null } });
  return sortTasks(tasks);
}

export async function createTask(data: {
  title: string;
  description?: string;
  priority?: string;
  dueDate?: string;
  status?: string;
}): Promise<any> {
  const now = new Date().toISOString();
  const doc = await tasksDb.insertAsync({
    _id: uuidv4(),
    title: data.title,
    description: data.description || '',
    status: data.status || 'todo',
    priority: data.priority || 'medium',
    dueDate: data.dueDate || null,
    source: { type: 'manual' },
    aiExtracted: false,
    approval: { status: 'auto_approved' },
    archivedAt: null,
    snoozedAt: null,
    snoozedReason: null,
    lastMentionedAt: null,
    likelyDone: false,
    createdAt: now,
    updatedAt: now,
  });
  return doc;
}

export async function markLikelyDone(taskId: string): Promise<void> {
  const now = new Date().toISOString();
  await tasksDb.updateAsync(
    { _id: taskId },
    { $set: { likelyDone: true, updatedAt: now } },
    {},
  );
}

export async function confirmLikelyDone(taskId: string): Promise<void> {
  const now = new Date().toISOString();
  await tasksDb.updateAsync(
    { _id: taskId },
    { $set: { likelyDone: false, status: 'done', updatedAt: now } },
    {},
  );
}

export async function rejectLikelyDone(taskId: string): Promise<void> {
  const now = new Date().toISOString();
  await tasksDb.updateAsync(
    { _id: taskId },
    { $set: { likelyDone: false, updatedAt: now } },
    {},
  );
}

export async function updateTask(id: string, updates: Record<string, any>): Promise<any> {
  await tasksDb.updateAsync({ _id: id }, { $set: updates }, {});
  return tasksDb.findOneAsync({ _id: id });
}

export async function deleteTask(id: string): Promise<void> {
  await tasksDb.removeAsync({ _id: id }, {});
}

export async function snoozeTask(taskId: string, reason: string): Promise<void> {
  const now = new Date().toISOString();
  await tasksDb.updateAsync(
    { _id: taskId },
    { $set: { snoozedAt: now, snoozedReason: reason, updatedAt: now } },
    {},
  );
}

export async function bringBackTask(taskId: string): Promise<void> {
  const now = new Date().toISOString();
  await tasksDb.updateAsync(
    { _id: taskId },
    { $set: { snoozedAt: null, snoozedReason: null, updatedAt: now } },
    {},
  );
}

export async function touchLastMentioned(taskId: string, when: string): Promise<void> {
  await tasksDb.updateAsync(
    { _id: taskId },
    { $set: { lastMentionedAt: when, updatedAt: new Date().toISOString() } },
    {},
  );
}

// Test-only: inject an in-memory Datastore so helpers can be exercised without
// booting Electron. Do NOT call from production code.
export function __setTasksDbForTests(db: Datastore): void {
  tasksDb = db;
}

// ── People ─────────────────────────────────────────────────────────────────────

async function computePeopleStats(person: any): Promise<any> {
  const allMeetings = await meetingsDb.findAsync({});
  const personMeetings = allMeetings.filter((m: any) =>
    (m.attendees || []).some((a: string) =>
      a && person.name &&
      (a.toLowerCase().includes(person.name.toLowerCase()) ||
      (person.email && a.toLowerCase().includes((person.email || '').toLowerCase())))
    )
  );

  const sorted = personMeetings.sort((a: any, b: any) =>
    new Date(b.date).getTime() - new Date(a.date).getTime()
  );

  const lastMeetingDate = sorted[0]?.date || null;
  const now = new Date();
  const daysSinceLastContact = lastMeetingDate
    ? Math.floor((now.getTime() - new Date(lastMeetingDate).getTime()) / (1000 * 60 * 60 * 24))
    : null;

  const meetingCount = personMeetings.length;
  const actionItemCount = personMeetings.reduce(
    (sum: number, m: any) => sum + (m.insights?.actionItems?.length || 0),
    0
  );
  const engagementScore = Math.min(
    100,
    meetingCount * 15 + Math.max(0, 30 - (daysSinceLastContact ?? 30))
  );
  const firstMeeting = sorted[sorted.length - 1]?.date || null;
  const relationshipDuration =
    sorted.length > 1
      ? Math.floor(
          (new Date(sorted[0].date).getTime() - new Date(sorted[sorted.length - 1].date).getTime()) /
            (1000 * 60 * 60 * 24)
        )
      : 0;

  return {
    ...person,
    meetingCount,
    lastMeeting: lastMeetingDate,
    firstMeeting,
    actionItemCount,
    daysSinceLastContact,
    relationshipDuration,
    engagementScore,
    recentMeetings: sorted.slice(0, 3).map((m: any) => ({ _id: m._id, title: m.title, date: m.date })),
  };
}

export async function getPeople(search?: string): Promise<any[]> {
  const query: any = { archived: { $ne: true } };
  if (search) {
    const re = new RegExp(search, 'i');
    query.$or = [{ name: re }, { email: re }, { company: re }];
  }
  const people = await peopleDb.findAsync(query);
  return Promise.all(people.map(computePeopleStats));
}

export async function getArchivedPeople(): Promise<any[]> {
  const people = await peopleDb.findAsync({ archived: true });
  return Promise.all(people.map(computePeopleStats));
}

export async function getPerson(id: string): Promise<any> {
  const person = await peopleDb.findOneAsync({ _id: id });
  if (!person) return null;

  const personName = ((person as any).name || '').toLowerCase();
  const personEmail = ((person as any).email || '').toLowerCase();
  const allMeetings = await meetingsDb.findAsync({});
  const personMeetings = allMeetings
    .filter((m: any) =>
      (m.attendees || []).some((a: string) => {
        if (!a) return false;
        const lower = a.toLowerCase();
        return (personName && (lower.includes(personName) || personName.includes(lower))) ||
               (personEmail && (lower.includes(personEmail) || personEmail.includes(lower)));
      })
    )
    .sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const communications = personMeetings.map((m: any, idx: number) => ({
    _id: m._id,
    title: m.title,
    date: m.date,
    channel: 'meeting',
    summary: m.insights?.summary || null,
    actionItems: (m.insights?.actionItems || []).map((item: any, i: number) => ({
      text: item.text,
      assignee: item.owner || '',
      dueDate: item.dueDate || '',
      convertedToTaskId: null,
      taskStatus: null,
      insightId: m._id,
      actionItemIndex: i,
      meetingId: m._id,
    })),
    keyDecisions: (m.insights?.decisions || []).map((d: any) => d.text || d),
  }));

  // Only show action items owned by the person or the logged-in user
  const pendingActionItems = communications
    .flatMap((c: any) => c.actionItems)
    .filter((item: any) => {
      if (item.convertedToTaskId) return false;
      const owner = (item.assignee || '').toLowerCase();
      if (!owner) return true; // unassigned items are relevant
      return owner.includes(personName) || personName.includes(owner) ||
             owner.includes(personEmail) || personEmail.includes(owner) ||
             isSelf(owner);
    });

  // Aggregate commitments made by this person across all meetings
  const commitments: any[] = [];
  for (const m of personMeetings as any[]) {
    for (const c of (m.insights?.commitments || [])) {
      if (c.who && personName && (personName.includes(c.who.toLowerCase()) ||
          c.who.toLowerCase().includes(personName))) {
        commitments.push({
          text: c.text,
          who: c.who,
          deadline: c.deadline || null,
          context: c.context || null,
          meetingTitle: m.title,
          meetingDate: m.date,
          meetingId: m._id,
        });
      }
    }
  }

  // Compute nudges
  const nudges: any[] = [];
  const now = new Date();
  const DAY_MS = 24 * 60 * 60 * 1000;

  // Overdue commitments
  for (const c of commitments) {
    if (c.deadline) {
      const deadline = new Date(c.deadline);
      if (deadline < now) {
        const daysOverdue = Math.floor((now.getTime() - deadline.getTime()) / DAY_MS);
        nudges.push({
          type: 'overdue_commitment',
          severity: daysOverdue > 7 ? 'high' : 'medium',
          text: `Committed to "${c.text}" — ${daysOverdue} day${daysOverdue !== 1 ? 's' : ''} overdue`,
          meetingTitle: c.meetingTitle,
          meetingDate: c.meetingDate,
        });
      }
    }
  }

  // Stale tasks from meetings with this person (todo for 7+ days)
  const meetingIds = new Set((personMeetings as any[]).map(m => m._id));
  const allTasks = await tasksDb.findAsync({ archivedAt: null });
  for (const t of allTasks as any[]) {
    const taskMeetingId = t.source?.id || t.provenance?.meetingId;
    if (taskMeetingId && meetingIds.has(taskMeetingId) && t.status === 'todo') {
      const daysOld = Math.floor((now.getTime() - new Date(t.createdAt).getTime()) / DAY_MS);
      if (daysOld >= 7) {
        nudges.push({
          type: 'stale_task',
          severity: daysOld > 14 ? 'high' : 'medium',
          text: `"${t.title}" has been open for ${daysOld} days`,
          meetingTitle: meetingIds.has(taskMeetingId) ? (personMeetings as any[]).find(m => m._id === taskMeetingId)?.title : undefined,
        });
      }
    }
  }

  const base = await computePeopleStats(person);

  return {
    ...base,
    pendingActionItems,
    commitments,
    nudges: nudges.sort((a, b) => (b.severity === 'high' ? 1 : 0) - (a.severity === 'high' ? 1 : 0)),
    communications,
    workingGroups: [],
    summary: {
      totalMeetings: base.meetingCount,
      totalActionItems: base.actionItemCount,
      pendingActionItems: pendingActionItems.length,
      totalDecisions: communications.reduce((s: number, c: any) => s + c.keyDecisions.length, 0),
      totalCommitments: commitments.length,
      keyTopics: [],
      firstInteraction: base.firstMeeting,
      lastInteraction: base.lastMeeting,
      daysSinceLastContact: base.daysSinceLastContact,
    },
  };
}

export async function addPerson(data: {
  firstName: string;
  lastName: string;
  email?: string | null;
  notes?: string | null;
}): Promise<any> {
  const name = `${(data.firstName || '').trim()} ${(data.lastName || '').trim()}`.trim();
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const recentMeetings = await (meetingsDb as any).findAsync({ date: { $gte: ninetyDaysAgo } });
  const retroMeetings = name ? recentMeetings.filter((m: any) =>
    (m.attendees || []).some((a: string) => a && a.toLowerCase().includes(name.toLowerCase()))
  ) : [];

  const doc = await peopleDb.insertAsync({
    _id: uuidv4(),
    name,
    email: data.email || null,
    company: null,
    role: null,
    bio: null,
    notes: data.notes || null,
    relationshipInsights: [],
    archived: false,
    trackedBy: true,
    createdAt: new Date().toISOString(),
  });

  return { ...(doc as any), retroactiveMeetingCount: retroMeetings.length };
}

export async function addTrackedPeople(names: string[]): Promise<any[]> {
  const results = [];
  for (const name of names) {
    const existing = await peopleDb.findOneAsync({ name: new RegExp(name, 'i') } as any);
    if (existing) {
      await peopleDb.updateAsync({ _id: (existing as any)._id }, { $set: { trackedBy: true } }, {});
      results.push(existing);
    } else {
      const doc = await peopleDb.insertAsync({
        _id: uuidv4(),
        name,
        email: null, company: null, role: null, bio: null,
        relationshipInsights: [],
        archived: false, trackedBy: true,
        createdAt: new Date().toISOString(),
      });
      results.push(doc);
    }
  }
  return results;
}

export async function archivePerson(id: string): Promise<void> {
  await peopleDb.updateAsync({ _id: id }, { $set: { archived: true } }, {});
}

export async function unarchivePerson(id: string): Promise<void> {
  await peopleDb.updateAsync({ _id: id }, { $set: { archived: false } }, {});
}

export async function getSuggestedPeople(): Promise<any[]> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const recentMeetings = await (meetingsDb as any).findAsync({ date: { $gte: sevenDaysAgo } });

  // Already-tracked people for exclusion
  const allPeople = await peopleDb.findAsync({ archived: { $ne: true } });
  const trackedNames = new Set(allPeople.map((p: any) => (p.name || '').toLowerCase()));

  const frequency: Record<string, { name: string; count: number; meetings: any[] }> = {};
  for (const m of recentMeetings) {
    for (const attendee of (m.attendees || [])) {
      // Exclude current user across all their aliases
      if (isSelf(attendee)) continue;
      const key = attendee.toLowerCase();
      if (!frequency[key]) frequency[key] = { name: attendee, count: 0, meetings: [] };
      frequency[key].count++;
      frequency[key].meetings.push({ _id: m._id, title: m.title, date: m.date });
    }
  }

  // Deduplicate: merge entries that are the same person with different representations
  // e.g. "alex.thaman@live.com" and "Alex Thaman" should merge
  const entries = Object.values(frequency);
  const merged = deduplicateAttendees(entries);

  if (merged.length === 0) return [];

  // 66th percentile threshold
  const sortedCounts = merged.map(p => p.count).sort((a, b) => a - b);
  const p66Index = Math.floor(sortedCounts.length * 0.66);
  const p66Threshold = sortedCounts[p66Index];

  return merged
    .filter(p => p.count >= p66Threshold && !trackedNames.has(p.name.toLowerCase()))
    .sort((a, b) => b.count - a.count)
    .map(p => ({
      name: p.name,
      meetingCount: p.count,
      recentMeetings: p.meetings.slice(-3),
    }));
}

/**
 * Deduplicates attendee entries that likely refer to the same person.
 * Merges by:
 * 1. Email local part matching a display name (e.g. "alex.thaman@..." ↔ "Alex Thaman")
 * 2. One name being a substring of another (e.g. "Alex" ↔ "Alex Thaman")
 * Prefers the human-readable display name over the email address.
 */
function deduplicateAttendees(
  entries: { name: string; count: number; meetings: any[] }[]
): { name: string; count: number; meetings: any[] }[] {
  // Classify each entry
  const isEmail = (s: string) => s.includes('@');
  const emailLocalPart = (s: string) => s.split('@')[0].toLowerCase();
  // "alex.thaman" → "alex thaman", "jane_doe" → "jane doe"
  const normalizeLocal = (s: string) => emailLocalPart(s).replace(/[._\-+]/g, ' ').trim();
  const normalizeName = (s: string) => s.toLowerCase().replace(/[._\-+]/g, ' ').trim();

  // Build merge groups using union-find
  const parent: number[] = entries.map((_, i) => i);
  const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]));
  const union = (a: number, b: number) => { parent[find(a)] = find(b); };

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (find(i) === find(j)) continue;

      const a = entries[i].name;
      const b = entries[j].name;
      const aNorm = normalizeName(a);
      const bNorm = normalizeName(b);

      // Exact normalized match
      if (aNorm === bNorm) { union(i, j); continue; }

      // Email local part matches display name
      if (isEmail(a) && !isEmail(b)) {
        if (normalizeLocal(a) === bNorm || bNorm.includes(normalizeLocal(a)) || normalizeLocal(a).includes(bNorm)) {
          union(i, j); continue;
        }
      }
      if (isEmail(b) && !isEmail(a)) {
        if (normalizeLocal(b) === aNorm || aNorm.includes(normalizeLocal(b)) || normalizeLocal(b).includes(aNorm)) {
          union(i, j); continue;
        }
      }

      // Both emails — compare local parts
      if (isEmail(a) && isEmail(b)) {
        if (normalizeLocal(a) === normalizeLocal(b)) { union(i, j); continue; }
      }

      // Both display names — one contains the other (min 4 chars to avoid false matches)
      if (!isEmail(a) && !isEmail(b) && aNorm.length >= 4 && bNorm.length >= 4) {
        if (aNorm.includes(bNorm) || bNorm.includes(aNorm)) { union(i, j); continue; }
      }
    }
  }

  // Collect groups
  const groups: Record<number, number[]> = {};
  for (let i = 0; i < entries.length; i++) {
    const root = find(i);
    if (!groups[root]) groups[root] = [];
    groups[root].push(i);
  }

  // Merge each group: sum counts, deduplicate meetings, prefer display name over email
  return Object.values(groups).map(indices => {
    // Pick the best display name: prefer non-email, then longest name
    let bestName = entries[indices[0]].name;
    for (const idx of indices) {
      const n = entries[idx].name;
      if (!isEmail(n) && (isEmail(bestName) || n.length > bestName.length)) {
        bestName = n;
      }
    }

    let totalCount = 0;
    const seenMeetingIds = new Set<string>();
    const allMeetings: any[] = [];
    for (const idx of indices) {
      totalCount += entries[idx].count;
      for (const m of entries[idx].meetings) {
        if (!seenMeetingIds.has(m._id)) {
          seenMeetingIds.add(m._id);
          allMeetings.push(m);
        }
      }
    }

    return {
      name: bestName,
      count: allMeetings.length, // deduplicated meeting count
      meetings: allMeetings.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()),
    };
  });
}

export async function getPersonAgendaContext(personId: string): Promise<string | null> {
  const person = await peopleDb.findOneAsync({ _id: personId });
  if (!person) return null;

  const personName = ((person as any).name || '').toLowerCase();
  const personEmail = ((person as any).email || '').toLowerCase();
  const allMeetings = await meetingsDb.findAsync({});
  const personMeetings = allMeetings
    .filter((m: any) =>
      (m.attendees || []).some((a: string) => {
        if (!a) return false;
        const lower = a.toLowerCase();
        return (personName && (lower.includes(personName) || personName.includes(lower))) ||
               (personEmail && (lower.includes(personEmail) || personEmail.includes(lower)));
      })
    )
    .sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const lines: string[] = [];
  lines.push(`Person: ${(person as any).name}`);
  if ((person as any).role) lines.push(`Role: ${(person as any).role}`);
  if ((person as any).bio) lines.push(`Bio: ${(person as any).bio}`);

  const lastMeeting = personMeetings[0];
  if (lastMeeting) {
    const daysSince = Math.floor((Date.now() - new Date(lastMeeting.date).getTime()) / (1000 * 60 * 60 * 24));
    lines.push(`Last meeting: ${daysSince} day${daysSince !== 1 ? 's' : ''} ago ("${lastMeeting.title}")`);
  }
  lines.push(`Total meetings: ${personMeetings.length}`);

  // Recent meeting summaries (last 5)
  const recent = personMeetings.slice(0, 5);
  if (recent.length > 0) {
    lines.push('\n## Recent meetings');
    for (const m of recent) {
      const date = new Date(m.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      lines.push(`- "${m.title}" (${date})`);
      if (m.insights?.summary) lines.push(`  Summary: ${m.insights.summary}`);
      if (m.insights?.decisions?.length) {
        lines.push(`  Decisions: ${m.insights.decisions.map((d: any) => d.text).join('; ')}`);
      }
    }
  }

  // Open action items involving this person
  const openActions: string[] = [];
  for (const m of personMeetings.slice(0, 10)) {
    for (const item of (m.insights?.actionItems || [])) {
      if (item.owner && personName && (personName.includes(item.owner.toLowerCase()) ||
          item.owner.toLowerCase().includes(personName))) {
        openActions.push(`- ${item.text}${item.dueDate ? ` (due ${item.dueDate})` : ''} — from "${m.title}"`);
      }
    }
  }
  if (openActions.length > 0) {
    lines.push(`\n## Open action items assigned to ${(person as any).name}`);
    lines.push(...openActions.slice(0, 8));
  }

  // Commitments
  const commitments: string[] = [];
  for (const m of personMeetings.slice(0, 10)) {
    for (const c of (m.insights?.commitments || [])) {
      if (c.who && personName && (personName.includes(c.who.toLowerCase()) ||
          c.who.toLowerCase().includes(personName))) {
        const overdue = c.deadline && new Date(c.deadline) < new Date() ? ' ⚠ OVERDUE' : '';
        commitments.push(`- ${c.text} (by ${c.who}${c.deadline ? `, deadline ${c.deadline}` : ''})${overdue} — from "${m.title}"`);
      }
    }
  }
  if (commitments.length > 0) {
    lines.push(`\n## Commitments made by ${(person as any).name}`);
    lines.push(...commitments.slice(0, 8));
  }

  // Open tasks from meetings with this person
  const meetingIds = new Set(personMeetings.map((m: any) => m._id));
  const allTasks = await tasksDb.findAsync({ archivedAt: null, status: 'todo' });
  const relevantTasks = (allTasks as any[]).filter(t => {
    const mid = t.source?.id || t.provenance?.meetingId;
    return mid && meetingIds.has(mid);
  });
  if (relevantTasks.length > 0) {
    lines.push('\n## Open tasks from meetings with this person');
    for (const t of relevantTasks.slice(0, 6)) {
      const daysOld = Math.floor((Date.now() - new Date(t.createdAt).getTime()) / (1000 * 60 * 60 * 24));
      lines.push(`- ${t.title} (${t.priority}, open ${daysOld}d)`);
    }
  }

  // Contradictions
  const contradictions: string[] = [];
  for (const m of personMeetings.slice(0, 10)) {
    for (const c of (m.insights?.contradictions || [])) {
      contradictions.push(`- ${c.text} (contradicts: "${c.previousDecision}")`);
    }
  }
  if (contradictions.length > 0) {
    lines.push('\n## Flagged contradictions');
    lines.push(...contradictions.slice(0, 4));
  }

  // Relationship insights
  if ((person as any).relationshipInsights?.length) {
    lines.push('\n## Relationship insights');
    for (const r of (person as any).relationshipInsights) {
      lines.push(`- ${r}`);
    }
  }

  return lines.join('\n');
}

export async function getMeetingAgendaContext(meetingTitle: string, attendeeNames: string[]): Promise<string> {
  const allMeetings = await meetingsDb.findAsync({});
  const allPeople = await peopleDb.findAsync({ archived: { $ne: true } });

  const lines: string[] = [];
  lines.push(`Upcoming meeting: "${meetingTitle}"`);
  lines.push(`Attendees: ${attendeeNames.length > 0 ? attendeeNames.join(', ') : 'unknown'}`);

  // For each attendee, gather their recent context
  for (const name of attendeeNames) {
    const person = (allPeople as any[]).find(p => name.toLowerCase().includes(p.name.toLowerCase()) || p.name.toLowerCase().includes(name.toLowerCase()));

    const personMeetings = allMeetings
      .filter((m: any) =>
        (m.attendees || []).some((a: string) => a.toLowerCase().includes(name.toLowerCase()))
      )
      .sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());

    if (personMeetings.length === 0 && !person) continue;

    lines.push(`\n## ${name}${person?.role ? ` (${person.role})` : ''}`);

    // Last meeting with this person
    if (personMeetings.length > 0) {
      const last = personMeetings[0];
      const daysSince = Math.floor((Date.now() - new Date(last.date).getTime()) / (1000 * 60 * 60 * 24));
      lines.push(`Last met: ${daysSince}d ago ("${last.title}")`);
    }

    // Recent summaries (last 3 meetings)
    for (const m of personMeetings.slice(0, 3)) {
      const date = new Date(m.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      if (m.insights?.summary) lines.push(`- ${date}: ${m.insights.summary}`);
      if (m.insights?.decisions?.length) {
        lines.push(`  Decisions: ${m.insights.decisions.map((d: any) => d.text).join('; ')}`);
      }
    }

    // Open action items for this attendee
    const actions: string[] = [];
    for (const m of personMeetings.slice(0, 5)) {
      for (const item of (m.insights?.actionItems || [])) {
        if (item.owner && (name.toLowerCase().includes(item.owner.toLowerCase()) || item.owner.toLowerCase().includes(name.toLowerCase()))) {
          actions.push(`- ${item.text}${item.dueDate ? ` (due ${item.dueDate})` : ''}`);
        }
      }
    }
    if (actions.length > 0) {
      lines.push(`Open action items:`);
      lines.push(...actions.slice(0, 5));
    }

    // Commitments from this attendee
    const commitments: string[] = [];
    for (const m of personMeetings.slice(0, 5)) {
      for (const c of (m.insights?.commitments || [])) {
        if (c.who && (name.toLowerCase().includes(c.who.toLowerCase()) || c.who.toLowerCase().includes(name.toLowerCase()))) {
          const overdue = c.deadline && new Date(c.deadline) < new Date() ? ' ⚠ OVERDUE' : '';
          commitments.push(`- ${c.text}${c.deadline ? ` (deadline ${c.deadline})` : ''}${overdue}`);
        }
      }
    }
    if (commitments.length > 0) {
      lines.push(`Commitments:`);
      lines.push(...commitments.slice(0, 5));
    }
  }

  // Prior meetings with the same title pattern (for recurring meetings)
  const titleWords = meetingTitle.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  if (titleWords.length > 0) {
    const priorSameTitle = allMeetings
      .filter((m: any) => {
        const t = (m.title || '').toLowerCase();
        return titleWords.some(w => t.includes(w)) && m.insights?.summary;
      })
      .sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, 3);

    if (priorSameTitle.length > 0) {
      lines.push('\n## Previous meetings with similar title');
      for (const m of priorSameTitle) {
        const date = new Date(m.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        lines.push(`- "${m.title}" (${date}): ${m.insights.summary}`);
      }
    }
  }

  return lines.join('\n');
}

export async function updatePersonProfile(id: string, updates: { bio?: string; relationshipInsights?: string[] }): Promise<void> {
  await peopleDb.updateAsync({ _id: id }, { $set: updates }, {});
}

// ── Voice Prints ──────────────────────────────────────────────────────────────

export async function saveVoicePrint(data: {
  name: string;
  audioClip: Buffer;
  isUser: boolean;
  personId?: string;
  embedding?: number[];
}): Promise<string> {
  // If isUser, replace any existing user voice print
  if (data.isUser) {
    await voicePrintsDb.removeAsync({ isUser: true }, { multi: true });
  }
  const doc = await voicePrintsDb.insertAsync({
    _id: uuidv4(),
    name: data.name,
    audioClip: data.audioClip,
    isUser: data.isUser,
    personId: data.personId || null,
    embedding: data.embedding || null,
    createdAt: new Date().toISOString(),
  });
  return (doc as any)._id;
}

export async function getVoicePrints(): Promise<any[]> {
  const prints = await voicePrintsDb.findAsync({});
  return prints.map((p: any) => ({
    _id: p._id,
    name: p.name,
    isUser: p.isUser,
    personId: p.personId,
    createdAt: p.createdAt,
    hasAudio: !!p.audioClip,
    hasEmbedding: !!p.embedding,
  }));
}

export async function getVoicePrintsWithEmbeddings(): Promise<any[]> {
  const prints = await voicePrintsDb.findAsync({ embedding: { $ne: null } });
  return prints.map((p: any) => ({
    _id: p._id,
    name: p.name,
    isUser: p.isUser,
    embedding: p.embedding,
  }));
}

export async function getVoicePrint(id: string): Promise<any> {
  return voicePrintsDb.findOneAsync({ _id: id });
}

export async function getUserVoicePrint(): Promise<any> {
  return voicePrintsDb.findOneAsync({ isUser: true });
}

export async function getVoicePrintByName(name: string): Promise<any> {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return voicePrintsDb.findOneAsync({ name: new RegExp(`^${escaped}$`, 'i') } as any);
}

export async function deleteVoicePrint(id: string): Promise<void> {
  await voicePrintsDb.removeAsync({ _id: id }, {});
}
