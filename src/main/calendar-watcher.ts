import { EventEmitter } from 'events';
import { getConfig } from './config';
import { log } from './logger';
import * as ical from 'node-ical';

interface CalendarEvent {
  id: string;
  title: string;
  startTime: Date;
  endTime: Date;
  meetingLink?: string;
  attendees: string[];
}

export interface CalendarHealth {
  status: 'unknown' | 'ok' | 'error' | 'no-url';
  lastPollAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  eventCount: number;
  googleConfigured: boolean;
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

  async testUrl(url: string): Promise<{ ok: boolean; eventCount: number; error?: string }> {
    try {
      const events = await fetchIcsEvents(url);
      return { ok: true, eventCount: events.length };
    } catch (e: any) {
      return { ok: false, eventCount: 0, error: classifyError(e) };
    }
  }

  private async poll(): Promise<void> {
    const config = getConfig();
    const googleUrl = config.googleIcsUrl?.trim();
    const outlookUrl = config.outlookIcsUrl?.trim();

    this.health.googleConfigured = !!googleUrl;
    this.health.outlookConfigured = !!outlookUrl;

    const urls = [googleUrl, outlookUrl].filter(Boolean) as string[];
    if (urls.length === 0) {
      this.health.status = 'no-url';
      log('info', 'calendar-watcher:poll', 'No calendar URLs configured — skipping');
      return;
    }

    this.health.lastPollAt = Date.now();
    const now = Date.now();
    const allEvents: CalendarEvent[] = [];
    let hadError = false;

    for (const url of urls) {
      const source = url.includes('google') ? 'google' : 'outlook';
      try {
        log('info', `calendar-watcher:fetch:${source}`, 'Fetching ICS feed…');
        const events = await fetchIcsEventsWithTimeout(url);
        log('info', `calendar-watcher:fetch:${source}`, `Got ${events.length} events`);
        allEvents.push(...events);

        for (const event of events) {
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
      } catch (e: any) {
        hadError = true;
        const friendly = classifyError(e);
        this.health.lastError = friendly;
        log('error', `calendar-watcher:fetch:${source}`, `${friendly} | raw: ${e.message}`);
      }
    }

    if (!hadError) {
      this.health.status = 'ok';
      this.health.lastSuccessAt = Date.now();
      this.health.lastError = null;
    } else if (allEvents.length > 0) {
      // One source failed but the other worked
      this.health.status = 'ok';
      this.health.lastSuccessAt = Date.now();
    } else {
      this.health.status = 'error';
    }

    this.health.eventCount = allEvents.length;

    // Deduplicate by id and sort by start time
    const seen = new Set<string>();
    this.cachedEvents = allEvents
      .filter(e => { if (seen.has(e.id)) return false; seen.add(e.id); return true; })
      .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

    log('info', 'calendar-watcher:poll', `Done — ${this.cachedEvents.length} unique events cached`);
    this.emit('events-updated', this.cachedEvents);
  }
}

function classifyError(e: any): string {
  const msg = (e.message || '').toLowerCase();
  const code = e.code || '';

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

  return `Calendar sync failed: ${e.message || 'unknown error'}`;
}

async function fetchIcsEventsWithTimeout(url: string): Promise<CalendarEvent[]> {
  return new Promise<CalendarEvent[]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), FETCH_TIMEOUT_MS);
    fetchIcsEvents(url)
      .then(events => { clearTimeout(timer); resolve(events); })
      .catch(err => { clearTimeout(timer); reject(err); });
  });
}

async function fetchIcsEvents(url: string): Promise<CalendarEvent[]> {
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
    });
  }

  log('info', 'calendar-watcher:parse', `${totalVevents} VEVENTs in feed, ${events.length} kept, ${skippedNoAttendees} skipped (no attendees), ${skippedOutOfRange} skipped (out of range)`);

  return events;
}

function extractLink(text: string): string | undefined {
  const matches = text.match(/https?:\/\/[^\s"<>\n]+/g);
  return matches?.find(url => MEETING_LINK_RE.test(url));
}
