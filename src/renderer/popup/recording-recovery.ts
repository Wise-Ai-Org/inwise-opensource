import { decodeVoiceRecording } from '../voice-audio';
import { api } from './nav';

/**
 * Retry a meeting whose processing failed. When only audio was saved, decode
 * and transcribe it first, then rerun insights. Throws with a user-facing
 * message; resolves when the retry was accepted.
 */
export async function retrySavedRecording(meetingId: string, meeting?: any): Promise<void> {
  const current = meeting ?? await api().getMeeting?.(meetingId);
  if (!current?.transcript && current?.recordingRecovery?.format) {
    const saved = await api().getRecordingAudio(meetingId);
    const bytes = new Uint8Array(saved.bytes);
    let wav: Uint8Array;
    try { wav = await decodeVoiceRecording(bytes.buffer, saved.stereo); }
    catch { await api().reportRecordingFailure(meetingId, 'decode'); throw new Error('The saved audio could not be read. Export it for recovery; you do not need to delete it.'); }
    const transcribed = await api().transcribeVoiceMemo(wav, saved.durationSec, meetingId);
    if (!transcribed?.ok) throw new Error(transcribed?.error || 'Transcription failed; audio is saved.');
  }
  const result = await api().retryRecording(meetingId);
  if (!result?.ok) throw new Error(result?.error || 'Could not process this recording.');
}
