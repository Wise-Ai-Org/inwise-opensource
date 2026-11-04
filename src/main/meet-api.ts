import { getValidMeetToken } from './meet-oauth';
import {
  MeetConferenceItem,
  MeetParticipantResource,
  MeetTranscriptEntryResource,
  MeetTranscriptResource,
  normalizeMeetTranscript,
} from './meet-transcripts';
import type { NormalizedTranscript } from './zoom-transcript-ingestion';
import { MeetingAttendance, assertMeetConferenceName, validAttendanceTime } from './meeting-attendance';

const MEET_API = 'https://meet.googleapis.com/v2';
type FetchFn = typeof fetch;

function meetErrorDetail(status: number, body: string): string {
  let message = body;
  try {
    const parsed = JSON.parse(body) as any;
    message = parsed?.error?.message || body;
  } catch {
    // Keep raw body.
  }
  if (status === 401) return 'Google Meet authorization expired. Reconnect in Settings.';
  if (status === 403) {
    return 'Google denied Meet transcript access. Enable the Google Meet REST API and confirm the meetings.space.readonly scope is allowed for this account.';
  }
  if (status === 404) return 'This Google Meet conference record is no longer available. Meet records expire 30 days after a conference ends.';
  if (status === 429) return 'Google Meet rate limit reached. Wait a moment and try again.';
  return `Google Meet API returned HTTP ${status}: ${message}`;
}

async function meetJson(url: string, token: string, fetchFn: FetchFn): Promise<any> {
  const response = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await response.text();
  if (!response.ok) throw new Error(meetErrorDetail(response.status, body));
  return body ? JSON.parse(body) : {};
}

function conferenceTitle(startedAt: string): string {
  const utc = startedAt.replace('T', ' ').replace(/:\d\d(?:\.\d+)?Z$/, ' UTC');
  return `Google Meet — ${utc}`;
}

export async function getMeetConferenceRecord(
  name: string,
  deps: { getToken?: () => Promise<string>; fetchFn?: FetchFn } = {},
): Promise<MeetConferenceItem> {
  assertMeetConferenceName(name);
  const token = await (deps.getToken ?? getValidMeetToken)();
  const record = await meetJson(`${MEET_API}/${name}`, token, deps.fetchFn ?? fetch);
  if (record.name !== name || !Number.isFinite(Date.parse(record.startTime))) {
    throw new Error('Google returned an invalid conference record.');
  }
  return { name, space: record.space || '', title: conferenceTitle(record.startTime), startedAt: record.startTime, endedAt: record.endTime || '' };
}

export function parseMeetReference(reference: string): { record?: string; code?: string } {
  const value = reference.trim();
  if (/^conferenceRecords\/[\w-]+$/.test(value)) return { record: value };
  if (/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(value)) return { code: value.toLowerCase() };
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') throw new Error();
    if (url.hostname === 'meet.googleapis.com' && /^\/v2\/conferenceRecords\/[\w-]+$/.test(url.pathname)) {
      return { record: url.pathname.slice(4) };
    }
    if (url.hostname === 'meet.google.com' && /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/i.test(url.pathname)) {
      return { code: url.pathname.split('/')[1].toLowerCase() };
    }
  } catch { /* Reject URLs outside the documented Meet formats. */ }
  throw new Error('Enter a Google Meet link or a shared conferenceRecords/... reference.');
}

/** A participant can resolve the active record from a calendar meeting link. */
export async function resolveMeetConference(
  reference: string,
  deps: { getToken?: () => Promise<string>; fetchFn?: FetchFn } = {},
): Promise<MeetConferenceItem> {
  const parsed = parseMeetReference(reference);
  if (parsed.record) return getMeetConferenceRecord(parsed.record, deps);
  const token = await (deps.getToken ?? getValidMeetToken)();
  const fetchFn = deps.fetchFn ?? fetch;
  const space = await meetJson(`${MEET_API}/spaces/${parsed.code}`, token, fetchFn);
  const name = space.activeConference?.conferenceRecord;
  if (!name) {
    const error = new Error('This meeting has no active call. For an earlier call, use its shared conference record. Inwise can save the record automatically while a calendar call is active.');
    Object.assign(error, { code: 'MEET_NO_ACTIVE_CONFERENCE' });
    throw error;
  }
  return getMeetConferenceRecord(name, { getToken: async () => token, fetchFn });
}

export async function listMeetConferenceRecords(
  deps: { getToken?: () => Promise<string>; fetchFn?: FetchFn; now?: Date } = {},
): Promise<MeetConferenceItem[]> {
  const token = await (deps.getToken ?? getValidMeetToken)();
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? new Date();
  const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const records: MeetConferenceItem[] = [];
  const seenTokens = new Set<string>();
  let pageToken = '';

  do {
    if (pageToken) {
      if (seenTokens.has(pageToken)) throw new Error('Google Meet returned a repeated pagination token');
      seenTokens.add(pageToken);
    }
    const url = new URL(`${MEET_API}/conferenceRecords`);
    url.search = new URLSearchParams({
      pageSize: '100',
      filter: `start_time>="${start}"`,
      ...(pageToken ? { pageToken } : {}),
    }).toString();
    const data = await meetJson(url.toString(), token, fetchFn);
    for (const record of data.conferenceRecords ?? []) {
      if (!record?.name || !record?.startTime || !record?.endTime) continue;
      records.push({
        name: record.name,
        space: record.space || '',
        title: conferenceTitle(record.startTime),
        startedAt: record.startTime,
        endedAt: record.endTime,
      });
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  return records;
}

async function listMeetPages<T>(options: {
  path: string;
  arrayKey: string;
  pageSize: number;
  token: string;
  fetchFn: FetchFn;
}): Promise<T[]> {
  const items: T[] = [];
  const seenTokens = new Set<string>();
  let pageToken = '';
  do {
    if (pageToken) {
      if (seenTokens.has(pageToken)) throw new Error('Google Meet returned a repeated pagination token');
      seenTokens.add(pageToken);
    }
    const url = new URL(`${MEET_API}/${options.path}`);
    url.search = new URLSearchParams({
      pageSize: String(options.pageSize),
      ...(pageToken ? { pageToken } : {}),
    }).toString();
    const data = await meetJson(url.toString(), options.token, options.fetchFn);
    items.push(...(data[options.arrayKey] ?? []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return items;
}

export async function fetchMeetTranscript(
  conference: MeetConferenceItem,
  deps: { getToken?: () => Promise<string>; fetchFn?: FetchFn } = {},
): Promise<NormalizedTranscript> {
  assertMeetConferenceName(conference.name);
  const token = await (deps.getToken ?? getValidMeetToken)();
  const fetchFn = deps.fetchFn ?? fetch;
  const transcripts = await listMeetPages<MeetTranscriptResource>({
    path: `${conference.name}/transcripts`,
    arrayKey: 'transcripts',
    pageSize: 100,
    token,
    fetchFn,
  });
  // ENDED means Google is still generating the transcript artifact. Structured
  // entries are ready only after the state advances to FILE_GENERATED.
  const completed = transcripts.filter((transcript) => transcript.state === 'FILE_GENERATED');
  if (completed.length === 0) {
    throw new Error('No native transcript is available for this Google Meet conference. Transcription must have been enabled during the meeting.');
  }
  const transcript = [...completed].sort((a, b) =>
    Date.parse(b.startTime || '') - Date.parse(a.startTime || '')
  )[0];

  const [participants, entries] = await Promise.all([
    listMeetPages<MeetParticipantResource>({
      path: `${conference.name}/participants`,
      arrayKey: 'participants',
      pageSize: 250,
      token,
      fetchFn,
    }),
    listMeetPages<MeetTranscriptEntryResource>({
      path: `${transcript.name}/entries`,
      arrayKey: 'transcriptEntries',
      pageSize: 100,
      token,
      fetchFn,
    }),
  ]);
  if (entries.length === 0) throw new Error('Google Meet returned an empty native transcript for this conference.');
  return normalizeMeetTranscript(conference, transcript, participants, entries);
}

/** Attendance exists independently of whether transcription was enabled. */
export async function fetchMeetAttendance(
  conference: MeetConferenceItem,
  deps: { getToken?: () => Promise<string>; fetchFn?: FetchFn } = {},
): Promise<MeetingAttendance> {
  assertMeetConferenceName(conference.name);
  const token = await (deps.getToken ?? getValidMeetToken)();
  const fetchFn = deps.fetchFn ?? fetch;
  const participants = await listMeetPages<MeetParticipantResource>({
    path: `${conference.name}/participants`, arrayKey: 'participants', pageSize: 250, token, fetchFn,
  });
  const result: MeetingAttendance = { provider: 'meet', meetingId: conference.name, fetchedAt: new Date().toISOString(), participants: [] };
  for (const participant of participants) {
    if (!participant.name.startsWith(`${conference.name}/participants/`) ||
        !/^conferenceRecords\/[\w-]+\/participants\/[\w-]+$/.test(participant.name)) {
      throw new Error('Google Meet returned an invalid participant resource');
    }
    const sessions = await listMeetPages<any>({
      path: `${participant.name}/participantSessions`, arrayKey: 'participantSessions', pageSize: 100, token, fetchFn,
    });
    result.participants.push({
      id: participant.signedinUser?.user || participant.name,
      name: participant.signedinUser?.displayName || participant.anonymousUser?.displayName || participant.phoneUser?.displayName || 'Unknown participant',
      identityKind: participant.signedinUser ? 'signed_in' : participant.phoneUser ? 'phone' : 'anonymous',
      sessions: sessions.map(session => ({ id: session.name, joinedAt: validAttendanceTime(session.startTime), leftAt: validAttendanceTime(session.endTime) })),
    });
  }
  return result;
}
