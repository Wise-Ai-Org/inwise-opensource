import { EventEmitter } from 'events';
import { getConfig } from './config';
import * as ical from 'node-ical';

interface CalendarEvent {
  id: string;
  title: string;
  startTime: Date;
  endTime: Date;
  meetingLink?: string;
}

const MEETING_LINK_RE = /zoom\.us|teams\.microsoft|meet\.google|webex\.com|whereby\.com/i;
const POLL_INTERVAL_MS = 10 * 60_000; // 10 minutes
const START_WINDOW_MS  = 2 * 60_000;  // trigger recording within 2 min of start
const LOOKAHEAD_DAYS   = 28;

export class CalendarWatcher extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private notifiedIds = new Set<string>();
  private cachedEvents: CalendarEvent[] = [];

  start(): void {
    this.poll();
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  getUpcomingEvents(): CalendarEvent[] {
    return this.cachedEvents;
  }

  async testUrl(url: string): Promise<{ ok: boolean; eventCount: number; error?: string }> {
    try {
      const events = await fetchIcsEvents(url);
      return { ok: true, eventCount: events.length };
    } catch (e: any) {
      return { ok: false, eventCount: 0, error: e.message };
    }
  }

  private async poll(): Promise<void> {
    const config = getConfig();
    const urls = [config.googleIcsUrl, config.outlookIcsUrl].filter(Boolean);
    if (urls.length === 0) return;

    const now = Date.now();
    const allEvents: CalendarEvent[] = [];

    for (const url of urls) {
      try {
        const events = await fetchIcsEvents(url);
        allEvents.push(...events);
        for (const event of events) {
          const msUntilStart = event.startTime.getTime() - now;
          if (
            msUntilStart >= 0 &&
            msUntilStart <= START_WINDOW_MS &&
            event.meetingLink &&
            !this.notifiedIds.has(event.id)
          ) {
            this.notifiedIds.add(event.id);
            this.emit('meeting-starting', event);
          }
        }
      } catch {
        // URL temporarily unreachable — retry next poll
      }
    }

    // Deduplicate by id and sort by start time
    const seen = new Set<string>();
    this.cachedEvents = allEvents
      .filter(e => { if (seen.has(e.id)) return false; seen.add(e.id); return true; })
      .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

    this.emit('events-updated', this.cachedEvents);
  }
}

async function fetchIcsEvents(url: string): Promise<CalendarEvent[]> {
  const data = await ical.async.fromURL(url);
  const now = new Date();
  const lookahead = new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60_000);

  const events: CalendarEvent[] = [];

  for (const key of Object.keys(data)) {
    const item = data[key] as any;
    if (item.type !== 'VEVENT') continue;

    const start = item.start ? new Date(item.start) : null;
    const end = item.end ? new Date(item.end) : null;
    if (!start || start < now || start > lookahead) continue;

    const description = item.description || '';
    const location = item.location || '';
    const summary = item.summary || 'Meeting';

    const meetingLink =
      extractLink(description) ||
      extractLink(location) ||
      (item.url && MEETING_LINK_RE.test(item.url) ? item.url : undefined);

    events.push({
      id: item.uid || key,
      title: summary,
      startTime: start,
      endTime: end || new Date(start.getTime() + 60 * 60_000),
      meetingLink,
    });
  }

  return events;
}

function extractLink(text: string): string | undefined {
  const matches = text.match(/https?:\/\/[^\s"<>\n]+/g);
  return matches?.find(url => MEETING_LINK_RE.test(url));
}
