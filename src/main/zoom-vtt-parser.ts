import type { NormalizedTranscript, NormalizedSegment } from './zoom-transcript-ingestion';

type FetchFn = typeof fetch;

/**
 * Converts a VTT timestamp string (HH:MM:SS.mmm) to milliseconds.
 */
export function parseTimestampMs(ts: string): number {
  const dotIdx = ts.lastIndexOf('.');
  const fractional = dotIdx !== -1 ? parseInt(ts.slice(dotIdx + 1), 10) : 0;
  const timePart = dotIdx !== -1 ? ts.slice(0, dotIdx) : ts;
  const parts = timePart.split(':').map(Number);
  const [h, m, s] = parts.length === 3 ? parts : [0, ...parts];
  return (h * 3600 + m * 60 + s) * 1000 + fractional;
}

/**
 * Parses Zoom VTT content into a NormalizedTranscript.
 * Speaker labels follow the Zoom convention: "Speaker Name: text".
 * Cues without a speaker prefix are attributed to 'Unknown'.
 */
export function parseZoomVtt(
  vttContent: string,
  meetingId: string,
  title: string,
  startedAt: string,
): NormalizedTranscript {
  const segments: NormalizedSegment[] = [];
  const blocks = vttContent.split(/\r?\n\r?\n/).filter(s => s.trim());

  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

    if (lines[0] === 'WEBVTT' || lines[0].startsWith('NOTE')) continue;

    const tsIndex = lines.findIndex(l => l.includes(' --> '));
    if (tsIndex === -1) continue;

    const [startTs, endTs] = lines[tsIndex].split(' --> ').map(s => s.trim());
    const startMs = parseTimestampMs(startTs);
    const endMs = parseTimestampMs(endTs);

    const textLines = lines.slice(tsIndex + 1).join(' ');
    if (!textLines) continue;

    const colonIndex = textLines.indexOf(': ');
    const speaker = colonIndex !== -1 ? textLines.slice(0, colonIndex) : 'Unknown';
    const text = colonIndex !== -1 ? textLines.slice(colonIndex + 2) : textLines;

    segments.push({ speaker, startMs, endMs, text });
  }

  return { meetingId, title, startedAt, segments };
}

/**
 * Downloads a VTT transcript from Zoom and parses it into a NormalizedTranscript.
 */
export async function downloadAndParseVtt(
  downloadUrl: string,
  accessToken: string,
  meetingId: string,
  title: string,
  startedAt: string,
  deps: { fetchFn?: FetchFn } = {},
): Promise<NormalizedTranscript> {
  const fetchFn = deps.fetchFn ?? fetch;

  const res = await fetchFn(downloadUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to download VTT: HTTP ${res.status}: ${body}`);
  }

  const vttContent = await res.text();
  return parseZoomVtt(vttContent, meetingId, title, startedAt);
}
