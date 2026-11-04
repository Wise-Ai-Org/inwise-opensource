import { getValidZoomToken } from './zoom-oauth';
import { log } from './logger';
import { zoomMeetingPathId } from './meeting-attendance';

const ZOOM_API = 'https://api.zoom.us/v2';

export interface ZoomRecordingItem {
  meetingId: string;
  uuid: string;
  title: string;
  startedAt: string; // ISO 8601
}

export type TranscriptResult =
  | { found: true; downloadUrl: string; accessToken: string }
  | { found: false; reason: string };

type FetchFn = typeof fetch;

export async function listZoomRecordings(
  deps: { getToken?: () => Promise<string>; fetchFn?: FetchFn } = {}
): Promise<ZoomRecordingItem[]> {
  const getToken = deps.getToken ?? getValidZoomToken;
  const fetchFn = deps.fetchFn ?? fetch;
  const token = await getToken();

  const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const to = new Date().toISOString().split('T')[0];

  const meetings: any[] = [];
  const seen = new Set<string>();
  let pageToken = '';
  do {
    if (pageToken && seen.has(pageToken)) throw new Error('Zoom returned a repeated recording pagination token');
    if (pageToken) seen.add(pageToken);
    const url = new URL(`${ZOOM_API}/users/me/recordings`);
    url.search = new URLSearchParams({ from, to, page_size: '50', ...(pageToken ? { next_page_token: pageToken } : {}) }).toString();
    const res = await fetchFn(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Zoom list recordings failed: HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json() as any;
    meetings.push(...(data.meetings || []));
    pageToken = data.next_page_token || '';
  } while (pageToken);
  return meetings.map(m => ({ meetingId: String(m.id), uuid: m.uuid, title: m.topic, startedAt: m.start_time }));
}

export async function getTranscriptDownloadUrl(
  meetingUuid: string,
  deps: { getToken?: () => Promise<string>; fetchFn?: FetchFn } = {}
): Promise<TranscriptResult> {
  const getToken = deps.getToken ?? getValidZoomToken;
  const fetchFn = deps.fetchFn ?? fetch;
  const token = await getToken();

  const encodedUuid = zoomMeetingPathId(meetingUuid);
  const url = `${ZOOM_API}/meetings/${encodedUuid}/recordings`;

  const res = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });

  if (!res.ok) {
    const body = await res.text();
    log('warn', 'zoom:recording-detail', `HTTP ${res.status}: ${body}`);
    return { found: false, reason: `Could not fetch recording: HTTP ${res.status}` };
  }

  const data = await res.json() as any;
  const files: any[] = data.recording_files ?? [];

  const transcriptFile = files.find(
    (f) => f.file_type === 'TRANSCRIPT' && f.status === 'completed'
  );

  if (!transcriptFile) {
    return { found: false, reason: 'No transcript available for this recording' };
  }

  return { found: true, downloadUrl: transcriptFile.download_url, accessToken: token };
}
