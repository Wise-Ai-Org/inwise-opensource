import { EventEmitter } from 'events';
import { getConfig } from './config';
import Store from 'electron-store';

interface CalendarEvent {
  id: string;
  title: string;
  startTime: Date;
  endTime: Date;
  meetingLink?: string;
}

interface CalendarStore {
  googleAccessToken: string;
  microsoftAccessToken: string;
  calendarProvider: 'google' | 'microsoft' | '';
}

const calendarStore = new Store<CalendarStore>({
  name: 'calendar',
  defaults: { googleAccessToken: '', microsoftAccessToken: '', calendarProvider: '' },
});

const MEETING_LINK_RE = /zoom\.us|teams\.microsoft|meet\.google/i;
const POLL_INTERVAL_MS = 60_000;
const START_WINDOW_MS = 2 * 60_000;

export class CalendarWatcher extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private notifiedIds = new Set<string>();

  start(): void {
    this.poll();
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  setTokens(provider: 'google' | 'microsoft', token: string): void {
    if (provider === 'google') calendarStore.set('googleAccessToken', token);
    else calendarStore.set('microsoftAccessToken', token);
    calendarStore.set('calendarProvider', provider);
  }

  private async poll(): Promise<void> {
    const provider = calendarStore.get('calendarProvider');
    if (!provider) return;

    try {
      const events = provider === 'google'
        ? await this.fetchGoogleEvents()
        : await this.fetchMicrosoftEvents();

      const now = Date.now();
      for (const event of events) {
        const msUntilStart = event.startTime.getTime() - now;
        if (msUntilStart >= 0 && msUntilStart <= START_WINDOW_MS && event.meetingLink && !this.notifiedIds.has(event.id)) {
          this.notifiedIds.add(event.id);
          this.emit('meeting-starting', event);
        }
      }
    } catch (err) {
      // Token may be expired — silently ignore
    }
  }

  private async fetchGoogleEvents(): Promise<CalendarEvent[]> {
    const token = calendarStore.get('googleAccessToken');
    if (!token) return [];

    const now = new Date();
    const end = new Date(now.getTime() + 30 * 60_000);
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
      `timeMin=${now.toISOString()}&timeMax=${end.toISOString()}&singleEvents=true`;

    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json() as any;

    return (data.items || []).map((item: any) => ({
      id: item.id,
      title: item.summary || 'Meeting',
      startTime: new Date(item.start?.dateTime || item.start?.date),
      endTime: new Date(item.end?.dateTime || item.end?.date),
      meetingLink: extractLink(item.description || '') || extractLink(item.location || '') || item.hangoutLink,
    })).filter((e: CalendarEvent) => e.meetingLink);
  }

  private async fetchMicrosoftEvents(): Promise<CalendarEvent[]> {
    const token = calendarStore.get('microsoftAccessToken');
    if (!token) return [];

    const now = new Date();
    const end = new Date(now.getTime() + 30 * 60_000);
    const url = `https://graph.microsoft.com/v1.0/me/calendarView?` +
      `startDateTime=${now.toISOString()}&endDateTime=${end.toISOString()}`;

    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json() as any;

    return (data.value || []).map((item: any) => ({
      id: item.id,
      title: item.subject || 'Meeting',
      startTime: new Date(item.start?.dateTime + 'Z'),
      endTime: new Date(item.end?.dateTime + 'Z'),
      meetingLink: item.onlineMeeting?.joinUrl || extractLink(item.bodyPreview || '') || extractLink(item.location?.displayName || ''),
    })).filter((e: CalendarEvent) => e.meetingLink);
  }
}

function extractLink(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s"<>]+/g);
  return match?.find(url => MEETING_LINK_RE.test(url));
}
