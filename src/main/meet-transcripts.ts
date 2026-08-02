import type { NormalizedTranscript } from './zoom-transcript-ingestion';

const UNKNOWN_SPEAKER = 'Unknown speaker';

export interface MeetConferenceItem {
  name: string;
  space: string;
  title: string;
  startedAt: string;
  endedAt: string;
}

export interface MeetTranscriptResource {
  name: string;
  state?: string;
  startTime?: string;
  endTime?: string;
}

export interface MeetParticipantResource {
  name: string;
  signedinUser?: { displayName?: string; user?: string };
  anonymousUser?: { displayName?: string };
  phoneUser?: { displayName?: string };
}

export interface MeetTranscriptEntryResource {
  name: string;
  participant: string;
  text: string;
  startTime: string;
  endTime: string;
  languageCode?: string;
}

function participantName(participant: MeetParticipantResource): string {
  return participant.signedinUser?.displayName
    || participant.anonymousUser?.displayName
    || participant.phoneUser?.displayName
    || UNKNOWN_SPEAKER;
}

function offsetMs(timestamp: string, conferenceStart: string): number {
  const offset = Date.parse(timestamp) - Date.parse(conferenceStart);
  return Number.isFinite(offset) ? Math.max(0, offset) : 0;
}

export function normalizeMeetTranscript(
  conference: MeetConferenceItem,
  transcript: MeetTranscriptResource,
  participants: MeetParticipantResource[],
  entries: MeetTranscriptEntryResource[],
): NormalizedTranscript {
  const names = new Map(participants.map((participant) => [participant.name, participantName(participant)]));
  const segments = entries
    .filter((entry) => entry.text?.trim())
    .map((entry) => ({
      speaker: names.get(entry.participant) || UNKNOWN_SPEAKER,
      startMs: offsetMs(entry.startTime, conference.startedAt),
      endMs: offsetMs(entry.endTime, conference.startedAt),
      text: entry.text.trim(),
    }))
    .sort((a, b) => a.startMs - b.startMs);

  return {
    meetingId: conference.name,
    externalId: transcript.name,
    title: conference.title,
    startedAt: conference.startedAt,
    segments,
    sourceMetadata: {
      meetConferenceRecord: conference.name,
      meetSpace: conference.space,
      meetTranscript: transcript.name,
      meetTranscriptState: transcript.state || null,
    },
  };
}
