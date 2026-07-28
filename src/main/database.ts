import * as path from 'path';
import { app } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import Datastore from '@seald-io/nedb';
import { getConfig } from './config';
import { isSelf } from './self-identity';
import { fuzzyNameScore, normalizeNameStr, SAME_PERSON_THRESHOLD, REVIEW_THRESHOLD } from './fuzzy-name';
import { log } from './logger';
import {
  decideMention, computeRepetitionNudge, providerModelLabel,
  TaskMention, MentionSourceType,
} from './task-dedup';
import { initMatchDecisionLog, logMatchDecision } from './match-decision-log';

let meetingsDb: Datastore;
let tasksDb: Datastore;
let peopleDb: Datastore;
let voicePrintsDb: Datastore;
let credentialsDb: Datastore;

export function initDatabase(): void {
  const userDataPath = app.getPath('userData');
  meetingsDb = new Datastore({ filename: path.join(userDataPath, 'meetings.db'), autoload: true });
  tasksDb = new Datastore({ filename: path.join(userDataPath, 'tasks.db'), autoload: true });
  peopleDb = new Datastore({ filename: path.join(userDataPath, 'people.db'), autoload: true });
  voicePrintsDb = new Datastore({ filename: path.join(userDataPath, 'voiceprints.db'), autoload: true });
  credentialsDb = new Datastore({ filename: path.join(userDataPath, 'credentials.db'), autoload: true });
  initMatchDecisionLog();
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

/**
 * Find a desktop recording for the same meeting created within `windowMs`,
 * so late-arriving audio segments merge into it instead of becoming fragments.
 */
export async function findRecentRecordingMeeting(title: string, calendarEventId: string | undefined, windowMs: number): Promise<any | null> {
  const cutoff = new Date(Date.now() - windowMs).toISOString();
  const candidates: any[] = await (meetingsDb as any)
    .findAsync({ title, source: 'desktop_recording', createdAt: { $gte: cutoff } })
    .sort({ createdAt: -1 });
  if (calendarEventId) {
    return candidates.find(m => !m.calendarEventId || m.calendarEventId === calendarEventId) || null;
  }
  return candidates[0] || null;
}

export async function appendMeetingTranscript(id: string, transcript: string, addedDuration: number): Promise<void> {
  const m: any = await meetingsDb.findOneAsync({ _id: id });
  const combined = m?.transcript ? `${m.transcript}\n${transcript}` : transcript;
  await meetingsDb.updateAsync(
    { _id: id },
    { $set: { transcript: combined, duration: (m?.duration || 0) + addedDuration, status: 'transcribed' } },
    {}
  );
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

  // Auto-create tasks from action items. Re-processing a meeting (e.g. merged
  // segments) replaces its still-pending auto-extracted tasks instead of duplicating.
  await (tasksDb as any).removeAsync(
    { 'source.id': meetingId, aiExtracted: true, 'approval.status': 'pending' },
    { multi: true }
  );

  // Dedup context for this meeting's mentions (task-dedup PRD US-013): the
  // source meeting (attendee overlap + recurring-series signals) plus all
  // candidate tasks and their source meetings.
  const sourceMeeting: any = await meetingsDb.findOneAsync({ _id: meetingId });
  const dedupTasks = await getAllTasksForDedup();
  const meetingsById = await getMeetingsById();

  for (const item of insights.actionItems) {
    const now = new Date().toISOString();
    const mention: TaskMention = {
      id: uuidv4(),
      sourceType: 'meeting',
      sourceId: meetingId,
      sourceTitle: sourceMeeting?.title || 'Meeting',
      excerpt: item.text,
      occurredAt: sourceMeeting?.date || now,
    };

    // Decide whether this action item is a repeat mention of an existing task.
    // Any failure here degrades to plain creation — never blocks the task.
    let decision: Awaited<ReturnType<typeof decideMention>> = { kind: 'none' };
    try {
      decision = await decideMention(
        { title: item.text, description: '' },
        dedupTasks,
        { sourceMeeting, meetingsById },
      );
    } catch (e: any) {
      log('error', 'task-dedup:decide-failed', e?.message || String(e));
    }

    if (decision.kind === 'auto_merge') {
      await appendTaskMention(decision.taskId, {
        ...mention,
        mergedItem: {
          title: item.text,
          description: '',
          owner: item.owner || null,
          deadline: item.dueDate || null,
        },
      });
      await logMatchDecision({
        decisionType: 'auto_merge',
        confidence: decision.confidence,
        retrievalScore: decision.retrievalScore,
        candidateTaskId: decision.taskId,
        taskId: decision.taskId,
        newItemText: item.text,
        decidedBy: 'system',
        surface: 'oss',
      });
      continue; // no new task
    }

    const doc: Record<string, any> = {
      _id: uuidv4(),
      title: item.text,
      description: '',
      status: 'todo',
      priority: item.priority || 'medium',
      dueDate: item.dueDate || null,
      owner: item.owner || null,
      source: { type: 'meeting', id: meetingId },
      aiExtracted: true,
      approval: { status: 'pending' },
      provenance: {
        meetingId,
        extractionMethod: 'transcript_analysis',
        extractedAt: now,
      },
      taskMentions: [mention],
      mentionCount: 1,
      archivedAt: null,
      createdAt: now,
    };

    if (decision.kind === 'ask') {
      // Ask-band: the extracted task is already headed for the review surface,
      // so the classifier result rides along on the pending task instead of a
      // separate pending-match record (US-007/US-013 binding decision).
      doc.dedupSuggestion = {
        candidateTaskId: decision.taskId,
        candidateTitle: decision.taskTitle,
        wasDone: decision.wasDone,
        confidence: decision.confidence,
        retrievalScore: decision.retrievalScore,
        model: providerModelLabel(),
      };
    } else if (decision.kind === 'new') {
      await logMatchDecision({
        decisionType: 'below_ask_new',
        confidence: decision.confidence,
        retrievalScore: decision.retrievalScore,
        candidateTaskId: decision.candidateTaskId,
        taskId: doc._id,
        newItemText: item.text,
        decidedBy: 'system',
        surface: 'oss',
      });
    }

    await tasksDb.insertAsync(doc);
  }

}

/** All non-archived tasks (open + done) — dedup retrieval scope input. */
export async function getAllTasksForDedup(): Promise<any[]> {
  return tasksDb.findAsync({ archivedAt: null });
}

/** All meetings keyed by _id — dedup context-signal input. */
export async function getMeetingsById(): Promise<Map<string, any>> {
  const all: any[] = await meetingsDb.findAsync({});
  return new Map(all.map(m => [m._id, m]));
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
  source?: string;
  externalId?: string;
  sourceMetadata?: Record<string, any>;
}): Promise<any> {
  const source = data.source || 'manual_upload';

  if (data.externalId) {
    const existing = await meetingsDb.findOneAsync({ source, externalId: data.externalId });
    if (existing) {
      await meetingsDb.updateAsync(
        { _id: (existing as any)._id },
        {
          $set: {
            title: data.title,
            date: data.date,
            transcript: data.content,
            status: 'pending',
            sourceMetadata: data.sourceMetadata || null,
            updatedAt: new Date().toISOString(),
          },
        },
        {},
      );
      return meetingsDb.findOneAsync({ _id: (existing as any)._id });
    }
  }

  const doc = await meetingsDb.insertAsync({
    _id: uuidv4(),
    title: data.title,
    date: data.date,
    duration: 0,
    attendees: [],
    transcript: data.content,
    status: 'pending',
    source,
    externalId: data.externalId || null,
    sourceMetadata: data.sourceMetadata || null,
    calendarEventId: null,
    insights: null,
    createdAt: new Date().toISOString(),
  });
  return doc;
}

// ── Voice memos ──────────────────────────────────────────────────────────────
// A memo is a meeting doc (source 'voice_memo') so it lists in the Meetings day
// timeline for free; the applied items ride along under `voiceMemo`.

export async function createVoiceMemo(data: {
  transcript: string;
  durationSec: number;
  audioPath: string | null;
  items: any[];
}): Promise<any> {
  const now = new Date().toISOString();
  return meetingsDb.insertAsync({
    _id: uuidv4(),
    title: 'Voice note',
    date: now,
    duration: data.durationSec || 0,
    attendees: [],
    transcript: data.transcript,
    status: 'processed',
    source: 'voice_memo',
    sourceMetadata: data.audioPath ? { audioPath: data.audioPath } : null,
    calendarEventId: null,
    insights: null,
    voiceMemo: { items: data.items, appliedAt: now },
    createdAt: now,
  });
}

/**
 * Tasks born from a reviewed voice memo: the review sheet is the confirm gate,
 * so they land approved and never re-enter the Review inbox.
 */
export async function createVoiceMemoTask(memoId: string, item: {
  title: string;
  details?: string;
  owner?: string | null;
  dueDate?: string | null;
  priority?: string;
}): Promise<any> {
  const now = new Date().toISOString();
  return tasksDb.insertAsync({
    _id: uuidv4(),
    title: item.title,
    description: item.details || '',
    status: 'todo',
    priority: item.priority || 'medium',
    dueDate: item.dueDate || null,
    owner: item.owner || null,
    source: { type: 'voice_memo', id: memoId },
    aiExtracted: true,
    approval: { status: 'approved', approvedAt: now },
    provenance: { meetingId: memoId, extractionMethod: 'voice_memo', extractedAt: now },
    taskMentions: [{
      id: uuidv4(),
      sourceType: 'voice_note',
      sourceId: memoId,
      sourceTitle: 'Voice note',
      excerpt: item.title,
      occurredAt: now,
    } as TaskMention],
    mentionCount: 1,
    archivedAt: null,
    snoozedAt: null,
    snoozedReason: null,
    lastMentionedAt: null,
    likelyDone: false,
    createdAt: now,
    updatedAt: now,
  });
}

// ── Calendar Sync ────────────────────────────────────────────────────────────

export async function syncCalendarEventsToDb(events: {
  id: string;
  title: string;
  startTime: Date;
  endTime: Date;
  attendees: string[];
  /** Bare recurring-series UID (OQ4) — null for one-off events. */
  seriesUid?: string | null;
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
        { $set: { title: event.title, attendees: event.attendees, date, duration, seriesUid: event.seriesUid ?? null } },
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
        seriesUid: event.seriesUid ?? null,
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
  // Computed, never persisted: "Raised N× this week" chip data (US-014).
  const annotated = tasks.map((t: any) => ({ ...t, repetitionNudge: computeRepetitionNudge(t) }));
  return sortTasks(annotated);
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
  owner?: string;
}): Promise<any> {
  const now = new Date().toISOString();
  const doc = await tasksDb.insertAsync({
    _id: uuidv4(),
    title: data.title,
    description: data.description || '',
    status: data.status || 'todo',
    priority: data.priority || 'medium',
    dueDate: data.dueDate || null,
    owner: data.owner || null,
    source: { type: 'manual' },
    aiExtracted: false,
    approval: { status: 'auto_approved' },
    taskMentions: [],
    mentionCount: 0,
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

// ── Task mentions / dedup merge machinery (task-dedup PRD) ───────────────────

/**
 * Pre-feature tasks have no taskMentions array. Before appending a second
 * mention, synthesize the originating mention from the task's singular source
 * so the thread shows the full history.
 */
function synthesizeOriginatingMention(task: any): TaskMention | null {
  const type = task?.source?.type;
  if (type !== 'meeting' && type !== 'voice_memo') return null;
  return {
    id: uuidv4(),
    sourceType: (type === 'voice_memo' ? 'voice_note' : 'meeting') as MentionSourceType,
    sourceId: task.source?.id || null,
    sourceTitle: type === 'voice_memo' ? 'Voice note' : null,
    excerpt: task.title || '',
    occurredAt: task.createdAt || new Date().toISOString(),
  };
}

/**
 * Append a mention to an existing task (auto-merge / confirmed merge). Bumps
 * mentionCount + lastMentionedAt; `reopen: true` also flips a done task back
 * to todo (only ever on the user's explicit "Reopen and merge", US-008).
 * Idempotent per (sourceId, excerpt) so re-processed meetings don't double-append.
 */
export async function appendTaskMention(
  taskId: string,
  mention: TaskMention,
  opts?: { reopen?: boolean },
): Promise<any> {
  const task: any = await tasksDb.findOneAsync({ _id: taskId });
  if (!task) return null;

  let mentions: TaskMention[] = Array.isArray(task.taskMentions) ? [...task.taskMentions] : [];
  if (mentions.length === 0) {
    const origin = synthesizeOriginatingMention(task);
    if (origin) mentions.push(origin);
  }
  const duplicate = mentions.some(m => m.sourceId === mention.sourceId && m.excerpt === mention.excerpt);
  if (!duplicate) {
    mentions.push({ ...mention, id: mention.id || uuidv4() });
  }

  const now = new Date().toISOString();
  const updates: Record<string, any> = {
    taskMentions: mentions,
    mentionCount: mentions.length,
    lastMentionedAt: mention.occurredAt || now,
    updatedAt: now,
  };
  if (opts?.reopen && (task.status === 'done' || task.status === 'completed')) {
    updates.status = 'todo';
    updates.likelyDone = false;
  }
  await tasksDb.updateAsync({ _id: taskId }, { $set: updates }, {});
  return tasksDb.findOneAsync({ _id: taskId });
}

/**
 * Manual merge (US-010): the losing task's mentions move into the survivor's
 * thread; the loser is archived (never deleted) with a pointer back.
 */
export async function mergeTasksManual(survivorId: string, loserId: string): Promise<any> {
  const survivor: any = await tasksDb.findOneAsync({ _id: survivorId });
  const loser: any = await tasksDb.findOneAsync({ _id: loserId });
  if (!survivor || !loser || survivorId === loserId) return null;

  const survivorMentions: TaskMention[] = Array.isArray(survivor.taskMentions) ? [...survivor.taskMentions] : [];
  if (survivorMentions.length === 0) {
    const origin = synthesizeOriginatingMention(survivor);
    if (origin) survivorMentions.push(origin);
  }

  let loserMentions: TaskMention[] = Array.isArray(loser.taskMentions) ? [...loser.taskMentions] : [];
  if (loserMentions.length === 0) {
    const origin = synthesizeOriginatingMention(loser);
    loserMentions = origin ? [origin] : [{
      id: uuidv4(),
      sourceType: 'meeting',
      sourceId: null,
      sourceTitle: null,
      excerpt: loser.title || '',
      occurredAt: loser.createdAt || new Date().toISOString(),
    }];
  }
  // Every absorbed mention carries a snapshot so undo/split can resurrect it.
  for (const m of loserMentions) {
    if (!m.mergedItem) {
      m.mergedItem = {
        title: loser.title || m.excerpt || '',
        description: loser.description || '',
        owner: loser.owner || null,
        deadline: loser.dueDate || null,
      };
    }
    if (!survivorMentions.some(sm => sm.id === m.id)) survivorMentions.push(m);
  }

  const now = new Date().toISOString();
  const lastMentioned = survivorMentions
    .map(m => m.occurredAt)
    .filter(Boolean)
    .sort()
    .pop() || now;
  await tasksDb.updateAsync(
    { _id: survivorId },
    { $set: { taskMentions: survivorMentions, mentionCount: survivorMentions.length, lastMentionedAt: lastMentioned, updatedAt: now } },
    {},
  );
  await tasksDb.updateAsync(
    { _id: loserId },
    { $set: { archivedAt: now, mergedInto: survivorId, updatedAt: now } },
    {},
  );

  await logMatchDecision({
    decisionType: 'manual_merge',
    candidateTaskId: survivorId,
    taskId: loserId,
    newItemText: loser.title || '',
    decidedBy: 'user',
    surface: 'oss',
  });

  return tasksDb.findOneAsync({ _id: survivorId });
}

/**
 * Undo/split (US-010): extract a merged mention back into a standalone task
 * built from its mergedItem snapshot (or excerpt). Logged as a strong negative
 * signal when the mention arrived via auto-merge.
 */
export async function undoSplitMention(taskId: string, mentionId: string): Promise<any> {
  const task: any = await tasksDb.findOneAsync({ _id: taskId });
  if (!task) return null;
  const mentions: TaskMention[] = Array.isArray(task.taskMentions) ? [...task.taskMentions] : [];
  const idx = mentions.findIndex(m => m.id === mentionId);
  if (idx === -1) return null;
  const [mention] = mentions.splice(idx, 1);

  const now = new Date().toISOString();
  const snapshot = mention.mergedItem;
  const newDoc = await tasksDb.insertAsync({
    _id: uuidv4(),
    title: snapshot?.title || mention.excerpt || task.title,
    description: snapshot?.description || '',
    status: 'todo',
    priority: task.priority || 'medium',
    dueDate: snapshot?.deadline || null,
    owner: snapshot?.owner || null,
    source: {
      type: mention.sourceType === 'voice_note' ? 'voice_memo' : 'meeting',
      ...(mention.sourceId ? { id: mention.sourceId } : {}),
    },
    aiExtracted: true,
    approval: { status: 'approved', approvedAt: now },
    provenance: mention.sourceId
      ? { meetingId: mention.sourceId, extractionMethod: 'undo_split', extractedAt: now }
      : { extractionMethod: 'undo_split', extractedAt: now },
    taskMentions: [{ ...mention, mergedItem: undefined }],
    mentionCount: 1,
    archivedAt: null,
    snoozedAt: null,
    snoozedReason: null,
    lastMentionedAt: mention.occurredAt || null,
    likelyDone: false,
    createdAt: now,
    updatedAt: now,
  });

  await tasksDb.updateAsync(
    { _id: taskId },
    { $set: { taskMentions: mentions, mentionCount: mentions.length, updatedAt: now } },
    {},
  );

  await logMatchDecision({
    decisionType: 'undo_split',
    candidateTaskId: taskId,
    taskId: (newDoc as any)._id,
    newItemText: (newDoc as any).title,
    decidedBy: 'user',
    surface: 'oss',
  });

  return newDoc;
}

/**
 * Resolve an ask-band suggestion riding on a pending extracted task (US-007).
 * - 'same'  → merge the pending task into the candidate as a mention, drop the pending task
 * - 'reopen'→ same, but also reopens the recently-done candidate (US-008 / OQ5)
 * - 'new'   → keep the pending task, clear the suggestion (negative example)
 */
export async function resolvePendingDedup(taskId: string, action: 'same' | 'new' | 'reopen'): Promise<{ ok: boolean; mergedInto?: string }> {
  const task: any = await tasksDb.findOneAsync({ _id: taskId });
  if (!task || !task.dedupSuggestion) return { ok: false };
  const sug = task.dedupSuggestion;

  if (action === 'new') {
    await tasksDb.updateAsync({ _id: taskId }, { $unset: { dedupSuggestion: true }, $set: { updatedAt: new Date().toISOString() } }, {});
    await logMatchDecision({
      decisionType: 'confirm_new',
      confidence: sug.confidence ?? null,
      retrievalScore: sug.retrievalScore ?? null,
      candidateTaskId: sug.candidateTaskId ?? null,
      taskId,
      newItemText: task.title || '',
      decidedBy: 'user',
      surface: 'oss',
    });
    return { ok: true };
  }

  const mention: TaskMention = (task.taskMentions && task.taskMentions[0])
    ? { ...task.taskMentions[0] }
    : {
        id: uuidv4(),
        sourceType: (task.source?.type === 'voice_memo' ? 'voice_note' : 'meeting') as MentionSourceType,
        sourceId: task.source?.id || null,
        excerpt: task.title || '',
        occurredAt: task.createdAt || new Date().toISOString(),
      };
  mention.mergedItem = {
    title: task.title || '',
    description: task.description || '',
    owner: task.owner || null,
    deadline: task.dueDate || null,
  };

  const merged = await appendTaskMention(sug.candidateTaskId, mention, { reopen: action === 'reopen' });
  if (!merged) return { ok: false };
  await tasksDb.removeAsync({ _id: taskId }, {});

  await logMatchDecision({
    decisionType: action === 'reopen' ? 'reopen_merge' : 'confirm_same',
    confidence: sug.confidence ?? null,
    retrievalScore: sug.retrievalScore ?? null,
    candidateTaskId: sug.candidateTaskId,
    taskId: sug.candidateTaskId,
    newItemText: task.title || '',
    decidedBy: 'user',
    surface: 'oss',
  });

  return { ok: true, mergedInto: sug.candidateTaskId };
}

/** One-step priority bump from the repetition nudge (US-014). Explicit tap only. */
export async function bumpTaskPriority(taskId: string): Promise<any> {
  const order = ['low', 'medium', 'high', 'critical'];
  const task: any = await tasksDb.findOneAsync({ _id: taskId });
  if (!task) return null;
  const idx = order.indexOf(task.priority || 'medium');
  const next = order[Math.min(order.length - 1, Math.max(0, idx) + 1)];
  await tasksDb.updateAsync({ _id: taskId }, { $set: { priority: next, updatedAt: new Date().toISOString() } }, {});
  return tasksDb.findOneAsync({ _id: taskId });
}

/** Dismiss the repetition chip until the mention count grows again (US-014). */
export async function dismissTaskNudge(taskId: string): Promise<void> {
  const task: any = await tasksDb.findOneAsync({ _id: taskId });
  if (!task) return;
  const count = Array.isArray(task.taskMentions) ? task.taskMentions.length : (task.mentionCount || 0);
  await tasksDb.updateAsync({ _id: taskId }, { $set: { nudgeDismissedAtCount: count, updatedAt: new Date().toISOString() } }, {});
}

// Test-only: inject an in-memory Datastore so helpers can be exercised without
// booting Electron. Do NOT call from production code.
export function __setTasksDbForTests(db: Datastore): void {
  tasksDb = db;
}

export function __setMeetingsDbForTests(db: Datastore): void {
  meetingsDb = db;
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
    const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.$or = [{ name: re }, { email: re }, { company: re }];
  }
  const people = await peopleDb.findAsync(query);
  // The user is not a "person you meet with" — keep them out of the People list.
  const others = people.filter((p: any) => !isSelf(p.name || '') && !isSelf(p.email || ''));
  return Promise.all(others.map(computePeopleStats));
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
  // Match meetings under every identity this person is known by — primary
  // name/email plus aliases absorbed from merged duplicate records.
  const identities = [
    personName, personEmail,
    ...((((person as any).altNames || []) as string[]).map(s => s.toLowerCase())),
    ...((((person as any).altEmails || []) as string[]).map(s => s.toLowerCase())),
  ].filter(Boolean);
  const allMeetings = await meetingsDb.findAsync({});
  const personMeetings = allMeetings
    .filter((m: any) =>
      (m.attendees || []).some((a: string) => {
        if (!a) return false;
        const lower = a.toLowerCase();
        return identities.some(idn => lower.includes(idn) || idn.includes(lower));
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

  // Dedup: an existing person with the same email, or a fuzzy-matching name
  // (nicknames, initials, typos — same matcher as the cloud contact graph),
  // is the same person — update them instead of inserting a duplicate.
  // A prior "keep separate" decision (notSameAs) always wins.
  const email = (data.email || '').trim().toLowerCase();
  const all = await peopleDb.findAsync({});
  const existing = (all as any[]).find(p =>
    (email && ((p.email || '').trim().toLowerCase() === email ||
      (p.altEmails || []).some((e: string) => (e || '').trim().toLowerCase() === email))) ||
    (name && !(p.notSameAs || []).some((n: string) => normalizeNameStr(n) === normalizeNameStr(name)) &&
      (fuzzyNameScore(p.name, name) >= SAME_PERSON_THRESHOLD ||
        (p.altNames || []).some((n: string) => fuzzyNameScore(n, name) >= SAME_PERSON_THRESHOLD)))
  );
  if (existing) {
    const patch: Record<string, any> = { trackedBy: true, archived: false };
    if (!existing.email && data.email) patch.email = data.email;
    if (!existing.notes && data.notes) patch.notes = data.notes;
    await peopleDb.updateAsync({ _id: existing._id }, { $set: patch }, {});
    return { ...existing, ...patch, retroactiveMeetingCount: retroMeetings.length, deduped: true };
  }

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
    // Exact match first (current name or a merged-away alias), then fuzzy
    // (nicknames/initials/typos) at the same-person threshold, honoring
    // prior "keep separate" decisions.
    const target = normalizeNameStr(name);
    const all = await peopleDb.findAsync({});
    let existing = (all as any[]).find(p =>
      normalizeNameStr(p.name) === target || (p.altNames || []).some((n: string) => normalizeNameStr(n) === target)
    ) || null;
    if (!existing) {
      existing = (all as any[]).find(p =>
        !(p.notSameAs || []).some((n: string) => normalizeNameStr(n) === normalizeNameStr(name)) &&
        (fuzzyNameScore(p.name, name) >= SAME_PERSON_THRESHOLD ||
          (p.altNames || []).some((n: string) => fuzzyNameScore(n, name) >= SAME_PERSON_THRESHOLD))
      ) || null;
    }
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

/**
 * One-time repair for duplicate person records (same trimmed case-insensitive
 * name). Keeps the oldest record, fills its empty fields from the duplicates
 * (email, company, role, bio, notes), ORs trackedBy, un-archives if any copy
 * was active, and deletes the rest. Returns how many duplicates were removed.
 */
export async function dedupePeopleByName(): Promise<number> {
  const all = await peopleDb.findAsync({});
  const byName = new Map<string, any[]>();
  for (const p of all as any[]) {
    const key = (p.name || '').trim().toLowerCase();
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key)!.push(p);
  }
  let removed = 0;
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    const keeper = group[0];
    const patch: Record<string, any> = {};
    for (const dup of group.slice(1)) {
      for (const field of ['email', 'company', 'role', 'bio', 'notes'] as const) {
        if (!keeper[field] && !patch[field] && dup[field]) patch[field] = dup[field];
      }
      if (dup.trackedBy) patch.trackedBy = true;
      if (dup.archived === false) patch.archived = false;
      await peopleDb.removeAsync({ _id: dup._id }, {});
      removed++;
    }
    if (Object.keys(patch).length) {
      await peopleDb.updateAsync({ _id: keeper._id }, { $set: patch }, {});
    }
  }
  return removed;
}

/**
 * Fuzzy merge candidates for human triage: pairs of active people whose names
 * score in [REVIEW_THRESHOLD, 1) and who haven't been marked "not the same".
 * Auto-merge never happens at this band — the Review inbox decides.
 */
export async function getPersonMergeCandidates(): Promise<Array<{ a: any; b: any; score: number }>> {
  const people = (await peopleDb.findAsync({ archived: { $ne: true } })) as any[];
  const out: Array<{ a: any; b: any; score: number }> = [];
  for (let i = 0; i < people.length; i++) {
    for (let j = i + 1; j < people.length; j++) {
      const a = people[i], b = people[j];
      if (!a.name || !b.name) continue;
      // Different explicit emails = different identities unless names are identical
      const ea = (a.email || '').trim().toLowerCase();
      const eb = (b.email || '').trim().toLowerCase();
      const score = fuzzyNameScore(a.name, b.name);
      if (score >= 1 && ea && eb && ea !== eb) continue; // exact dupes with distinct emails still triage below
      if (score < REVIEW_THRESHOLD) continue;
      const aNot = (a.notSameAs || []).some((n: string) => normalizeNameStr(n) === normalizeNameStr(b.name));
      const bNot = (b.notSameAs || []).some((n: string) => normalizeNameStr(n) === normalizeNameStr(a.name));
      if (aNot || bNot) continue;
      const pick = (p: any) => ({ _id: p._id, name: p.name, email: p.email, company: p.company, role: p.role });
      out.push({ a: pick(a), b: pick(b), score });
    }
  }
  return out.sort((x, y) => y.score - x.score).slice(0, 10);
}

/** Merge person `dropId` into `keepId`: fill empty fields, OR flags, delete the duplicate. */
export async function mergePeople(keepId: string, dropId: string): Promise<void> {
  const keep = await peopleDb.findOneAsync({ _id: keepId }) as any;
  const drop = await peopleDb.findOneAsync({ _id: dropId }) as any;
  if (!keep || !drop) return;
  const patch: Record<string, any> = {};
  for (const field of ['email', 'company', 'role', 'bio', 'notes'] as const) {
    if (!keep[field] && drop[field]) patch[field] = drop[field];
  }
  if (drop.trackedBy) patch.trackedBy = true;
  if (drop.archived === false) patch.archived = false;
  const insights = [...(keep.relationshipInsights || []), ...(drop.relationshipInsights || [])];
  if (insights.length) patch.relationshipInsights = [...new Set(insights)];
  // Never lose an identity: the dropped record's name/email become aliases so
  // meeting-attendee matching still finds this person under either identity.
  if (drop.name && normalizeNameStr(drop.name) !== normalizeNameStr(keep.name)) {
    patch.altNames = [...new Set([...(keep.altNames || []), drop.name])];
  }
  const dropEmail = (drop.email || '').trim().toLowerCase();
  if (dropEmail && dropEmail !== (keep.email || '').trim().toLowerCase()) {
    patch.altEmails = [...new Set([...(keep.altEmails || []), drop.email])];
  }
  if (Object.keys(patch).length) {
    await peopleDb.updateAsync({ _id: keepId }, { $set: patch }, {});
  }
  await peopleDb.removeAsync({ _id: dropId }, {});
  // Voiceprints named after the dropped spelling keep working — rename to the kept name.
  const prints = await voicePrintsDb.findAsync({}) as any[];
  for (const vp of prints) {
    if (vp.name && normalizeNameStr(vp.name) === normalizeNameStr(drop.name) && keep.name) {
      await voicePrintsDb.updateAsync({ _id: vp._id }, { $set: { name: keep.name } }, {});
    }
  }
}

/** Record a "these are different people" decision so the pair is never re-suggested. */
export async function markNotSamePerson(idA: string, idB: string): Promise<void> {
  const a = await peopleDb.findOneAsync({ _id: idA }) as any;
  const b = await peopleDb.findOneAsync({ _id: idB }) as any;
  if (!a || !b) return;
  await peopleDb.updateAsync({ _id: idA }, { $set: { notSameAs: [...new Set([...(a.notSameAs || []), b.name])] } }, {});
  await peopleDb.updateAsync({ _id: idB }, { $set: { notSameAs: [...new Set([...(b.notSameAs || []), a.name])] } }, {});
}

/**
 * One-time repair: calendar-sync created duplicate meeting rows for the same
 * (calendarEventId, date) before the idempotency check existed. Keep the row
 * with a transcript/insights (or the oldest bare row), delete the rest.
 */
export async function dedupeCalendarSyncMeetings(): Promise<number> {
  const all = (await meetingsDb.findAsync({})) as any[];
  const byKey = new Map<string, any[]>();
  for (const m of all) {
    if (!m.calendarEventId) continue;
    const key = `${m.calendarEventId}|${m.date}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(m);
  }
  let removed = 0;
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const score = (m: any) => (m.insights ? 2 : 0) + (m.transcript ? 1 : 0);
    group.sort((a, b) => score(b) - score(a) || String(a.createdAt || a.date).localeCompare(String(b.createdAt || b.date)));
    for (const dup of group.slice(1)) {
      // Never delete a row that holds real content the keeper lacks
      if (score(dup) > 0 && score(dup) >= score(group[0])) continue;
      await meetingsDb.removeAsync({ _id: dup._id }, {});
      removed++;
    }
  }
  return removed;
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
  const trackedNames = new Set<string>();
  for (const p of allPeople as any[]) {
    if (p.name) trackedNames.add(p.name.toLowerCase());
    for (const alt of p.altNames || []) trackedNames.add((alt || '').toLowerCase());
  }

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
  // Match meetings under every identity this person is known by — primary
  // name/email plus aliases absorbed from merged duplicate records.
  const identities = [
    personName, personEmail,
    ...((((person as any).altNames || []) as string[]).map(s => s.toLowerCase())),
    ...((((person as any).altEmails || []) as string[]).map(s => s.toLowerCase())),
  ].filter(Boolean);
  const allMeetings = await meetingsDb.findAsync({});
  const personMeetings = allMeetings
    .filter((m: any) =>
      (m.attendees || []).some((a: string) => {
        if (!a) return false;
        const lower = a.toLowerCase();
        return identities.some(idn => lower.includes(idn) || idn.includes(lower));
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

export async function renameVoicePrint(id: string, name: string): Promise<void> {
  await voicePrintsDb.updateAsync({ _id: id }, { $set: { name } }, {});
}

// ── Zoom Credentials ──────────────────────────────────────────────────────────

export interface ZoomCredentials {
  zoomClientId: string | null;
  zoomClientSecret: string | null;
  zoomAccessToken: string | null;
  zoomRefreshToken: string | null;
  zoomTokenExpiresAt: string | null;
}

const ZOOM_DOC_ID = 'zoom';

export async function getZoomCredentials(): Promise<ZoomCredentials | null> {
  const doc = await credentialsDb.findOneAsync({ _id: ZOOM_DOC_ID });
  if (!doc) return null;
  const d = doc as any;
  return {
    zoomClientId: d.zoomClientId ?? null,
    zoomClientSecret: d.zoomClientSecret ?? null,
    zoomAccessToken: d.zoomAccessToken ?? null,
    zoomRefreshToken: d.zoomRefreshToken ?? null,
    zoomTokenExpiresAt: d.zoomTokenExpiresAt ?? null,
  };
}

export async function setZoomClientCredentials(clientId: string, clientSecret: string): Promise<void> {
  const existing = await credentialsDb.findOneAsync({ _id: ZOOM_DOC_ID });
  if (existing) {
    await credentialsDb.updateAsync({ _id: ZOOM_DOC_ID }, { $set: { zoomClientId: clientId, zoomClientSecret: clientSecret } }, {});
  } else {
    await credentialsDb.insertAsync({
      _id: ZOOM_DOC_ID,
      zoomClientId: clientId,
      zoomClientSecret: clientSecret,
      zoomAccessToken: null,
      zoomRefreshToken: null,
      zoomTokenExpiresAt: null,
    });
  }
}

export async function setZoomTokens(tokens: {
  zoomAccessToken: string;
  zoomRefreshToken: string;
  zoomTokenExpiresAt: string;
}): Promise<void> {
  const existing = await credentialsDb.findOneAsync({ _id: ZOOM_DOC_ID });
  if (existing) {
    await credentialsDb.updateAsync({ _id: ZOOM_DOC_ID }, { $set: tokens }, {});
  } else {
    await credentialsDb.insertAsync({
      _id: ZOOM_DOC_ID,
      zoomClientId: null,
      zoomClientSecret: null,
      ...tokens,
    });
  }
}

export async function clearZoomCredentials(): Promise<void> {
  await credentialsDb.removeAsync({ _id: ZOOM_DOC_ID }, {});
}

export function __setCredentialsDbForTests(db: Datastore): void {
  credentialsDb = db;
}
