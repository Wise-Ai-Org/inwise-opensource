import { isSnoozed } from './database';

export interface WelcomeBackWins {
  cleared?: { count: number; sampleTitles: string[] };
  jiraProgress?: { count: number; doneCount: number };
  meetingsMatched?: { count: number };
  calendarHealthy?: { upcomingCount: number };
}

export type WelcomeBackAskKind =
  | 'contradiction'
  | 'overdueWithSignal'
  | 'launchAtStartupOffer';

export interface WelcomeBackAsk {
  kind: WelcomeBackAskKind;
  payload: any;
}

export interface WelcomeBackResult {
  gapDays: number;
  wins: WelcomeBackWins;
  ask?: WelcomeBackAsk;
}

export interface WelcomeBackSweepResult {
  snoozed: { _id?: string; title?: string }[];
}

export interface WelcomeBackEvent {
  id: string;
  startTime: Date | string | number;
}

export interface WelcomeBackInputs {
  now: Date;
  daysSinceLastOpen: number | null;
  lastOpenedAtSnapshot: string | null;
  welcomeBackLastSeenAt: string | null;
  openAtLogin: boolean;
  lastSweepResult: WelcomeBackSweepResult | null;
  tasks: any[];
  meetings: any[];
  upcomingEvents: WelcomeBackEvent[];
}

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function startTimeMs(e: WelcomeBackEvent): number {
  if (e.startTime instanceof Date) return e.startTime.getTime();
  if (typeof e.startTime === 'number') return e.startTime;
  return new Date(e.startTime).getTime();
}

export function computeWelcomeBack(inputs: WelcomeBackInputs): WelcomeBackResult | null {
  const {
    now,
    daysSinceLastOpen,
    lastOpenedAtSnapshot,
    welcomeBackLastSeenAt,
    openAtLogin,
    lastSweepResult,
    tasks,
    meetings,
    upcomingEvents,
  } = inputs;

  // Null-return gates.
  if (daysSinceLastOpen === null) return null;
  if (daysSinceLastOpen < 2) return null;
  if (
    welcomeBackLastSeenAt !== null &&
    lastOpenedAtSnapshot !== null &&
    welcomeBackLastSeenAt >= lastOpenedAtSnapshot
  ) {
    return null;
  }

  const nowMs = now.getTime();
  const priorMs = lastOpenedAtSnapshot ? new Date(lastOpenedAtSnapshot).getTime() : 0;

  const wins: WelcomeBackWins = {};

  if (lastSweepResult && lastSweepResult.snoozed.length > 0) {
    wins.cleared = {
      count: lastSweepResult.snoozed.length,
      sampleTitles: lastSweepResult.snoozed
        .slice(0, 3)
        .map((t) => (typeof t.title === 'string' ? t.title : ''))
        .filter((s) => s.length > 0),
    };
  }

  const jiraTasksInGap = tasks.filter((t: any) => {
    if (!t.source || t.source.type !== 'jira') return false;
    const upd = t.updatedAt ? new Date(t.updatedAt).getTime() : 0;
    return upd > priorMs;
  });
  if (jiraTasksInGap.length > 0) {
    const doneCount = jiraTasksInGap.filter(
      (t: any) => t.status === 'completed' || t.status === 'done',
    ).length;
    wins.jiraProgress = { count: jiraTasksInGap.length, doneCount };
  }

  const matchedMeetingIds = new Set<string>();
  for (const t of tasks as any[]) {
    if (t.source?.type !== 'jira') continue;
    const meetingId: string | undefined = t.provenance?.meetingId;
    if (!meetingId) continue;
    const m = meetings.find((x: any) => x._id === meetingId);
    if (!m) continue;
    const created = m.createdAt ? new Date(m.createdAt).getTime() : 0;
    if (created > priorMs) matchedMeetingIds.add(meetingId);
  }
  if (matchedMeetingIds.size > 0) {
    wins.meetingsMatched = { count: matchedMeetingIds.size };
  }

  const upcomingCount = upcomingEvents.filter((e) => {
    const s = startTimeMs(e);
    return s >= nowMs && s <= nowMs + SEVEN_DAYS_MS;
  }).length;
  if (upcomingCount > 0) {
    wins.calendarHealthy = { upcomingCount };
  }

  // Missed meetings: calendar events that started between priorOpen and now
  // with no processed meeting row (or only a calendar_sync placeholder row).
  const missedMeetingsCount = upcomingEvents.filter((e) => {
    const s = startTimeMs(e);
    if (s <= priorMs || s >= nowMs) return false;
    const row = meetings.find((m: any) => m.calendarEventId === e.id);
    if (!row) return true;
    return row.status === 'calendar_sync';
  }).length;

  let ask: WelcomeBackAsk | undefined;

  const contradictionMeeting = meetings.find((m: any) => {
    const c = m.createdAt ? new Date(m.createdAt).getTime() : 0;
    if (c <= priorMs) return false;
    return Array.isArray(m.insights?.contradictions) && m.insights.contradictions.length > 0;
  });
  if (contradictionMeeting) {
    const c = contradictionMeeting.insights.contradictions[0];
    ask = {
      kind: 'contradiction',
      payload: {
        meetingId: contradictionMeeting._id,
        meetingTitle: contradictionMeeting.title,
        summary: c.text,
        previousDecision: c.previousDecision,
      },
    };
  }

  if (!ask) {
    const overdueTask = (tasks as any[]).find((t: any) => {
      if (isSnoozed(t)) return false;
      if (t.archivedAt) return false;
      if (t.status === 'completed' || t.status === 'done') return false;
      if (!t.dueDate) return false;
      const due = new Date(t.dueDate).getTime();
      if (!Number.isFinite(due)) return false;
      if (due >= nowMs) return false;
      if (!t.lastMentionedAt) return false;
      const mentioned = new Date(t.lastMentionedAt).getTime();
      if (!Number.isFinite(mentioned)) return false;
      return nowMs - mentioned <= FOURTEEN_DAYS_MS;
    });
    if (overdueTask) {
      ask = {
        kind: 'overdueWithSignal',
        payload: {
          taskId: overdueTask._id,
          title: overdueTask.title,
          dueDate: overdueTask.dueDate,
        },
      };
    }
  }

  if (!ask && !openAtLogin && daysSinceLastOpen >= 3 && missedMeetingsCount >= 3) {
    ask = {
      kind: 'launchAtStartupOffer',
      payload: { missedMeetingsCount },
    };
  }

  return {
    gapDays: daysSinceLastOpen,
    wins,
    ...(ask ? { ask } : {}),
  };
}
