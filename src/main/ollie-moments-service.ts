/**
 * Electron side of Ollie moments: exact prep timers, the once-a-day wrap-up
 * trigger, per-meeting "processed" announcements, a notification queue that
 * holds moments while a meeting/recording is active, dismissal bookkeeping,
 * and the loaders that feed the pure builders in ollie-content.ts.
 *
 * main.ts owns windows and the calendar watcher and hands them in through
 * initOllieMoments(); this module never imports main.ts.
 */
import { BrowserWindow, Notification } from 'electron';
import { getConfig, getNotificationSettings, getOllieMomentState, setOllieMomentState, markWelcomeBackSeen } from './config';
import type { OllieMomentState } from './config';
import { getMeeting, getMeetings, getPeople, getTasks, updateTask } from './database';
import { log } from './logger';
import { isSelf } from './self-identity';
import { scoreTasks } from './task-scorer';
import { listPending } from './sor-pending-approvals';
import { getWriteEntry, listByMeeting as sorListByMeeting, listRecent as sorListRecent } from './sor-write-log';
import { isJiraConnected } from './jira-client';
import { listCachedIssues, type JiraIssueSnapshot } from './jira-pull';
import { listActionExecutionsUpdatedSince } from './action-execution-log';
import { getLastSlackPollAt } from './slack-poller';
import { getSlackConnectionInfo } from './slack-client';
import { waitForMeetingSync } from './jira-sync';
import {
  buildCatchUpNotes,
  buildMorning,
  buildPrep,
  buildProcessed,
  buildWrapUp,
  computeCatchUp,
  summarizePendingApproval,
  type CalendarEventLike,
  type ContentContext,
} from './ollie-content';
import {
  localDayKey,
  prepNotificationCopy,
  processedNotificationCopy,
  pruneMomentKeys,
  selectOllieMoment,
  startOfLocalDay,
  toMs,
  wrapUpNotificationCopy,
  wrapUpStartsAt,
} from './ollie-moments';
import type {
  CatchUpNote,
  NotificationCopy,
  OllieFocusMoment,
  OllieMoment,
  OllieMomentChanged,
  PendingJiraApproval,
  ProcessedContent,
  WelcomeBackContent,
} from './ollie-moments-types';

export interface OllieServiceDeps {
  getMainWindow(): BrowserWindow | null;
  /** Calendar watcher cache; cancelled events are already absent. */
  getEvents(): CalendarEventLike[];
  isRecordingActive(): boolean;
  /** Recording, recorder pill open, or a live calendar meeting. */
  isBusy(): boolean;
  /** Position + show + focus the tray popup. */
  openPopup(): void;
  /** Start recording a calendar event through the normal meeting-starting path. */
  startRecordingForEvent(event: CalendarEventLike): void;
  getWelcomeBack(): Promise<WelcomeBackContent | null>;
}

const PREP_HORIZON_MS = 36 * 60 * 60 * 1000;
const QUEUE_FLUSH_MS = 30_000;
const WRAP_RECHECK_MS = 60_000;

let deps: OllieServiceDeps | null = null;
const prepTimers = new Map<string, NodeJS.Timeout[]>();
let wrapTimer: NodeJS.Timeout | null = null;
let midnightTimer: NodeJS.Timeout | null = null;
let queueTimer: NodeJS.Timeout | null = null;
const queued = new Map<string, () => void>();
const armedEvents = new Set<string>();
const draftAgendas = new Map<string, string[]>();
/** Today's events from the previous calendar refresh, for cancellation detection. */
let previousToday: Map<string, CalendarEventLike> | null = null;
/** Keep shown notifications referenced so their click handlers survive GC. */
const liveNotifications = new Set<Notification>();

// ── State helpers ───────────────────────────────────────────────────────────

function updateState(mutate: (s: OllieMomentState) => void): OllieMomentState {
  const state = getOllieMomentState();
  mutate(state);
  const now = new Date();
  state.dismissedKeys = pruneMomentKeys(state.dismissedKeys, now);
  state.notifiedKeys = pruneMomentKeys(state.notifiedKeys, now);
  const todayStart = startOfLocalDay(now).getTime();
  state.cancelledEvents = state.cancelledEvents.filter((e) => (toMs(e.detectedAt) ?? 0) >= todayStart);
  setOllieMomentState(state);
  return state;
}

function wasNotified(key: string): boolean {
  return getOllieMomentState().notifiedKeys.includes(key);
}

function markNotified(key: string): void {
  updateState((s) => { if (!s.notifiedKeys.includes(key)) s.notifiedKeys.push(key); });
}

function emitChanged(payload: OllieMomentChanged): void {
  const win = deps?.getMainWindow();
  if (win && !win.isDestroyed()) win.webContents.send('ollie:moment-changed', payload);
}

function focusMoment(focus: OllieFocusMoment): void {
  if (!deps) return;
  deps.openPopup();
  const win = deps.getMainWindow();
  if (!win || win.isDestroyed()) return;
  const send = () => { if (!win.isDestroyed()) win.webContents.send('ollie:focus-moment', focus); };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => setTimeout(send, 100));
  else send();
}

function showNotification(
  copy: NotificationCopy,
  focus: OllieFocusMoment,
  actions: string[] = [],
  onAction?: (index: number) => void,
): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: copy.title,
    body: copy.body,
    actions: actions.map((text) => ({ type: 'button' as const, text })),
  });
  liveNotifications.add(n);
  const release = () => liveNotifications.delete(n);
  n.on('click', () => { release(); focusMoment(focus); });
  n.on('action', (_e, index) => {
    release();
    if (onAction) onAction(index);
    else focusMoment(focus);
  });
  n.on('close', release);
  n.show();
}

/** Show now, or hold until no meeting/recording is in progress. One entry per key. */
function enqueue(key: string, show: () => void): void {
  if (deps && !deps.isBusy()) {
    show();
    return;
  }
  queued.set(key, show);
  log('info', 'ollie:queue', `held ${key} until the meeting ends`);
}

export function flushOllieQueue(): void {
  if (!deps || deps.isBusy() || queued.size === 0) return;
  const pending = Array.from(queued.values());
  queued.clear();
  for (const show of pending) {
    try { show(); } catch (err: any) { log('error', 'ollie:queue', err.message); }
  }
}

// ── Loaders ────────────────────────────────────────────────────────────────

async function loadContext(now: Date): Promise<{ ctx: ContentContext; allTasks: any[] }> {
  const cfg = getConfig();
  const [allTasks, meetings, people] = await Promise.all([getTasks({ includeSnoozed: true }), getMeetings(), getPeople()]);
  const tasks = allTasks.filter((t: any) => t.snoozedAt == null);
  const scored = scoreTasks(tasks.filter((t: any) => t.status !== 'done' && t.status !== 'completed'), meetings, people);
  let jiraIssues: JiraIssueSnapshot[] | null = null;
  if (isJiraConnected()) {
    try { jiraIssues = await listCachedIssues(); } catch { jiraIssues = []; }
  }
  return {
    ctx: { now, userName: cfg.userName?.trim() || '', isSelf, tasks, meetings, people, scored, jiraIssues },
    allTasks,
  };
}

export async function loadPendingApprovals(): Promise<PendingJiraApproval[]> {
  const rows = await listPending();
  const out: PendingJiraApproval[] = [];
  for (const row of rows) {
    let entry: any = null;
    try { entry = await getWriteEntry(row._id); } catch { entry = null; }
    if (entry && entry.result !== 'pending-approval') continue; // stale queue row
    out.push(summarizePendingApproval(row, entry?.sourceMeetingId || null, entry));
  }
  return out;
}

async function loadJiraToday(now: Date, meetings: any[], allTasks: any[]): Promise<{ writesToday: any[]; pendingCount: number; linkedKeysToday: string[] } | null> {
  if (!isJiraConnected()) return null;
  const dayStart = startOfLocalDay(now).getTime();
  const [writesToday, pending] = await Promise.all([
    sorListRecent(200, dayStart).catch(() => [] as any[]),
    loadPendingApprovals().catch(() => [] as PendingJiraApproval[]),
  ]);
  const todayIds = new Set(meetings.filter((m: any) => { const ms = toMs(m.date); return ms !== null && ms >= dayStart && ms < startOfLocalDay(now, 1).getTime(); }).map((m: any) => m._id));
  const linkedKeysToday = allTasks
    .filter((t: any) => t.meetingId && todayIds.has(t.meetingId))
    .map((t: any) => (t.source?.type === 'jira' ? t.source.id : t.jiraKey))
    .filter((k: any): k is string => typeof k === 'string' && !!k);
  return { writesToday: writesToday.filter((w: any) => w.targetSystem === 'jira'), pendingCount: pending.length, linkedKeysToday };
}

function eventsForToday(events: CalendarEventLike[], now: Date): CalendarEventLike[] {
  const from = startOfLocalDay(now).getTime();
  const to = startOfLocalDay(now, 1).getTime();
  return events.filter((e) => { const s = toMs(e.startTime); return s !== null && s >= from && s < to; });
}

// ── Public reads ───────────────────────────────────────────────────────────

/** The current Ollie card payload, or null when nothing should render. */
export async function getOllieMoment(now: Date = new Date()): Promise<OllieMoment | null> {
  if (!deps) return null;
  const events = deps.getEvents();
  const settings = getNotificationSettings();
  const selected = selectOllieMoment({
    now,
    events,
    settings,
    dismissedKeys: getOllieMomentState().dismissedKeys,
    recordingActive: deps.isRecordingActive(),
  });
  if (!selected) return null;
  const { ctx, allTasks } = await loadContext(now);
  const generatedAt = now.getTime();

  if (selected.kind === 'prep') {
    const event = events.find((e) => e.id === selected.eventId);
    if (!event) return null;
    const prep = buildPrep({
      ...ctx,
      event,
      draftAgenda: draftAgendas.get(event.id) || null,
      pendingApprovals: await loadPendingApprovals(),
      recordArmed: armedEvents.has(event.id),
    });
    return { kind: 'prep', key: selected.key, generatedAt, prep };
  }

  if (selected.kind === 'wrap') {
    let executions: any[] = [];
    try { executions = await listActionExecutionsUpdatedSince(startOfLocalDay(now).toISOString()); } catch { executions = []; }
    const wrapUp = buildWrapUp({
      ...ctx,
      events,
      agendaEventIds: new Set(draftAgendas.keys()),
      cancelledToday: getOllieMomentState().cancelledEvents,
      allTasks,
      executions,
      slackSyncedAt: getSlackConnectionInfo().connected ? getLastSlackPollAt() : null,
      jiraToday: await loadJiraToday(now, ctx.meetings, allTasks),
    });
    return { kind: 'wrap', key: selected.key, generatedAt, wrapUp };
  }

  let welcomeBack: WelcomeBackContent | null = null;
  try { welcomeBack = await deps.getWelcomeBack(); } catch { welcomeBack = null; }
  const morning = buildMorning({ ...ctx, todayEvents: eventsForToday(events, now), welcomeBack });
  return { kind: 'morning', key: selected.key, generatedAt, morning };
}

/** Inline recap for one meeting row (any time after processing). */
export async function getProcessedSummary(meetingId: string): Promise<ProcessedContent | null> {
  const meeting = await getMeeting(meetingId);
  if (!meeting) return null;
  const [tasks, writes, pending] = await Promise.all([
    getTasks({ includeSnoozed: true }),
    sorListByMeeting(meetingId).catch(() => []),
    loadPendingApprovals().catch(() => [] as PendingJiraApproval[]),
  ]);
  return buildProcessed({
    meeting,
    tasks,
    sorWrites: writes,
    pendingApprovals: pending.filter((p) => p.meetingId === meetingId),
    slackConnected: getSlackConnectionInfo().connected,
  });
}

export async function getCatchUpNotes(now: Date = new Date()): Promise<CatchUpNote[]> {
  const { ctx } = await loadContext(now);
  return buildCatchUpNotes(computeCatchUp(ctx));
}

// ── Actions ────────────────────────────────────────────────────────────────

export function dismissOllieMoment(key: string): void {
  if (typeof key !== 'string' || !key) return;
  updateState((s) => { if (!s.dismissedKeys.includes(key)) s.dismissedKeys.push(key); });
  // The morning card carries welcome-back content; dismissing it also closes that gap.
  if (key.startsWith('morning:')) markWelcomeBackSeen();
  emitChanged({ reason: 'dismissed' });
}

export function setRecordAtStart(eventId: string, armed: boolean): boolean {
  if (armed) armedEvents.add(eventId);
  else armedEvents.delete(eventId);
  log('info', 'ollie:record-at-start', `${armed ? 'armed' : 'disarmed'} event=${eventId}`);
  rearmTimers();
  emitChanged({ reason: 'action' });
  return armedEvents.has(eventId);
}

export function isRecordArmed(eventId: string): boolean {
  return armedEvents.has(eventId);
}

export async function addTaskToTomorrow(taskId: string, now: Date = new Date()): Promise<any> {
  const dueDate = localDayKey(startOfLocalDay(now, 1));
  const task = await updateTask(taskId, { dueDate, updatedAt: new Date().toISOString() });
  emitChanged({ reason: 'action' });
  return task;
}

/** Remember an agenda the daily plan drafted so the prep card can show it. Session-only. */
export function rememberDraftAgenda(eventId: string, items: string[]): void {
  if (items.length > 0) draftAgendas.set(eventId, items.slice(0, 6));
}

export function notifySettingsChanged(): void {
  rearmTimers();
  emitChanged({ reason: 'settings' });
}

// ── Prep ───────────────────────────────────────────────────────────────────

async function firePrep(event: CalendarEventLike): Promise<void> {
  emitChanged({ reason: 'prep-start' });
  const settings = getNotificationSettings();
  const key = `prep:${event.id}`;
  if (settings.prep.mode !== 'notify' || wasNotified(key)) return;
  if (getOllieMomentState().dismissedKeys.includes(key)) return;
  markNotified(key);
  try {
    const { ctx } = await loadContext(new Date());
    const prep = buildPrep({
      ...ctx,
      event,
      draftAgenda: draftAgendas.get(event.id) || null,
      pendingApprovals: await loadPendingApprovals(),
      recordArmed: armedEvents.has(event.id),
    });
    // Prep is by definition before the meeting, so it is never queued.
    showNotification(prepNotificationCopy(prep), { kind: 'prep', key, eventId: event.id }, ['Open prep', 'Record at start'], (index) => {
      if (index === 1) setRecordAtStart(event.id, true);
      else focusMoment({ kind: 'prep', key, eventId: event.id });
    });
  } catch (err: any) {
    log('error', 'ollie:prep', err.message);
  }
}

function onEventStart(event: CalendarEventLike): void {
  emitChanged({ reason: 'meeting-start' });
  if (!armedEvents.has(event.id) || !deps) return;
  armedEvents.delete(event.id);
  log('info', 'ollie:record-at-start', `starting armed recording for "${event.title}"`);
  deps.startRecordingForEvent(event);
}

function clearPrepTimers(): void {
  for (const timers of prepTimers.values()) timers.forEach(clearTimeout);
  prepTimers.clear();
}

// ── Wrap-up ────────────────────────────────────────────────────────────────

async function fireWrapUp(): Promise<void> {
  wrapTimer = null;
  if (!deps) return;
  if (deps.isRecordingActive()) {
    wrapTimer = setTimeout(() => void fireWrapUp(), WRAP_RECHECK_MS);
    return;
  }
  const now = new Date();
  const key = `wrap:${localDayKey(now)}`;
  emitChanged({ reason: 'wrap' });
  if (getNotificationSettings().wrapUp !== 'notify' || wasNotified(key)) return;
  markNotified(key);
  enqueue(key, () => {
    void getOllieMoment().then((moment) => {
      if (!moment || moment.kind !== 'wrap') return;
      showNotification(wrapUpNotificationCopy(moment.wrapUp), { kind: 'wrap', key }, ['See wrap-up', 'Dismiss'], (index) => {
        if (index === 1) dismissOllieMoment(key);
        else focusMoment({ kind: 'wrap', key });
      });
    }).catch((err) => log('error', 'ollie:wrap', String(err)));
  });
}

// ── Processed ──────────────────────────────────────────────────────────────

/**
 * Call once a meeting's processing settles (success, needs-review or failure).
 * Replaces the old per-source "imported" / "pushed to Jira" / "failed"
 * notifications with one per meeting outcome.
 */
export async function announceProcessed(meetingId: string): Promise<void> {
  // Let the Jira pass for this meeting finish so the recap and the
  // notification show what was pushed and what waits for an OK.
  await waitForMeetingSync(meetingId).catch(() => undefined);
  emitChanged({ reason: 'processed', meetingId });
  try {
    if (getNotificationSettings().processed !== 'notify') return;
    const summary = await getProcessedSummary(meetingId);
    if (!summary) return;
    const key = `processed:${meetingId}:${summary.status}`;
    if (wasNotified(key)) return;
    markNotified(key);
    enqueue(key, () => {
      // Re-read at show time so a queued notification reflects approvals made meanwhile.
      void getProcessedSummary(meetingId).then((latest) => {
        const s = latest || summary;
        showNotification(processedNotificationCopy(s), { kind: 'processed', key, meetingId });
      }).catch((err) => log('error', 'ollie:processed', String(err)));
    });
  } catch (err: any) {
    log('error', 'ollie:processed', err.message);
  }
}

// ── Calendar wiring ────────────────────────────────────────────────────────

function rearmTimers(): void {
  if (!deps) return;
  const now = new Date();
  const nowMs = now.getTime();
  const events = deps.getEvents();
  const settings = getNotificationSettings();

  clearPrepTimers();
  for (const event of events) {
    const start = toMs(event.startTime);
    if (start === null || start - nowMs > PREP_HORIZON_MS) continue;
    const end = toMs(event.endTime);
    const timers: NodeJS.Timeout[] = [];
    // Refresh the card when the meeting ends; it shows the meeting until then.
    if (end !== null && end > nowMs) timers.push(setTimeout(() => emitChanged({ reason: 'meeting-end' }), end - nowMs));
    if (start <= nowMs) {
      if (timers.length) prepTimers.set(event.id, timers);
      continue;
    }
    if (settings.prep.mode !== 'off') {
      const fireAt = start - settings.prep.leadMinutes * 60_000;
      if (fireAt <= nowMs) void firePrep(event);
      else timers.push(setTimeout(() => void firePrep(event), fireAt - nowMs));
    }
    timers.push(setTimeout(() => onEventStart(event), start - nowMs));
    prepTimers.set(event.id, timers);
  }

  if (wrapTimer) clearTimeout(wrapTimer);
  wrapTimer = null;
  const wrapAt = settings.wrapUp === 'off' ? null : wrapUpStartsAt(events, now);
  if (wrapAt !== null) {
    if (wrapAt > nowMs) wrapTimer = setTimeout(() => void fireWrapUp(), wrapAt - nowMs);
    else if (!wasNotified(`wrap:${localDayKey(now)}`)) void fireWrapUp();
  }

  if (midnightTimer) clearTimeout(midnightTimer);
  midnightTimer = setTimeout(() => {
    previousToday = null;
    rearmTimers();
    emitChanged({ reason: 'day-change' });
  }, startOfLocalDay(now, 1).getTime() - nowMs + 1000);
}

/**
 * A today-event that disappears between two healthy refreshes was cancelled
 * (the watcher drops cancelled events at parse time). Guarded against feed
 * hiccups: skipped on the first refresh, on unhealthy polls, and when the
 * whole day vanished at once.
 */
function detectCancellations(events: CalendarEventLike[], healthy: boolean, now: Date): void {
  const today = new Map(eventsForToday(events, now).map((e) => [e.id, e]));
  const previous = previousToday;
  if (healthy) previousToday = today;
  if (!healthy || !previous) return;
  if (today.size === 0 && previous.size > 1) return;
  const gone = Array.from(previous.values()).filter((e) => !today.has(e.id));
  if (gone.length === 0) return;
  updateState((s) => {
    for (const e of gone) {
      if (s.cancelledEvents.some((c) => c.id === e.id)) continue;
      s.cancelledEvents.push({
        id: e.id,
        title: e.title,
        startTime: toMs(e.startTime) ?? now.getTime(),
        seriesUid: e.seriesUid ?? null,
        detectedAt: now.toISOString(),
      });
    }
  });
  for (const e of gone) armedEvents.delete(e.id);
  log('info', 'ollie:cancelled', `${gone.length} event(s) removed from today's calendar`);
}

/** Wire to calendarWatcher 'events-updated'. */
export function onCalendarEventsUpdated(events: CalendarEventLike[], healthy: boolean): void {
  if (!deps) return;
  detectCancellations(events, healthy, new Date());
  rearmTimers();
  emitChanged({ reason: 'calendar' });
}

export function initOllieMoments(d: OllieServiceDeps): void {
  deps = d;
  rearmTimers();
  if (queueTimer) clearInterval(queueTimer);
  queueTimer = setInterval(flushOllieQueue, QUEUE_FLUSH_MS);
}

export function stopOllieMoments(): void {
  clearPrepTimers();
  if (wrapTimer) clearTimeout(wrapTimer);
  if (midnightTimer) clearTimeout(midnightTimer);
  if (queueTimer) clearInterval(queueTimer);
  wrapTimer = midnightTimer = queueTimer = null;
}
