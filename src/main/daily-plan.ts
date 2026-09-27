/**
 * Pure compute for the once-a-day "Ollie planned your day" popup.
 * Kept free of electron imports so it can be unit-tested (same pattern as
 * welcome-back.ts / live-meeting-banner.ts).
 *
 * Flow (orchestrated in main.ts):
 *   - ~10 minutes after the app starts or the machine is unlocked, the plan is shown
 *   - at most once per local calendar day
 *   - if the user is in a meeting at that moment, showing is deferred and
 *     re-checked every couple of minutes until the meeting ends
 */

export const DAILY_PLAN_DELAY_MS = 10 * 60_000;
export const DAILY_PLAN_RECHECK_MS = 2 * 60_000;

export type DailyPlanGate = 'show' | 'defer' | 'already-shown' | 'disabled';

export interface DailyPlanGateInput {
  now: Date;
  enabled: boolean;
  /** ISO timestamp of the last time the plan was shown, or null. */
  lastShownAt: string | null;
  /** True when a meeting is in progress (calendar event or active recording). */
  liveMeeting: boolean;
}

export function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function computeDailyPlanGate(input: DailyPlanGateInput): DailyPlanGate {
  if (!input.enabled) return 'disabled';
  if (input.lastShownAt) {
    const last = new Date(input.lastShownAt);
    if (!Number.isNaN(last.getTime()) && isSameLocalDay(last, input.now)) {
      return 'already-shown';
    }
  }
  return input.liveMeeting ? 'defer' : 'show';
}

export interface DailyPlanEvent {
  id: string;
  title: string;
  startTime: Date;
  endTime: Date;
  attendees: string[];
  /** Bare calendar-series UID. Null means this is a one-time event. */
  seriesUid: string | null;
}

/** Today's meetings that haven't ended yet (includes one currently in progress), soonest first. */
export function selectTodaysMeetings(
  events: DailyPlanEvent[],
  now: Date,
  cap = 6,
): DailyPlanEvent[] {
  return events
    .filter((ev) => isSameLocalDay(ev.startTime, now) && ev.endTime.getTime() > now.getTime())
    .sort((a, b) => a.startTime.getTime() - b.startTime.getTime())
    .slice(0, cap);
}

export interface AgendaHistoryMeeting {
  _id?: string;
  title?: string;
  date?: string;
  attendees?: string[];
  seriesUid?: string | null;
  calendarEventId?: string | null;
  insights?: {
    summary?: string;
    actionItems?: unknown[];
    decisions?: unknown[];
    commitments?: unknown[];
    blockers?: unknown[];
  } | null;
}

function seriesUidOf(meeting: { seriesUid?: string | null; calendarEventId?: string | null }): string | null {
  if (meeting.seriesUid) return String(meeting.seriesUid);

  // Older recording rows predate the dedicated field but use
  // `<seriesUid>_<occurrenceEpochMs>` as their calendar event id.
  const composite = meeting.calendarEventId;
  if (!composite) return null;
  const separator = composite.lastIndexOf('_');
  if (separator <= 0 || !/^\d{10,}$/.test(composite.slice(separator + 1))) return null;
  return composite.slice(0, separator);
}

export function hasUsableAgendaEvidence(meeting: AgendaHistoryMeeting): boolean {
  const insights = meeting.insights;
  if (!insights) return false;
  return [insights.actionItems, insights.decisions, insights.commitments, insights.blockers]
    .some((items) => Array.isArray(items) && items.some((item: any) => {
      if (typeof item === 'string') return item.trim().length > 0;
      return typeof item?.text === 'string' && item.text.trim().length > 0;
    }));
}

/**
 * Select substantive, earlier recordings from this exact recurring calendar
 * series. Filtering happens before the cap so low-signal recent recordings do
 * not hide an older meeting that contains useful follow-up material.
 */
export function selectAgendaHistory(
  pastMeetings: AgendaHistoryMeeting[],
  event: Pick<DailyPlanEvent, 'seriesUid' | 'startTime'>,
  cap = 3,
): AgendaHistoryMeeting[] {
  if (!event.seriesUid) return [];
  const eventStart = event.startTime.getTime();

  return pastMeetings
    .filter((meeting) => {
      if (seriesUidOf(meeting) !== event.seriesUid || !hasUsableAgendaEvidence(meeting)) return false;
      const meetingTime = meeting.date ? new Date(meeting.date).getTime() : Number.NaN;
      return Number.isFinite(meetingTime) && meetingTime < eventStart;
    })
    .sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime())
    .slice(0, cap);
}

/** Only recurring events with substantive history may trigger an AI agenda. */
export function hasAgendaHistory(
  pastMeetings: AgendaHistoryMeeting[],
  event: Pick<DailyPlanEvent, 'seriesUid' | 'startTime'>,
): boolean {
  return selectAgendaHistory(pastMeetings, event, 1).length > 0;
}

export function buildAgendaBasis(history: AgendaHistoryMeeting[]): string | null {
  if (history.length === 0) return null;
  const dates = history.map((meeting) =>
    new Date(meeting.date || 0).toLocaleDateString([], { month: 'short', day: 'numeric' })
  );
  if (history.length === 1) {
    return `Based on ${dates[0]}: ${history[0].title || 'an earlier meeting in this series'}`;
  }
  return `Based on ${history.length} earlier meetings in this calendar series: ${dates.join(', ')}`;
}

const GREETING_SUBS = [
  'Ollie was up early planning your day. Here it is.',
  'Ollie lined everything up while you were away. Coffee first, then this.',
  'Your day, already sorted. Ollie took care of the thinking.',
  'Ollie mapped out today so you can just start.',
  'All set — Ollie did the morning shuffle for you.',
];

export function buildGreeting(now: Date, userName: string): { title: string; sub: string } {
  const hour = now.getHours();
  const timeOfDay = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const title = userName ? `${timeOfDay}, ${userName}` : timeOfDay;

  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const dayOfYear = Math.floor((now.getTime() - startOfYear.getTime()) / (24 * 60 * 60 * 1000));
  const sub = GREETING_SUBS[((dayOfYear % GREETING_SUBS.length) + GREETING_SUBS.length) % GREETING_SUBS.length];

  return { title, sub };
}
