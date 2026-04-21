import { EventEmitter } from 'events';
import { listCalendars } from './config';
import { log } from './logger';
import * as ical from 'node-ical';

interface CalendarEvent {
  id: string;
  title: string;
  startTime: Date;
  endTime: Date;
  meetingLink?: string;
  attendees: string[];
  sourceCalendarId: string;
}

export interface CalendarHealth {
  status: 'unknown' | 'ok' | 'error' | 'no-url';
  lastPollAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  eventCount: number;
  /** @deprecated derived from calendars[]; will be removed when Settings UI is migrated */
  googleConfigured: boolean;
  /** @deprecated derived from calendars[]; will be removed when Settings UI is migrated */
  outlookConfigured: boolean;
}

const MEETING_LINK_RE = /zoom\.us|teams\.microsoft|meet\.google|webex\.com|whereby\.com/i;
const POLL_INTERVAL_MS = 5 * 60_000;  // 5 minutes
const START_WINDOW_MS  = 5 * 60_000;  // trigger within 5 min of start (matches poll interval)
const LOOKAHEAD_DAYS   = 28;
const FETCH_TIMEOUT_MS = 30_000;       // 30s timeout for ICS fetch

export class CalendarWatcher extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private notifiedIds = new Set<string>();
  private cachedEvents: CalendarEvent[] = [];
  private health: CalendarHealth = {
    status: 'unknown',
    lastPollAt: null,
    lastSuccessAt: null,
    lastError: null,
    eventCount: 0,
    googleConfigured: false,
    outlookConfigured: false,
  };

  start(): void {
    log('info', 'calendar-watcher:start', 'Starting calendar polling');
    this.poll();
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    log('info', 'calendar-watcher:stop', 'Stopped calendar polling');
  }

  getUpcomingEvents(): CalendarEvent[] {
    return this.cachedEvents;
  }

  getHealth(): CalendarHealth {
    return { ...this.health };
  }

  /** Force an immediate re-poll (e.g. after a calendar is added, toggled, or removed). */
  async refresh(): Promise<void> {
    await this.poll();
  }

  async testUrl(url: string): Promise<{ ok: boolean; eventCount: number; error?: string }> {
    try {
      const events = await fetchIcsEvents(url, '__test__');
      return { ok: true, eventCount: events.length };
    } catch (e: any) {
      return { ok: false, eventCount: 0, error: classifyError(e) };
    }
  }

  private async poll(): Promise<void> {
    const enabled = listCalendars().filter((c) => c.enabled && c.url.trim());

    this.health.googleConfigured = enabled.some((c) => c.provider === 'google');
    this.health.outlookConfigured = enabled.some((c) => c.provider === 'outlook');

    if (enabled.length === 0) {
      this.health.status = 'no-url';
      log('info', 'calendar-watcher:poll', 'No enabled calendars — skipping');
      return;
    }

    this.health.lastPollAt = Date.now();
    const now = Date.now();

    const results = await Promise.allSettled(
      enabled.map(async (cal) => {
        log('info', 'calendar-watcher:fetch', `calendarId=${cal.id} label="${cal.label}" fetching…`);
        const events = await fetchIcsEventsWithTimeout(cal.url, cal.id);
        log('info', 'calendar-watcher:fetch', `calendarId=${cal.id} label="${cal.label}" got=${events.length} events`);
        return { cal, events };
      }),
    );

    const allEvents: CalendarEvent[] = [];
    let succeeded = 0;
    let failed = 0;
    let lastErrorMsg: string | null = null;

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const cal = enabled[i];
      if (r.status === 'fulfilled') {
        succeeded++;
        allEvents.push(...r.value.events);
      } else {
        failed++;
        const friendly = classifyError(r.reason);
        lastErrorMsg = friendly;
        log('error', 'calendar-watcher:fetch', `calendarId=${cal.id} label="${cal.label}" ${friendly} | raw: ${r.reason?.message ?? r.reason}`);
      }
    }

    if (failed === 0) {
      this.health.status = 'ok';
      this.health.lastSuccessAt = Date.now();
      this.health.lastError = null;
    } else if (succeeded > 0) {
      this.health.status = 'ok';
      this.health.lastSuccessAt = Date.now();
      this.health.lastError = lastErrorMsg;
    } else {
      this.health.status = 'error';
      this.health.lastError = lastErrorMsg;
    }

    // De-duplicate by composite key (id + startTime ISO).
    // On collision: prefer entry with more attendees; tie → first-fetched wins.
    const dedup = new Map<string, CalendarEvent>();
    for (const ev of allEvents) {
      const key = `${ev.id}|${ev.startTime.toISOString()}`;
      const existing = dedup.get(key);
      if (!existing) {
        dedup.set(key, ev);
        continue;
      }
      if (ev.attendees.length > existing.attendees.length) {
        dedup.set(key, ev);
      }
    }

    this.cachedEvents = Array.from(dedup.values()).sort(
      (a, b) => a.startTime.getTime() - b.startTime.getTime(),
    );
    this.health.eventCount = this.cachedEvents.length;

    // Fire start/reminder notifications from the deduped list so we don't notify twice
    // when the same event is on two synced calendars.
    for (const event of this.cachedEvents) {
      const msUntilStart = event.startTime.getTime() - now;
      if (
        msUntilStart >= 0 &&
        msUntilStart <= START_WINDOW_MS &&
        !this.notifiedIds.has(event.id)
      ) {
        this.notifiedIds.add(event.id);
        log('info', 'calendar-watcher:notify', `${event.meetingLink ? 'meeting-starting' : 'meeting-reminder'}: "${event.title}" starts in ${Math.round(msUntilStart / 60_000)}m`);
        if (event.meetingLink) {
          this.emit('meeting-starting', event);
        } else {
          this.emit('meeting-reminder', event);
        }
      }
    }

    log('info', 'calendar-watcher:poll', `Done — total=${this.cachedEvents.length} unique events across ${enabled.length} calendars`);
    this.emit('events-updated', this.cachedEvents);
  }
}

function classifyError(e: any): string {
  const msg = (e?.message || '').toLowerCase();
  const code = e?.code || '';

  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || msg.includes('timeout')) {
    return 'Calendar feed timed out. Check your internet connection.';
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return 'Could not reach the calendar server. Check your internet connection.';
  }
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET') {
    return 'Connection to calendar server was refused or reset.';
  }
  if (msg.includes('404') || msg.includes('not found')) {
    return 'Calendar URL not found (404). The link may have expired — try re-copying it from your calendar settings.';
  }
  if (msg.includes('403') || msg.includes('forbidden')) {
    return 'Access denied (403). The calendar link may have been revoked. Re-copy it from your calendar settings.';
  }
  if (msg.includes('401') || msg.includes('unauthorized')) {
    return 'Authentication failed. The calendar link may have expired. Re-copy it from your calendar settings.';
  }
  if (msg.includes('ssl') || msg.includes('certificate') || msg.includes('cert')) {
    return 'SSL/certificate error connecting to calendar server.';
  }
  if (msg.includes('parse') || msg.includes('invalid')) {
    return 'The calendar data could not be parsed. The URL may not be a valid ICS feed.';
  }

  return `Calendar sync failed: ${e?.message || 'unknown error'}`;
}

async function fetchIcsEventsWithTimeout(url: string, calendarId: string): Promise<CalendarEvent[]> {
  return new Promise<CalendarEvent[]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), FETCH_TIMEOUT_MS);
    fetchIcsEvents(url, calendarId)
      .then(events => { clearTimeout(timer); resolve(events); })
      .catch(err => { clearTimeout(timer); reject(err); });
  });
}

async function fetchIcsEvents(url: string, calendarId: string): Promise<CalendarEvent[]> {
  const data = await ical.async.fromURL(url);
  const now = new Date();
  const lookahead = new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60_000);

  const events: CalendarEvent[] = [];

  // Keep events from the past 7 days so unrecorded meetings remain visible
  const todayStart = new Date();
  todayStart.setDate(todayStart.getDate() - 7);
  todayStart.setHours(0, 0, 0, 0);

  let totalVevents = 0;
  let skippedNoAttendees = 0;
  let skippedOutOfRange = 0;

  for (const key of Object.keys(data)) {
    const item = data[key] as any;
    if (item.type !== 'VEVENT') continue;
    totalVevents++;

    const description = item.description || '';
    const location = item.location || '';
    const summary = item.summary || 'Meeting';
    const duration = item.end && item.start
      ? new Date(item.end).getTime() - new Date(item.start).getTime()
      : 60 * 60_000;

    // Skip events with no guests (solo blocks, reminders, etc.)
    // Note: ICS feeds often omit the calendar owner from the attendee list,
    // so a 1:1 meeting may only show 1 attendee (the other person).
    const rawAttendees = item.attendee
      ? Array.isArray(item.attendee) ? item.attendee : [item.attendee]
      : [];
    if (rawAttendees.length < 1) {
      skippedNoAttendees++;
      continue;
    }

    const attendeeNames = rawAttendees.map((a: any) => {
      if (typeof a === 'string') return a.replace(/^mailto:/i, '');
      const cn = a.params?.CN;
      if (cn) return cn.replace(/^["']|["']$/g, '');
      const val = typeof a.val === 'string' ? a.val : '';
      return val.replace(/^mailto:/i, '');
    }).filter(Boolean);

    const meetingLink =
      extractLink(description) ||
      extractLink(location) ||
      (item.url && MEETING_LINK_RE.test(item.url) ? item.url : undefined);

    // Expand recurring events
    if (item.rrule) {
      const occurrences: Date[] = item.rrule.between(todayStart, lookahead, true);
      for (const occ of occurrences) {
        events.push({
          id: `${item.uid || key}_${occ.getTime()}`,
          title: summary,
          startTime: occ,
          endTime: new Date(occ.getTime() + duration),
          meetingLink,
          attendees: attendeeNames,
          sourceCalendarId: calendarId,
        });
      }
      continue;
    }

    const start = item.start ? new Date(item.start) : null;
    if (!start || start < todayStart || start > lookahead) {
      skippedOutOfRange++;
      continue;
    }

    events.push({
      id: item.uid || key,
      title: summary,
      startTime: start,
      endTime: new Date(start.getTime() + duration),
      meetingLink,
      attendees: attendeeNames,
      sourceCalendarId: calendarId,
    });
  }

  log('info', 'calendar-watcher:parse', `${totalVevents} VEVENTs in feed, ${events.length} kept, ${skippedNoAttendees} skipped (no attendees), ${skippedOutOfRange} skipped (out of range)`);

  return events;
}

function extractLink(text: string): string | undefined {
  const matches = text.match(/https?:\/\/[^\s"<>\n]+/g);
  return matches?.find(url => MEETING_LINK_RE.test(url));
}
