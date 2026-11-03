/**
 * Pure compute for "is the user currently in a scheduled meeting?" that drives
 * US-008's LiveMeetingBanner. Kept free of electron imports so it can be unit-tested.
 *
 * Returns a compact payload (suitable for IPC, with Date→epoch-ms conversion) when
 * an eligible in-progress calendar event is found, otherwise null.
 *
 * Eligibility (all must hold):
 *   - startTime <= now <= (endTime || startTime + 90min)
 *   - !isRecordingActive (the user isn't already recording)
 *   - !overlayWindowOpen  (no active recording overlay from a prior run)
 *   - the event was not already recorded this session (recordedEventIds)
 */

export interface LiveMeetingCandidateEvent {
  id: string;
  title: string;
  startTime: Date;
  endTime?: Date;
  attendees?: string[];
}

export interface LiveMeetingInput {
  events: LiveMeetingCandidateEvent[];
  now: Date;
  isRecordingActive: boolean;
  overlayWindowOpen: boolean;
  /** Calendar event ids that already have a recording; never offered again. */
  recordedEventIds?: ReadonlySet<string>;
}

export interface LiveMeetingResult {
  id: string;
  title: string;
  /** epoch ms */
  startTime: number;
  /** epoch ms (either real end or start + 90min fallback) */
  endTime: number;
  attendees: string[];
}

export const LIVE_MEETING_FALLBACK_DURATION_MS = 90 * 60_000;

export function findLiveMeetingForBanner(input: LiveMeetingInput): LiveMeetingResult | null {
  if (input.isRecordingActive || input.overlayWindowOpen) return null;

  const nowMs = input.now.getTime();

  for (const ev of input.events) {
    if (input.recordedEventIds?.has(ev.id)) continue;
    const start = ev.startTime.getTime();
    const rawEnd = ev.endTime?.getTime();
    const end = rawEnd && rawEnd > start ? rawEnd : start + LIVE_MEETING_FALLBACK_DURATION_MS;
    if (start <= nowMs && nowMs <= end) {
      return {
        id: ev.id,
        title: ev.title,
        startTime: start,
        endTime: end,
        attendees: ev.attendees ?? [],
      };
    }
  }

  return null;
}
