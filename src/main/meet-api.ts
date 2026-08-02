import { getValidMeetToken } from './meet-oauth';
import {
  MeetConferenceItem,
  MeetParticipantResource,
  MeetTranscriptEntryResource,
  MeetTranscriptResource,
  normalizeMeetTranscript,
} from './meet-transcripts';
import type { NormalizedTranscript } from './zoom-transcript-ingestion';

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
