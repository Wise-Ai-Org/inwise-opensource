export const RECORDING_SILENCE_RESPONSE_MS = 30 * 1000;

export interface RecordingSilencePrompt {
  title: string;
  deadlineAt: number;
  responseMs: number;
}

export function buildRecordingSilencePrompt(
  rawTitle: unknown,
  now = Date.now(),
  responseMs = RECORDING_SILENCE_RESPONSE_MS,
): RecordingSilencePrompt {
  const title = typeof rawTitle === 'string' ? rawTitle.trim().slice(0, 120) : '';
  const safeResponseMs = Number.isFinite(responseMs) && responseMs > 0
    ? Math.round(responseMs)
    : RECORDING_SILENCE_RESPONSE_MS;
  return {
    title: title || 'This recording',
    deadlineAt: now + safeResponseMs,
    responseMs: safeResponseMs,
  };
}

export function recordingSilenceSecondsRemaining(deadlineAt: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((deadlineAt - now) / 1000));
}
