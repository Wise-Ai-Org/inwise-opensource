/**
 * Persistent cursor + dedup store for Slack ingestion.
 *
 * Tracks:
 * - per-channel last-seen cursors (oldest timestamp fetched, used as `oldest` param)
 * - per-channel set of already-processed thread timestamps
 *
 * Uses a separate electron-store file so it stays out of user-facing config.
 */

import Store from 'electron-store';
import { log } from './logger';
import { storeLocationOptions } from './store-location';

interface SlackCursorState {
  /** channelId -> oldest ts string used as the fetch cursor */
  cursors: Record<string, string>;
  /** channelId -> array of threadTs strings already ingested */
  processedThreads: Record<string, string[]>;
  /** channelId -> ts string for the latest loose-message batch boundary */
  looseMessageCursors: Record<string, string>;
}

const cursorStore = new Store<SlackCursorState>({
  ...storeLocationOptions(),
  name: 'slack-cursor-state',
  defaults: {
    cursors: {},
    processedThreads: {},
    looseMessageCursors: {},
  },
});

// ── Channel cursor (for getChannelHistory `oldest` param) ─────────────────

export function getChannelCursor(channelId: string): string | undefined {
  const cursors = cursorStore.get('cursors') as Record<string, string>;
  return cursors[channelId];
}

export function setChannelCursor(channelId: string, ts: string): void {
  const cursors = { ...(cursorStore.get('cursors') as Record<string, string>) };
  cursors[channelId] = ts;
  cursorStore.set('cursors', cursors);
  log('info', 'slack:cursor', `Channel ${channelId} cursor → ${ts}`);
}

// ── Thread dedup ───────────────────────────────────────────────────────────

export function isThreadProcessed(channelId: string, threadTs: string): boolean {
  const all = cursorStore.get('processedThreads') as Record<string, string[]>;
  const processed = all[channelId] ?? [];
  return processed.includes(threadTs);
}

export function markThreadIngested(channelId: string, threadTs: string): void {
  const all = { ...(cursorStore.get('processedThreads') as Record<string, string[]>) };
  const processed = all[channelId] ?? [];
  if (!processed.includes(threadTs)) {
    all[channelId] = [...processed, threadTs];
    cursorStore.set('processedThreads', all);
    log('info', 'slack:cursor', `Thread ${threadTs} in ${channelId} marked ingested`);
  }
}

export function removeThreadIngested(channelId: string, threadTs: string): void {
  const all = { ...(cursorStore.get('processedThreads') as Record<string, string[]>) };
  const processed = all[channelId] ?? [];
  all[channelId] = processed.filter(t => t !== threadTs);
  cursorStore.set('processedThreads', all);
  log('info', 'slack:cursor', `Thread ${threadTs} in ${channelId} removed from processed (will reprocess)`);
}

/**
 * Reset all state for a channel. Called on disconnect or when the user
 * removes a channel from the read list.
 */
export function resetChannelState(channelId: string): void {
  const cursors = { ...(cursorStore.get('cursors') as Record<string, string>) };
  delete cursors[channelId];
  cursorStore.set('cursors', cursors);

  const all = { ...(cursorStore.get('processedThreads') as Record<string, string[]>) };
  delete all[channelId];
  cursorStore.set('processedThreads', all);

  log('info', 'slack:cursor', `Reset all state for channel ${channelId}`);
}

/**
 * Advance the cursor to the most recent ts seen in a batch of messages.
 * Pass the newest message ts so future polls start from just after it.
 */
export function advanceCursorToNewest(channelId: string, messageTsList: string[]): void {
  if (messageTsList.length === 0) return;
  const newest = messageTsList.reduce((a, b) => (parseFloat(a) > parseFloat(b) ? a : b));
  setChannelCursor(channelId, newest);
}
