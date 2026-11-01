export type RecordingStage = 'capture' | 'saving' | 'decode' | 'transcribing' | 'insights';
export function recordingFailure(stage: RecordingStage, audioSaved: boolean) {
  const message = {
    capture: audioSaved ? 'Recording was interrupted. Captured audio is saved; retry processing or export it.' : 'The microphone recording was interrupted before audio could be saved. Check the device and record again.',
    saving: 'The recording could not be saved. Keep this window open and try saving again.',
    decode: audioSaved ? 'The audio could not be read. The original recording is saved; retry processing or export it.' : 'The saved audio is unavailable. Restore an exported recording or record again.',
    transcribing: audioSaved ? 'Transcription failed. Your audio is saved; check transcription settings and retry.' : 'Transcription failed and the saved audio is unavailable. Restore an exported recording or add a transcript.',
    insights: 'Insights could not be generated. Your transcript is saved; check AI settings and retry.',
  }[stage];
  return { stage, message, audioSaved, retryable: audioSaved, occurredAt: new Date().toISOString() };
}
