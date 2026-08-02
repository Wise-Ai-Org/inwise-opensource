import { getValidTeamsToken } from './teams-oauth';

const GRAPH_API = 'https://graph.microsoft.com/v1.0';
type FetchFn = typeof fetch;

export interface TeamsMeetingItem {
  eventId: string;
  title: string;
  startedAt: string;
  endedAt: string;
  joinWebUrl: string;
}
export interface TeamsTranscriptArtifact {
  meeting: TeamsMeetingItem;
  onlineMeetingId: string;
  transcriptId: string;
  createdAt: string;
  content: string;
  speakerAttributed: boolean;
}

function graphDateTime(value: any): string {
  const dateTime = String(value?.dateTime || '');
  if (!dateTime) return '';
  if (/Z$|[+-]\d\d:\d\d$/.test(dateTime)) return new Date(dateTime).toISOString();
  return new Date(`${dateTime}Z`).toISOString();
}

function graphErrorDetail(status: number, body: string): string {
  let code = '';
  let innerCode = '';
  let message = body;
  try {
    const parsed = JSON.parse(body) as any;
    code = parsed?.error?.code || '';
    innerCode = parsed?.error?.innerError?.code || '';
    message = parsed?.error?.message || body;
  } catch {
    // Keep the response body as the diagnostic.
  }

  if (innerCode === 'GraphAccessToTranscriptsDisabled') {
    return 'Your Microsoft 365 administrator has disabled Graph transcript access for this tenant.';
  }
  if (status === 403 || /Authorization_RequestDenied|ErrorAccessDenied/i.test(code)) {
    return 'Microsoft denied transcript access. A tenant administrator must grant OnlineMeetingTranscript.Read.All and allow Graph transcript access.';
  }
  if (status === 404 || /ResourceNotFound/i.test(code)) {
    return 'This Teams meeting could not be resolved. It may have expired or may not be on your calendar invite.';
  }
  return `Microsoft Graph returned HTTP ${status}: ${message}`;
}

function assertGraphNextLink(nextLink: string): string {
  const url = new URL(nextLink);
  if (url.protocol !== 'https:' || url.hostname !== 'graph.microsoft.com') {
    throw new Error('Microsoft Graph returned an invalid pagination URL');
  }
  return url.toString();
}

async function graphJson(url: string, token: string, fetchFn: FetchFn): Promise<any> {
  const response = await fetchFn(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Prefer: 'outlook.timezone="UTC"',
    },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(graphErrorDetail(response.status, body));
  return body ? JSON.parse(body) : {};
}

export async function listTeamsMeetings(
  deps: { getToken?: () => Promise<string>; fetchFn?: FetchFn; now?: Date } = {},
): Promise<TeamsMeetingItem[]> {
  const token = await (deps.getToken ?? getValidTeamsToken)();
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? new Date();
  const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const end = now.toISOString();
  const initial = new URL(`${GRAPH_API}/me/calendarView`);
  initial.search = new URLSearchParams({
    startDateTime: start,
    endDateTime: end,
    '$select': 'id,subject,start,end,isOnlineMeeting,onlineMeeting',
    '$orderby': 'start/dateTime desc',
    '$top': '50',
  }).toString();

  const meetings: TeamsMeetingItem[] = [];
  let nextUrl: string | null = initial.toString();
  while (nextUrl) {
    const data = await graphJson(nextUrl, token, fetchFn);
    for (const event of data.value ?? []) {
      const joinWebUrl = event?.onlineMeeting?.joinUrl;
      if (!event?.isOnlineMeeting || !joinWebUrl || !/teams\.microsoft\.com/i.test(joinWebUrl)) continue;
      meetings.push({
        eventId: String(event.id),
        title: event.subject || 'Microsoft Teams meeting',
        startedAt: graphDateTime(event.start),
        endedAt: graphDateTime(event.end),
        joinWebUrl,
      });
    }
    nextUrl = data['@odata.nextLink'] ? assertGraphNextLink(data['@odata.nextLink']) : null;
  }
  return meetings;
}

async function resolveOnlineMeeting(
  meeting: TeamsMeetingItem,
  token: string,
  fetchFn: FetchFn,
): Promise<any> {
  const escapedJoinUrl = meeting.joinWebUrl.replace(/'/g, "''");
  const url = new URL(`${GRAPH_API}/me/onlineMeetings`);
  url.search = new URLSearchParams({
    '$filter': `JoinWebUrl eq '${escapedJoinUrl}'`,
    '$select': 'id,subject,startDateTime,endDateTime,joinWebUrl',
  }).toString();
  const data = await graphJson(url.toString(), token, fetchFn);
  const onlineMeeting = data.value?.[0];
  if (!onlineMeeting?.id) {
    throw new Error('No Teams online meeting matched this calendar event. The meeting may have expired or belong to another tenant.');
  }
  return onlineMeeting;
}

async function listAllTranscripts(
  onlineMeetingId: string,
  token: string,
  fetchFn: FetchFn,
): Promise<any[]> {
  const items: any[] = [];
  let nextUrl: string | null = `${GRAPH_API}/me/onlineMeetings/${encodeURIComponent(onlineMeetingId)}/transcripts?$top=50`;
  while (nextUrl) {
    const data = await graphJson(nextUrl, token, fetchFn);
    items.push(...(data.value ?? []));
    nextUrl = data['@odata.nextLink'] ? assertGraphNextLink(data['@odata.nextLink']) : null;
  }
  return items;
}

function isSpeakerAttributionDisabled(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as any;
    return parsed?.error?.innerError?.code === 'SpeakerAttributionNotAllowed';
  } catch {
    return /SpeakerAttributionNotAllowed/i.test(body);
  }
}

async function getTranscriptContent(
  onlineMeetingId: string,
  transcriptId: string,
  token: string,
  fetchFn: FetchFn,
): Promise<{ content: string; speakerAttributed: boolean }> {
  const url = `${GRAPH_API}/me/onlineMeetings/${encodeURIComponent(onlineMeetingId)}/transcripts/${encodeURIComponent(transcriptId)}/content`;
  let response = await fetchFn(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'text/vtt' },
  });
  let body = await response.text();
  if (response.status === 403 && isSpeakerAttributionDisabled(body)) {
    response = await fetchFn(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.microsoft.graph.transcript+text',
      },
    });
    body = await response.text();
    if (!response.ok) throw new Error(graphErrorDetail(response.status, body));
    return { content: body, speakerAttributed: false };
  }
  if (!response.ok) throw new Error(graphErrorDetail(response.status, body));
  return { content: body, speakerAttributed: true };
}

export async function fetchTeamsTranscriptArtifact(
  meeting: TeamsMeetingItem,
  deps: { getToken?: () => Promise<string>; fetchFn?: FetchFn } = {},
): Promise<TeamsTranscriptArtifact> {
  const token = await (deps.getToken ?? getValidTeamsToken)();
  const fetchFn = deps.fetchFn ?? fetch;
  const onlineMeeting = await resolveOnlineMeeting(meeting, token, fetchFn);
  const transcripts = await listAllTranscripts(onlineMeeting.id, token, fetchFn);
  if (transcripts.length === 0) {
    throw new Error('No native transcript is available for this Teams meeting. Transcription must have been enabled during the meeting.');
  }
  const transcript = [...transcripts].sort((a, b) =>
    Date.parse(b.createdDateTime || '') - Date.parse(a.createdDateTime || '')
  )[0];
  const downloaded = await getTranscriptContent(onlineMeeting.id, transcript.id, token, fetchFn);
  return {
    meeting,
    onlineMeetingId: onlineMeeting.id,
    transcriptId: transcript.id,
    createdAt: transcript.createdDateTime || meeting.startedAt,
    ...downloaded,
  };
}
