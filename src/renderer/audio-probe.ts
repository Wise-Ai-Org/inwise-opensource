export type SystemAudioCaptureState = 'ok' | 'pending' | 'missing';
export const SYSTEM_AUDIO_PENDING_GRACE_MS = 60_000;

export interface MediaPermissionSnapshot {
  platform: string;
  microphone: string;
  screen: string;
}

export async function measureStreamRms(stream: MediaStream, timeoutMs: number): Promise<number> {
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let maxRms = 0;
  const startedAt = Date.now();
  try {
    while (Date.now() - startedAt < timeoutMs) {
      analyser.getFloatTimeDomainData(samples);
      let sumSquares = 0;
      for (let i = 0; i < samples.length; i++) sumSquares += samples[i] * samples[i];
      maxRms = Math.max(maxRms, Math.sqrt(sumSquares / samples.length));
      if (maxRms > 0.001) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return maxRms;
  } finally {
    source.disconnect();
    await context.close();
  }
}

export function classifySystemAudioCapture(
  streamAvailable: boolean,
  maxRms: number,
  permissions: MediaPermissionSnapshot,
): SystemAudioCaptureState {
  if (!streamAvailable) return 'missing';
  if (maxRms > 0.001) return 'ok';
  if (
    permissions.platform === 'darwin' &&
    permissions.screen !== 'denied' &&
    permissions.screen !== 'restricted'
  ) {
    // Silence at the start of a Mac capture is common. Keep the stream alive so
    // the first remote speaker is not permanently lost.
    return 'pending';
  }
  return 'missing';
}

/**
 * A CoreAudio capture denied by macOS can look live while producing permanent
 * zeros. Preserve genuinely quiet calls for a grace period, then surface the
 * failure without tearing down the stream so capture can recover if audio
 * arrives later.
 */
export function classifyPendingSystemAudio(
  maxRms: number,
  silentForMs: number,
  graceMs = SYSTEM_AUDIO_PENDING_GRACE_MS,
): SystemAudioCaptureState {
  if (maxRms > 0.001) return 'ok';
  return silentForMs >= graceMs ? 'missing' : 'pending';
}
