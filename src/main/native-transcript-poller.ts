import { getMeetStatus } from './meet-oauth';
import { getTeamsStatus } from './teams-oauth';
import { fetchMeetAttendance } from './meet-api';
import { listAvailableMeetConferences } from './meet-conference-tracker';
import { fetchTeamsAttendance, listTeamsMeetings } from './teams-api';
import { prepareMeetImport, prepareTeamsImport } from './native-transcript-import';
import { ingestNormalizedTranscript, NativeTranscriptSource, NormalizedTranscript, segmentsToText } from './zoom-transcript-ingestion';
import { getMeetingBySourceExternalId } from './database';
import { log } from './logger';

export type NativeProvider = 'meet' | 'teams';
export interface NativeSyncResult { checked: number; imported: number; skipped: number; unavailable: number; errors: string[] }
export interface NativeSyncDeps {
  connected: () => Promise<boolean>;
  list: () => Promise<any[]>;
  prepare: (meeting: any) => Promise<NormalizedTranscript>;
  existing: (source: NativeTranscriptSource, id: string) => Promise<any>;
  ingest: (transcript: NormalizedTranscript, source: NativeTranscriptSource) => Promise<string>;
  enrich?: (normalized: NormalizedTranscript, meeting: any) => Promise<void>;
  imported?: (id: string) => Promise<void>;
}

export async function syncNativeTranscripts(provider: NativeProvider, deps: NativeSyncDeps): Promise<NativeSyncResult> {
  const result: NativeSyncResult = { checked: 0, imported: 0, skipped: 0, unavailable: 0, errors: [] };
  if (!await deps.connected()) return result;
  const source = provider === 'meet' ? 'meet_transcript' : 'teams_transcript';
  const meetings = await deps.list();
  result.checked = meetings.length;
  for (const meeting of meetings) {
    try {
      const normalized = await deps.prepare(meeting);
      const existing = await deps.existing(source, normalized.externalId || normalized.meetingId);
      if (existing?.transcript === segmentsToText(normalized.segments) && existing?.insights?.summary) {
        result.skipped++;
        continue;
      }
      await deps.enrich?.(normalized, meeting);
      const id = await deps.ingest(normalized, source);
      result.imported++;
      await deps.imported?.(id);
    } catch (error: any) {
      if (/No native transcript is available/.test(error.message)) result.unavailable++;
      else result.errors.push(`${meeting.title}: ${error.message}`);
    }
  }
  return result;
}

let timer: ReturnType<typeof setInterval> | null = null;
const inFlight = new Map<NativeProvider, Promise<NativeSyncResult>>();
let listener: ((id: string) => Promise<void>) | undefined;
export function onNativeTranscriptImported(callback: (id: string) => Promise<void>): void { listener = callback; }

export function runNativeTranscriptSync(provider: NativeProvider): Promise<NativeSyncResult> {
  const running = inFlight.get(provider);
  if (running) return running;
  const promise = syncNativeTranscripts(provider, {
    connected: async () => (await (provider === 'meet' ? getMeetStatus() : getTeamsStatus())).connected,
    list: () => provider === 'meet' ? listAvailableMeetConferences() : listTeamsMeetings(),
    prepare: meeting => provider === 'meet' ? prepareMeetImport(meeting, false) : prepareTeamsImport(meeting, false),
    existing: getMeetingBySourceExternalId,
    enrich: async (normalized, meeting) => {
      const metadata = normalized.sourceMetadata || {};
      try { metadata.attendance = provider === 'meet' ? await fetchMeetAttendance(meeting) : await fetchTeamsAttendance(meeting); }
      catch (error: any) { metadata.attendanceError = error.message; }
      normalized.sourceMetadata = metadata;
    },
    ingest: (normalized, source) => ingestNormalizedTranscript(normalized, { source }),
    imported: id => listener?.(id) ?? Promise.resolve(),
  }).then(result => {
    if (result.errors.length) log('warn', `${provider}:sync`, result.errors.join('; '));
    return result;
  }).finally(() => inFlight.delete(provider));
  inFlight.set(provider, promise);
  return promise;
}

export function startNativeTranscriptPoller(): void {
  if (timer) return;
  const poll = async () => {
    for (const provider of ['meet', 'teams'] as const) {
      try { await runNativeTranscriptSync(provider); }
      catch (error: any) { log('error', `${provider}:sync`, error.message); }
    }
  };
  void poll();
  timer = setInterval(() => { void poll(); }, 15 * 60 * 1000);
}
export function stopNativeTranscriptPoller(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
