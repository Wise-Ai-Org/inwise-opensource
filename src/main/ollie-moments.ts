/**
 * Pure Ollie-moment helpers: notification settings defaults/migration, the
 * prep > wrap-up > morning selection, and OS notification copy. No Electron,
 * no persistence — main.ts / ollie-moments-service.ts supply every input.
 */
import type {
  MorningMode,
  NotificationCopy,
  NotificationSettings,
  NotifyMode,
  OllieMomentKind,
  PrepContent,
  PrepLeadMinutes,
  ProcessedContent,
  WrapUpContent,
} from './ollie-moments-types';

export const WRAP_UP_DELAY_MS = 5 * 60_000;

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  morning: 'window',
  prep: { mode: 'notify', leadMinutes: 10 },
  processed: 'notify',
  wrapUp: 'notify',
  recordingProblems: true,
};

const MORNING_MODES: MorningMode[] = ['window', 'tray', 'off'];
const NOTIFY_MODES: NotifyMode[] = ['notify', 'tray', 'off'];
const LEADS: PrepLeadMinutes[] = [5, 10, 15];

/**
 * Coerce any stored value (missing block on an existing install, partial
 * object, garbage) into complete settings. `legacyDailyPlanEnabled === false`
 * maps an existing "daily plan off" preference onto morning = 'tray' so a
 * user who turned the window off does not get it back after upgrading.
 */
export function normalizeNotificationSettings(raw: unknown, legacyDailyPlanEnabled?: boolean): NotificationSettings {
  const r: any = raw && typeof raw === 'object' ? raw : {};
  const d = DEFAULT_NOTIFICATION_SETTINGS;
  const legacyMorning: MorningMode = legacyDailyPlanEnabled === false ? 'tray' : d.morning;
  const prepRaw: any = r.prep && typeof r.prep === 'object' ? r.prep : {};
  return {
    morning: MORNING_MODES.includes(r.morning) ? r.morning : legacyMorning,
    prep: {
      mode: NOTIFY_MODES.includes(prepRaw.mode) ? prepRaw.mode : d.prep.mode,
      leadMinutes: LEADS.includes(prepRaw.leadMinutes) ? prepRaw.leadMinutes : d.prep.leadMinutes,
    },
    processed: NOTIFY_MODES.includes(r.processed) ? r.processed : d.processed,
    wrapUp: NOTIFY_MODES.includes(r.wrapUp) ? r.wrapUp : d.wrapUp,
    recordingProblems: true,
  };
}

/** Merge a partial update from the renderer onto current settings, then normalize. */
export function mergeNotificationSettings(current: NotificationSettings, patch: unknown): NotificationSettings {
  const p: any = patch && typeof patch === 'object' ? patch : {};
  return normalizeNotificationSettings({
    ...current,
    ...p,
    prep: { ...current.prep, ...(p.prep && typeof p.prep === 'object' ? p.prep : {}) },
  });
}

// ── Dates ──────────────────────────────────────────────────────────────────

export function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function startOfLocalDay(date: Date, offsetDays = 0): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + offsetDays);
}

export function toMs(value: unknown): number | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value) {
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (dateOnly) return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])).getTime();
    const ms = new Date(value).getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/** "9:05 AM" — fixed format so notification copy is stable across locales. */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? 'AM' : 'PM'}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ── Selection ──────────────────────────────────────────────────────────────

export interface MomentEvent {
  id: string;
  title: string;
  startTime: Date | number | string;
  endTime: Date | number | string;
}

export interface MomentSelectionInput {
  now: Date;
  /** Upcoming/today calendar events; cancelled events are already absent. */
  events: MomentEvent[];
  settings: NotificationSettings;
  dismissedKeys: Iterable<string>;
  recordingActive: boolean;
}

export interface SelectedMoment {
  kind: OllieMomentKind;
  key: string;
  eventId?: string;
  dateKey: string;
}

/** Without an end time, a meeting is assumed to run this long. */
const DEFAULT_MEETING_MS = 30 * 60_000;

/**
 * Prep window for an event: [start - lead, end). The card stays through the
 * meeting itself so the tray keeps showing the meeting you are in.
 */
export function prepWindow(event: MomentEvent, leadMinutes: number): { from: number; to: number } | null {
  const start = toMs(event.startTime);
  if (start === null) return null;
  const end = toMs(event.endTime);
  return { from: start - leadMinutes * 60_000, to: end !== null && end > start ? end : start + DEFAULT_MEETING_MS };
}

/**
 * Events in the prep window right now. Upcoming meetings come first (soonest
 * start), so prep for the next meeting replaces one that is running over.
 */
export function eventsInPrepWindow(events: MomentEvent[], now: Date, leadMinutes: number): MomentEvent[] {
  const nowMs = now.getTime();
  const rank = (e: MomentEvent) => {
    const s = toMs(e.startTime) ?? 0;
    return s > nowMs ? s - 1e15 : -s;
  };
  return events
    .filter((e) => {
      const w = prepWindow(e, leadMinutes);
      return !!w && nowMs >= w.from && nowMs < w.to;
    })
    .sort((a, b) => rank(a) - rank(b));
}

/** End (ms) of the last calendar meeting that starts on `now`'s local day, or null. */
export function lastMeetingEndToday(events: MomentEvent[], now: Date): number | null {
  const dayStart = startOfLocalDay(now).getTime();
  const dayEnd = startOfLocalDay(now, 1).getTime();
  let last: number | null = null;
  for (const e of events) {
    const s = toMs(e.startTime);
    const en = toMs(e.endTime);
    if (s === null || en === null || s < dayStart || s >= dayEnd) continue;
    if (last === null || en > last) last = en;
  }
  return last;
}

/** When the wrap-up moment begins today (last meeting end + 5 min), or null with no meetings today. */
export function wrapUpStartsAt(events: MomentEvent[], now: Date): number | null {
  const last = lastMeetingEndToday(events, now);
  return last === null ? null : last + WRAP_UP_DELAY_MS;
}

/**
 * The single moment the Ollie card shows: prep wins, then wrap-up, then
 * morning. A dismissed moment yields null (the card stays hidden) until the
 * next moment begins — dismissal never promotes a lower-priority moment.
 */
export function selectOllieMoment(input: MomentSelectionInput): SelectedMoment | null {
  const { now, events, settings } = input;
  const dismissed = new Set(input.dismissedKeys);
  const dateKey = localDayKey(now);

  let selected: SelectedMoment | null = null;
  if (settings.prep.mode !== 'off') {
    const next = eventsInPrepWindow(events, now, settings.prep.leadMinutes)[0];
    if (next) selected = { kind: 'prep', key: `prep:${next.id}`, eventId: next.id, dateKey };
  }
  if (!selected && settings.wrapUp !== 'off' && !input.recordingActive) {
    const startsAt = wrapUpStartsAt(events, now);
    if (startsAt !== null && now.getTime() >= startsAt) selected = { kind: 'wrap', key: `wrap:${dateKey}`, dateKey };
  }
  if (!selected && settings.morning !== 'off') {
    selected = { kind: 'morning', key: `morning:${dateKey}`, dateKey };
  }
  if (!selected || dismissed.has(selected.key)) return null;
  return selected;
}

/** Drop dismissal / notified keys that can no longer match (older than `keepDays`). */
export function pruneMomentKeys(keys: string[], now: Date, keepDays = 3, max = 200): string[] {
  const cutoff = localDayKey(startOfLocalDay(now, -keepDays));
  const kept = keys.filter((k) => {
    const m = /^(?:wrap|morning):(\d{4}-\d{2}-\d{2})$/.exec(k);
    return !m || m[1] >= cutoff;
  });
  return kept.slice(-max);
}

// ── Notification copy ──────────────────────────────────────────────────────

export function prepNotificationCopy(prep: PrepContent): NotificationCopy {
  const minutes = Math.max(1, prep.minutesUntil);
  const title = `${prep.title} in ${plural(minutes, 'min', 'min')}`;
  const parts: string[] = [];

  const owesYou = prep.owes.flatMap((a) => a.owesYou.map((item) => ({ a, item })));
  const youOwe = prep.owes.flatMap((a) => a.youOwe.map((item) => ({ a, item })));
  const lead =
    owesYou.find((x) => x.item.daysLate !== null)
    || youOwe.find((x) => x.item.daysLate !== null)
    || owesYou[0]
    || youOwe[0];
  if (lead) {
    const isOwesYou = owesYou.includes(lead);
    const late = lead.item.daysLate !== null
      ? (isOwesYou ? ` (${plural(lead.item.daysLate, 'day')} late)` : ' (overdue)')
      : '';
    parts.push(isOwesYou ? `${lead.a.name} owes you: ${lead.item.text}${late}.` : `You owe ${lead.a.name}: ${lead.item.text}${late}.`);
  }
  if (prep.pendingApprovals.length > 0) {
    const n = prep.pendingApprovals.length;
    parts.push(`${plural(n, 'Jira update')} ${n === 1 ? 'needs' : 'need'} your OK.`);
  }
  const blocked = prep.jira?.rows.find((r) => r.kind === 'blocked');
  if (parts.length === 0 && blocked) {
    parts.push(`${blocked.owner ? `${blocked.owner.split(/\s+/)[0]}'s ` : ''}${blocked.key} is blocked.`);
  }
  if (parts.length === 0) {
    parts.push(prep.lastMet ? `Last met ${shortDate(prep.lastMet.date)} · ${prep.lastMet.title}.` : 'Your prep is ready in Inwise.');
  }
  return { title, body: parts.join(' ') };
}

export function processedNotificationCopy(p: ProcessedContent): NotificationCopy {
  if (p.status === 'failed') {
    return {
      title: `Couldn't process ${p.title}`,
      body: p.failure?.audioSaved === false ? (p.failure.message || 'The audio could not be saved.') : 'The audio is saved.',
    };
  }
  const title = `Inwise processed ${p.title}`;
  if (p.status === 'needs_review') {
    return { title, body: 'The audio was patchy, so the transcript needs a quick review before Inwise pulls tasks from it.' };
  }
  let body = `Found ${plural(p.taskCount, 'task')} and ${plural(p.decisionCount, 'decision')}.`;
  if (p.jira) {
    const pushed = p.jira.pushedCount;
    const pending = p.jira.pending.length;
    const bits: string[] = [];
    if (pushed > 0) bits.push(`Pushed ${plural(pushed, 'Jira update')}`);
    if (pending > 0) bits.push(`${pending} ${pending === 1 ? 'needs' : 'need'} your OK`);
    if (p.jira.failedCount > 0) bits.push(`${p.jira.failedCount} failed`);
    if (bits.length > 0) body += ` ${bits.join(', ')}.`;
  }
  if (p.patchyAudio) body += ' Some audio was patchy.';
  return { title, body };
}

export function wrapUpNotificationCopy(w: WrapUpContent): NotificationCopy {
  const first = w.tomorrow.firstMeeting;
  const title = first ? `Tomorrow starts at ${formatClock(first.startTime)} with ${first.title}` : 'Day wrapped';
  let body = `Today: ${plural(w.today.meetingCount, 'meeting')}, ${plural(w.today.tasksFound, 'task')} found.`;
  const threads = w.slackToday.reduce((sum, c) => sum + c.threadCount, 0);
  if (threads > 0) body += ` Slack brought in ${plural(threads, 'thread')}.`;
  const waiting = w.jira?.waitingCount || 0;
  if (waiting > 0) body += ` ${plural(waiting, 'Jira change')} ${waiting === 1 ? 'waits' : 'wait'} for your OK.`;
  return { title, body };
}

function shortDate(value: string): string {
  const ms = toMs(value);
  if (ms === null) return value;
  const d = new Date(ms);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}
