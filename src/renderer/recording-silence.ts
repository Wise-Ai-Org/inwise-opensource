export const RECORDING_SILENCE_CHECK_IN_MS = 5 * 60 * 1000;
export const RECORDING_SOUND_RMS_THRESHOLD = 0.01;

/**
 * Tracks continuous quiet in the recorder's mixed mic/system-audio signal.
 * It emits once per quiet stretch and rearms as soon as sound returns.
 */
export class RecordingSilenceWatchdog {
  private lastSoundAt: number;
  private notifiedForCurrentSilence = false;

  constructor(
    private readonly timeoutMs = RECORDING_SILENCE_CHECK_IN_MS,
    private readonly soundThreshold = RECORDING_SOUND_RMS_THRESHOLD,
    now = Date.now(),
  ) {
    this.lastSoundAt = now;
  }

  reset(now = Date.now()): void {
    this.lastSoundAt = now;
    this.notifiedForCurrentSilence = false;
  }

  observe(rms: number, now = Date.now()): boolean {
    if (Number.isFinite(rms) && rms >= this.soundThreshold) {
      this.lastSoundAt = now;
      this.notifiedForCurrentSilence = false;
      return false;
    }

    if (this.notifiedForCurrentSilence || now - this.lastSoundAt < this.timeoutMs) {
      return false;
    }

    this.notifiedForCurrentSilence = true;
    return true;
  }
}
