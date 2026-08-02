import type { NormalizedSegment, NormalizedTranscript } from './zoom-transcript-ingestion';
import { parseTimestampMs } from './zoom-vtt-parser';
import type { TeamsTranscriptArtifact } from './teams-api';

const UNKNOWN_SPEAKER = 'Unknown speaker';

function stripMarkup(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function parseCueText(raw: string, speakerAttributed: boolean): { speaker: string; text: string } {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const item = JSON.parse(trimmed) as any;
      if (typeof item.spokenText === 'string') {
        return {
          speaker: speakerAttributed && item.speakerName ? String(item.speakerName) : UNKNOWN_SPEAKER,
          text: String(item.spokenText).trim(),
        };
      }
    } catch {
      // Fall through to VTT/plain-text parsing.
    }
  }

  const voice = trimmed.match(/<v(?:\.[^\s>]*)*\s+([^>]+)>([\s\S]*?)(?:<\/v>|$)/i);
  if (voice) {
    return {
      speaker: speakerAttributed ? stripMarkup(voice[1]) : UNKNOWN_SPEAKER,
      text: stripMarkup(voice[2]),
    };
  }

  return { speaker: UNKNOWN_SPEAKER, text: stripMarkup(trimmed) };
}

export function parseTeamsVtt(artifact: TeamsTranscriptArtifact): NormalizedTranscript {
  const segments: NormalizedSegment[] = [];
  // The speaker-unattributed Graph format separates a cue timestamp and text
  // with an empty line. Collapse only that shape before normal VTT splitting.
  const normalizedContent = artifact.content.replace(
    /(-->[^\r\n]+)\r?\n\r?\n(?=\S)/g,
    '$1\n',
  );
  const blocks = normalizedContent.split(/\r?\n\r?\n/).filter((block) => block.trim());

  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines[0] === 'WEBVTT' || lines[0]?.startsWith('NOTE')) continue;
    const timestampIndex = lines.findIndex((line) => line.includes(' --> '));
    if (timestampIndex === -1) continue;
    const [rawStart, rawEndWithSettings] = lines[timestampIndex].split(' --> ');
    const rawEnd = rawEndWithSettings.trim().split(/\s+/)[0];
    const cue = parseCueText(lines.slice(timestampIndex + 1).join('\n'), artifact.speakerAttributed);
    if (!cue.text) continue;
    segments.push({
      speaker: cue.speaker,
      startMs: parseTimestampMs(rawStart.trim()),
      endMs: parseTimestampMs(rawEnd),
      text: cue.text,
    });
  }

  return {
    meetingId: artifact.onlineMeetingId,
    // A transcript ID is scoped to its online meeting. Persist the full
    // provider identity so two meetings cannot collide during de-duplication.
    externalId: `${artifact.onlineMeetingId}:${artifact.transcriptId}`,
    title: artifact.meeting.title,
    startedAt: artifact.meeting.startedAt,
    segments,
    sourceMetadata: {
      teamsEventId: artifact.meeting.eventId,
      teamsOnlineMeetingId: artifact.onlineMeetingId,
      teamsTranscriptId: artifact.transcriptId,
      teamsJoinWebUrl: artifact.meeting.joinWebUrl,
      speakerAttributed: artifact.speakerAttributed,
    },
  };
}
