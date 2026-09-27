export interface ScoredTaskLike {
  _id: string;
  score: number;
  reasoning: string;
}

export interface DailyBriefing {
  dateKey: string;
  title: string;
  greeting: string;
  isToday: boolean;
  taskLabel: 'Top priorities' | 'Tasks due';
  topTasks: any[];
  overdueCommitments: any[];
  totalTasks: number;
  meetingCount: number;
  actionItemCount: number;
  decisionCount: number;
  blockerCount: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Format a Date as a local calendar key without converting it through UTC. */
export function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseDateKey(value: unknown, fallback: Date): { dateKey: string; date: Date } {
  if (typeof value === 'string') {
    const match = DATE_KEY_RE.exec(value);
    if (match) {
      const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
      if (localDateKey(date) === value) return { dateKey: value, date };
    }
  }
  return { dateKey: localDateKey(fallback), date: new Date(fallback) };
}

function valueDateKey(value: unknown): string | null {
  if (typeof value === 'string') {
    const dateOnly = DATE_KEY_RE.exec(value);
    if (dateOnly) {
      const parsed = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 12);
      return localDateKey(parsed) === value ? value : null;
    }
  }
  const parsed = new Date(value as any);
  return Number.isNaN(parsed.getTime()) ? null : localDateKey(parsed);
}

function asDate(value: unknown): Date | null {
  if (typeof value === 'string') {
    const dateOnly = DATE_KEY_RE.exec(value);
    if (dateOnly) {
      const parsed = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
      return localDateKey(parsed) === value ? parsed : null;
    }
  }
  const parsed = new Date(value as any);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function buildDailyBriefing(input: {
  requestedDateKey?: unknown;
  now: Date;
  name: string;
  tasks: any[];
  meetings: any[];
  calendarEvents?: any[];
  scoredTasks: ScoredTaskLike[];
}): DailyBriefing {
  const { dateKey, date } = parseDateKey(input.requestedDateKey, input.now);
  const isToday = dateKey === localDateKey(input.now);
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayEnd = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);

  const dayMeetings = input.meetings.filter(meeting => {
    const when = asDate(meeting?.date);
    return when && when >= dayStart && when < dayEnd;
  });
  const dbCalendarIds = new Set(dayMeetings.map(meeting => meeting?.calendarEventId).filter(Boolean));
  const unmatchedCalendarEvents = (input.calendarEvents || []).filter(event => {
    const when = asDate(event?.startTime);
    return when && when >= dayStart && when < dayEnd && !dbCalendarIds.has(event?.id);
  });

  const openTasks = input.tasks.filter(task => task?.status !== 'completed');
  const taskById = new Map(openTasks.map(task => [task._id, task]));
  const scoredOpen = input.scoredTasks.filter(scored => taskById.has(scored._id));
  const selectedTasks = isToday
    ? scoredOpen
    : scoredOpen.filter(scored => valueDateKey(taskById.get(scored._id)?.dueDate) === dateKey);
  const topTasks = selectedTasks.slice(0, 3).map(scored => ({
    ...taskById.get(scored._id),
    priorityScore: scored.score,
    priorityReasoning: scored.reasoning,
  }));

  // A historic brief uses the end of that local day. Today's brief keeps the
  // existing real-time behavior so a commitment becomes overdue during the day.
  const overdueCutoff = isToday ? input.now : dayEnd;
  const overdueCommitments: any[] = [];
  for (const meeting of input.meetings) {
    const meetingDate = asDate(meeting?.date);
    if (!meetingDate || meetingDate >= overdueCutoff) continue;
    for (const commitment of meeting?.insights?.commitments || []) {
      const deadline = asDate(commitment?.deadline);
      if (!deadline || deadline >= overdueCutoff) continue;
      overdueCommitments.push({
        text: commitment.text,
        who: commitment.who,
        deadline: commitment.deadline,
        meetingTitle: meeting.title,
        meetingDate: meeting.date,
        meetingId: meeting._id,
        daysOverdue: Math.max(0, Math.floor((overdueCutoff.getTime() - deadline.getTime()) / DAY_MS)),
      });
    }
  }
  overdueCommitments.sort((a, b) => b.daysOverdue - a.daysOverdue);

  const greeting = input.name ? `Hi, ${input.name}` : 'Hi';
  const dateLabel = date.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: date.getFullYear() !== input.now.getFullYear() ? 'numeric' : undefined,
  });

  return {
    dateKey,
    title: isToday ? `${greeting} — today's brief` : `${dateLabel} brief`,
    greeting,
    isToday,
    taskLabel: isToday ? 'Top priorities' : 'Tasks due',
    topTasks,
    overdueCommitments: overdueCommitments.slice(0, 5),
    totalTasks: isToday ? openTasks.length : selectedTasks.length,
    meetingCount: dayMeetings.length + unmatchedCalendarEvents.length,
    actionItemCount: dayMeetings.reduce((sum, meeting) => sum + (meeting?.insights?.actionItems?.length || 0), 0),
    decisionCount: dayMeetings.reduce((sum, meeting) => sum + (meeting?.insights?.decisions?.length || 0), 0),
    blockerCount: dayMeetings.reduce((sum, meeting) => sum + (meeting?.insights?.blockers?.length || 0), 0),
  };
}
