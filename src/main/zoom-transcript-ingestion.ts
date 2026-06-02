import { createMeetingFromTranscript, saveInsights } from './database';
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
}

export function segmentsToText(segments: NormalizedSegment[]): string {
  return segments.map(s => `${s.speaker}: ${s.text}`).join('\n');
}

/**
 * Ingests a NormalizedTranscript through the same mapping→de-dupe→upkeep
 * pipeline used by the desktop recorder. Returns the created meeting ID.
 */
export async function ingestNormalizedTranscript(
  nt: NormalizedTranscript,
  deps: {
    runInsights?: (content: string, meetingId: string) => Promise<void>;
  } = {},
): Promise<string> {
  const content = segmentsToText(nt.segments);

  const meeting = await createMeetingFromTranscript({
    title: nt.title,
    content,
    date: nt.startedAt,
  });
  const meetingId = (meeting as any)._id as string;

  const runInsights = deps.runInsights ?? defaultRunInsights;
  try {
    await runInsights(content, meetingId);
  } catch {
    // insights are best-effort; meeting persists regardless
  }

  return meetingId;
}

async function defaultRunInsights(content: string, meetingId: string): Promise<void> {
  const insights = await extractInsights(content);
  await saveInsights(meetingId, insights);
}
