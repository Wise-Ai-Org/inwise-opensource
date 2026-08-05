/** Persistent Slack timestamp cursors, pending quiet threads, and dedup state. */

import { storeLocationOptions } from './store-location';

export interface SlackPendingThread {
  threadTs: string;
  latestActivityTs: string;
  discoveredAtMs: number;
}

interface SlackCursorState {
  /** channelId -> newest fully consumed top-level message timestamp */
  cursors: Record<string, string>;
  /** channelId -> thread timestamps successfully ingested */
  processedThreads: Record<string, string[]>;
  /** channelId -> threadTs -> thread waiting for its inactivity window */
  pendingThreads: Record<string, Record<string, SlackPendingThread>>;
  /** Retained for compatibility with stores written by the first poller. */
  looseMessageCursors: Record<string, string>;
}

interface SlackStateStore {
  get(key: keyof SlackCursorState): any;
  set(key: keyof SlackCursorState, value: any): void;
}

let cursorStore: SlackStateStore | null = null;

function activeStore(): SlackStateStore {
  if (!cursorStore) {
    const Store = require('electron-store') as typeof import('electron-store');
    cursorStore = new Store<SlackCursorState>({
      ...storeLocationOptions(),
      name: 'slack-cursor-state',
      defaults: {
        cursors: {},
        processedThreads: {},
        pendingThreads: {},
        looseMessageCursors: {},
      },
    });
  }
  return cursorStore!;
}

function appLog(message: string, detail?: string): void {
  try {
    (require('./logger') as typeof import('./logger')).log('info', message, detail);
  } catch {
    // State persistence is more important than optional logging.
  }
}

/** Test seam; production always uses the electron-store instance above. */
export function __setSlackCursorStoreForTests(store: SlackStateStore): void {
  cursorStore = store;
}

function recordValue<T>(key: keyof SlackCursorState): Record<string, T> {
  return (activeStore().get(key) as Record<string, T> | undefined) ?? {};
}

export function getChannelCursor(channelId: string): string | undefined {
  return recordValue<string>('cursors')[channelId];
}

export function setChannelCursor(channelId: string, ts: string): void {
  const cursors = { ...recordValue<string>('cursors'), [channelId]: ts };
  activeStore().set('cursors', cursors);
  appLog('slack:cursor', `Channel ${channelId} cursor → ${ts}`);
}

export function advanceCursorToNewest(channelId: string, messageTsList: string[]): void {
  if (messageTsList.length === 0) return;
  const newest = messageTsList.reduce((a, b) => (parseFloat(a) > parseFloat(b) ? a : b));
  setChannelCursor(channelId, newest);
}

export function getPendingThreads(channelId: string): SlackPendingThread[] {
  const all = recordValue<Record<string, SlackPendingThread>>('pendingThreads');
  return Object.values(all[channelId] ?? {}).sort(
    (a, b) => parseFloat(a.threadTs) - parseFloat(b.threadTs),
  );
}

export function upsertPendingThread(
  channelId: string,
  threadTs: string,
  latestActivityTs: string,
  discoveredAtMs: number = Date.now(),
): SlackPendingThread {
  const all = { ...recordValue<Record<string, SlackPendingThread>>('pendingThreads') };
  const channel = { ...(all[channelId] ?? {}) };
  const existing = channel[threadTs];
  const pending: SlackPendingThread = {
    threadTs,
    latestActivityTs,
    discoveredAtMs: existing?.discoveredAtMs ?? discoveredAtMs,
  };
  channel[threadTs] = pending;
  all[channelId] = channel;
  activeStore().set('pendingThreads', all);
  return pending;
}

export function removePendingThread(channelId: string, threadTs: string): void {
  const all = { ...recordValue<Record<string, SlackPendingThread>>('pendingThreads') };
  const channel = { ...(all[channelId] ?? {}) };
  delete channel[threadTs];
  if (Object.keys(channel).length > 0) all[channelId] = channel;
  else delete all[channelId];
  activeStore().set('pendingThreads', all);
}

export function isThreadProcessed(channelId: string, threadTs: string): boolean {
  return (recordValue<string[]>('processedThreads')[channelId] ?? []).includes(threadTs);
}

export function markThreadIngested(channelId: string, threadTs: string): void {
  const all = { ...recordValue<string[]>('processedThreads') };
  const processed = all[channelId] ?? [];
  if (!processed.includes(threadTs)) {
    all[channelId] = [...processed, threadTs];
    activeStore().set('processedThreads', all);
    appLog('slack:cursor', `Thread ${threadTs} in ${channelId} marked ingested`);
  }
}

export function removeThreadIngested(channelId: string, threadTs: string): void {
  const all = { ...recordValue<string[]>('processedThreads') };
  all[channelId] = (all[channelId] ?? []).filter((ts) => ts !== threadTs);
  activeStore().set('processedThreads', all);
}

export function resetChannelState(channelId: string): void {
  const cursors = { ...recordValue<string>('cursors') };
  delete cursors[channelId];
  activeStore().set('cursors', cursors);

  const processed = { ...recordValue<string[]>('processedThreads') };
  delete processed[channelId];
  activeStore().set('processedThreads', processed);

  const pending = { ...recordValue<Record<string, SlackPendingThread>>('pendingThreads') };
  delete pending[channelId];
  activeStore().set('pendingThreads', pending);

  const loose = { ...recordValue<string>('looseMessageCursors') };
  delete loose[channelId];
  activeStore().set('looseMessageCursors', loose);

  appLog('slack:cursor', `Reset all state for channel ${channelId}`);
}
