import Store from 'electron-store';
import { storeLocationOptions } from './store-location';
import { getMeetStatus } from './meet-oauth';
import { getMeetConferenceRecord, listMeetConferenceRecords, parseMeetReference, resolveMeetConference } from './meet-api';
import type { MeetConferenceItem } from './meet-transcripts';
import { assertMeetConferenceName } from './meeting-attendance';
import { linkMeetConferenceToCalendarEvent } from './database';
import { log } from './logger';

type SavedConference = MeetConferenceItem & { calendarEventId?: string; capturedAt: string };
interface CalendarCall { id: string; title: string; startTime: Date | string; endTime: Date | string; meetingLink?: string }
let store: Store<{ records: SavedConference[] }> | undefined;
function recordStore() {
  if (!store) store = new Store<{ records: SavedConference[] }>({
    name: 'meet-conferences', defaults: { records: [] },
    ...(process.env.INWISE_TEST_CONFIG_DIR ? { cwd: process.env.INWISE_TEST_CONFIG_DIR } : storeLocationOptions()),
  });
  return store;
}

export function savedMeetConferences(): SavedConference[] {
  const cutoff = Date.now() - 30 * 86400_000;
  return recordStore().get('records').filter(record => Date.parse(record.startedAt) >= cutoff);
}

export function rememberMeetConference(conference: MeetConferenceItem, calendarEventId?: string): void {
  assertMeetConferenceName(conference.name);
  const records = savedMeetConferences();
  const existing = records.find(record => record.name === conference.name);
  const next = { ...existing, ...conference, calendarEventId: calendarEventId || existing?.calendarEventId, capturedAt: existing?.capturedAt || new Date().toISOString() };
  if (existing && JSON.stringify(existing) === JSON.stringify(next)) return;
  recordStore().set('records', [...records.filter(record => record.name !== conference.name), next]);
}

export interface TrackerDeps {
  resolve: (link: string) => Promise<MeetConferenceItem>;
  remember: (conference: MeetConferenceItem, calendarEventId: string) => void;
  link: (calendarEventId: string, conference: MeetConferenceItem) => Promise<void>;
}

export async function captureActiveMeetConferences(events: CalendarCall[], deps: TrackerDeps, now = Date.now()): Promise<void> {
  const handledLinks = new Set<string>();
  for (const event of events) {
    if (!event.meetingLink || Date.parse(String(event.startTime)) > now + 5 * 60_000 ||
        Date.parse(String(event.endTime)) < now - 10 * 60_000 ||
        !Number.isFinite(Date.parse(String(event.startTime))) || !Number.isFinite(Date.parse(String(event.endTime)))) continue;
    let code: string | undefined;
    try { code = parseMeetReference(event.meetingLink).code; } catch { continue; }
    if (!code || handledLinks.has(code)) continue;
    handledLinks.add(code);
    try {
      const record = { ...await deps.resolve(event.meetingLink), title: event.title };
      deps.remember(record, event.id);
      await deps.link(event.id, record);
    } catch (error: any) {
      if (error.code !== 'MEET_NO_ACTIVE_CONFERENCE') log('warn', 'meet:record-capture', `${event.title}: ${error.message}`);
    }
  }
}

/** Merge organizer discovery with direct reads of previously observed calls. */
export async function listAvailableMeetConferences(deps: {
  hosted?: () => Promise<MeetConferenceItem[]>;
  saved?: () => SavedConference[];
  get?: (name: string) => Promise<MeetConferenceItem>;
} = {}): Promise<MeetConferenceItem[]> {
  let hosted: MeetConferenceItem[] = [];
  let hostedError: unknown;
  try { hosted = await (deps.hosted ?? listMeetConferenceRecords)(); } catch (error) { hostedError = error; }
  const records = new Map(hosted.map(record => [record.name, record]));
  for (const saved of (deps.saved ?? savedMeetConferences)()) {
    if (records.has(saved.name)) continue;
    try {
      const record = await (deps.get ?? getMeetConferenceRecord)(saved.name);
      if (record.endedAt) records.set(record.name, { ...record, title: saved.title });
    } catch (error: any) { log('warn', 'meet:saved-record', error.message); }
  }
  if (!records.size && hostedError) throw hostedError;
  return [...records.values()].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let eventsProvider: () => CalendarCall[] = () => [];
export function setMeetCalendarProvider(provider: () => CalendarCall[]): void { eventsProvider = provider; }
export async function runMeetConferenceCapture(): Promise<void> {
  if (running) return;
  running = true;
  try {
    if (!(await getMeetStatus()).connected) return;
    await captureActiveMeetConferences(eventsProvider(), {
      resolve: resolveMeetConference, remember: rememberMeetConference, link: linkMeetConferenceToCalendarEvent,
    });
  } catch (error: any) { log('warn', 'meet:record-capture', error.message); }
  finally { running = false; }
}
export function startMeetConferenceTracker(): void {
  if (timer) return;
  void runMeetConferenceCapture();
  timer = setInterval(() => { void runMeetConferenceCapture(); }, 30_000);
}
export function stopMeetConferenceTracker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
