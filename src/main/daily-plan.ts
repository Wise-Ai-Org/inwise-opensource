/**
 * Pure compute for the once-a-day "Wiser planned your day" popup.
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

interface PastMeetingLike {
  title?: string;
  attendees?: string[];
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * "Can we reasonably pre-fill an agenda?" — only when local history gives the
 * LLM something real to work from: a past meeting sharing an attendee, or a
 * past meeting with a matching title (recurring meeting). Without this, the
 * agenda prompt falls back to generic filler, which we'd rather not show.
 */
export function hasAgendaHistory(pastMeetings: PastMeetingLike[], event: { title: string; attendees: string[] }): boolean {
  const evTitle = norm(event.title);
  const evAttendees = event.attendees.map(norm).filter((a) => a.length > 2);

  for (const m of pastMeetings) {
    if (m.title && evTitle.length > 3) {
      const mt = norm(m.title);
      if (mt === evTitle || mt.includes(evTitle) || evTitle.includes(mt)) return true;
    }
    for (const raw of m.attendees ?? []) {
      const a = norm(raw);
      if (a.length <= 2) continue;
      for (const b of evAttendees) {
        if (a === b || a.includes(b) || b.includes(a)) return true;
      }
    }
  }
  return false;
}

const GREETING_SUBS = [
  'Wiser was up early planning your day. Here it is.',
  'Wiser lined everything up while you were away. Coffee first, then this.',
  'Your day, already sorted. Wiser took care of the thinking.',
  'Wiser mapped out today so you can just start.',
  'All set — Wiser did the morning shuffle for you.',
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
