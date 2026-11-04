import { fetchMeetAttendance, fetchMeetTranscript } from './meet-api';
import { fetchTeamsAttendance, fetchTeamsTranscriptArtifact, TeamsMeetingItem } from './teams-api';
import type { MeetConferenceItem } from './meet-transcripts';
import type { NormalizedTranscript } from './zoom-transcript-ingestion';

export async function prepareMeetImport(conference: MeetConferenceItem, includeAttendance = true): Promise<NormalizedTranscript> {
  const normalized = await fetchMeetTranscript(conference);
  if (!includeAttendance) return normalized;
  try { normalized.sourceMetadata = { ...normalized.sourceMetadata, attendance: await fetchMeetAttendance(conference) }; }
  catch (error: any) { normalized.sourceMetadata = { ...normalized.sourceMetadata, attendanceError: error.message }; }
  return normalized;
}

export async function prepareTeamsImport(meeting: TeamsMeetingItem, includeAttendance = true): Promise<NormalizedTranscript> {
  const { parseTeamsVtt } = await import('./teams-vtt-parser');
  const artifact = await fetchTeamsTranscriptArtifact(meeting);
  const normalized = parseTeamsVtt(artifact);
  if (!normalized.segments.length) throw new Error('Microsoft returned an empty or unsupported Teams transcript.');
  normalized.sourceMetadata = { ...normalized.sourceMetadata, teamsMeeting: meeting };
  if (!includeAttendance) return normalized;
  try { normalized.sourceMetadata.attendance = await fetchTeamsAttendance(meeting); }
  catch (error: any) { normalized.sourceMetadata.attendanceError = error.message; }
  return normalized;
}
