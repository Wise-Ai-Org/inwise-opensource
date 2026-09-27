/**
 * Local Zoom transcript synchronization.
 *
 * The poller talks directly to Zoom, skips UUIDs already present in the local
 * meeting database, and imports completed VTT transcripts through the normal
 * local ingestion pipeline. Recordings whose transcript is still processing
 * remain unmarked, so a later poll retries them automatically.
 */

import { hasMeetingBySourceExternalId } from './database';
import { getZoomStatus } from './zoom-oauth';
import { listZoomRecordings, getTranscriptDownloadUrl, ZoomRecordingItem } from './zoom-recordings';
import { downloadAndParseVtt } from './zoom-vtt-parser';
import { ingestNormalizedTranscript } from './zoom-transcript-ingestion';
import { log } from './logger';

const DEFAULT_POLL_INTERVAL_MS = 15 * 60 * 1000;

type ImportedListener = (recording: ZoomRecordingItem, meetingId: string) => void | Promise<void>;

export interface ZoomPollResult {
  checked: number;
  imported: number;
  skipped: number;
  pending: number;
  failed: number;
}

export interface ZoomPollDeps {
  isConnected?: () => Promise<boolean>;
  listRecordings?: () => Promise<ZoomRecordingItem[]>;
  alreadyImported?: (uuid: string) => Promise<boolean>;
  importRecording?: (recording: ZoomRecordingItem) => Promise<string | null>;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollInFlight: Promise<ZoomPollResult> | null = null;
let importedListener: ImportedListener | null = null;

export function onZoomTranscriptImported(listener: ImportedListener): void {
  importedListener = listener;
}

async function defaultImportRecording(recording: ZoomRecordingItem): Promise<string | null> {
  const transcript = await getTranscriptDownloadUrl(recording.uuid);
  if (!transcript.found) {
    log('info', 'zoom:poll', `${recording.title}: ${transcript.reason}; will retry`);
    return null;
  }

  const normalized = await downloadAndParseVtt(
    transcript.downloadUrl,
    transcript.accessToken,
    recording.meetingId,
    recording.title,
    recording.startedAt,
  );
  normalized.externalId = recording.uuid;
  normalized.sourceMetadata = {
    zoomMeetingId: recording.meetingId,
    zoomUuid: recording.uuid,
    importedAutomatically: true,
  };
  return ingestNormalizedTranscript(normalized);
}

export async function syncZoomTranscripts(deps: ZoomPollDeps = {}): Promise<ZoomPollResult> {
  const result: ZoomPollResult = { checked: 0, imported: 0, skipped: 0, pending: 0, failed: 0 };
  const isConnected = deps.isConnected ?? (async () => (await getZoomStatus()).connected);
  if (!(await isConnected())) return result;

  const recordings = await (deps.listRecordings ?? listZoomRecordings)();
  result.checked = recordings.length;

  for (const recording of recordings) {
    try {
      const exists = await (deps.alreadyImported ?? ((uuid) =>
        hasMeetingBySourceExternalId('zoom_cloud_recording', uuid)))(recording.uuid);
      if (exists) {
        result.skipped++;
        continue;
      }

      const meetingId = await (deps.importRecording ?? defaultImportRecording)(recording);
      if (!meetingId) {
        result.pending++;
        continue;
      }

      result.imported++;
      if (importedListener) await importedListener(recording, meetingId);
      log('info', 'zoom:poll', `Imported "${recording.title}" (${recording.uuid})`);
    } catch (error: any) {
      result.failed++;
      log('error', 'zoom:poll', `${recording.title}: ${error?.message || String(error)}`);
    }
  }

  return result;
}

export function runZoomPollNow(deps: ZoomPollDeps = {}): Promise<ZoomPollResult> {
  if (pollInFlight) return pollInFlight;
  pollInFlight = syncZoomTranscripts(deps).finally(() => { pollInFlight = null; });
  return pollInFlight;
}

export function startZoomPoller(intervalMs: number = DEFAULT_POLL_INTERVAL_MS): void {
  if (pollTimer) return;
  log('info', 'zoom:poller', `Starting — interval ${intervalMs / 1000}s`);
  runZoomPollNow().catch(error => log('error', 'zoom:poller', `Initial sync failed: ${error.message}`));
  pollTimer = setInterval(() => {
    runZoomPollNow().catch(error => log('error', 'zoom:poller', `Sync failed: ${error.message}`));
  }, intervalMs);
}

export function stopZoomPoller(): void {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
  log('info', 'zoom:poller', 'Stopped');
}
