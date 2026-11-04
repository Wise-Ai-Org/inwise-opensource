import { createMeetingFromTranscript, saveInsights, getMeetingBySourceExternalId, updateMeetingStatus } from './database';
import { extractInsights } from './extractor';

export interface NormalizedSegment {
  speaker: string;
  startMs: number;
  endMs: number;
  text: string;
}

export interface NormalizedTranscript {
  meetingId: string;
  title: string;
  startedAt: string; // ISO 8601
  segments: NormalizedSegment[];
  externalId?: string;
  sourceMetadata?: Record<string, any>;
}

export type NativeTranscriptSource =
  | 'zoom_cloud_recording'
  | 'teams_transcript'
  | 'meet_transcript';

export function segmentsToText(segments: NormalizedSegment[]): string {
  return segments.map(s => `${s.speaker}: ${s.text}`).join('\n');
}

/**
 * Ingests a NormalizedTranscript through the same mapping→de-dupe→upkeep
 * pipeline used by the desktop recorder. Returns the created meeting ID.
 */
const importsInFlight = new Map<string, Promise<string>>();

export function ingestNormalizedTranscript(
  nt: NormalizedTranscript,
  deps: { runInsights?: (content: string, meetingId: string) => Promise<void>; source?: NativeTranscriptSource } = {},
): Promise<string> {
  const key = `${deps.source || 'zoom_cloud_recording'}:${nt.externalId || nt.meetingId}`;
  const running = importsInFlight.get(key);
  if (running) return running;
  const promise = ingestOnce(nt, deps).finally(() => importsInFlight.delete(key));
  importsInFlight.set(key, promise);
  return promise;
}

async function ingestOnce(
  nt: NormalizedTranscript,
  deps: {
    runInsights?: (content: string, meetingId: string) => Promise<void>;
    source?: NativeTranscriptSource;
  } = {},
): Promise<string> {
  const content = segmentsToText(nt.segments);
  const source = deps.source ?? 'zoom_cloud_recording';

  if (!content.trim()) throw new Error('The native transcript contains no text.');
  const existing = await getMeetingBySourceExternalId(source, nt.externalId || nt.meetingId);
  if (existing?.transcript === content && existing?.insights?.summary) return existing._id;

  const meeting = await createMeetingFromTranscript({
    title: nt.title,
    content,
    date: nt.startedAt,
    source,
    externalId: nt.externalId || nt.meetingId,
    sourceMetadata: {
      platformMeetingId: nt.meetingId,
      ...(source === 'zoom_cloud_recording' ? { zoomMeetingId: nt.meetingId } : {}),
      ...nt.sourceMetadata,
    },
  });
  const meetingId = (meeting as any)._id as string;

  const runInsights = deps.runInsights ?? defaultRunInsights;
  try {
    await runInsights(content, meetingId);
  } catch {
    // insights are best-effort; meeting persists regardless
    await updateMeetingStatus(meetingId, 'transcribed');
  }

  return meetingId;
}

async function defaultRunInsights(content: string, meetingId: string): Promise<void> {
  const meeting = await import('./database').then(database => database.getMeeting(meetingId));
  const insights = await extractInsights(content, { meetingTitle: meeting?.title, meetingDate: meeting?.date });
  await saveInsights(meetingId, insights);
}
