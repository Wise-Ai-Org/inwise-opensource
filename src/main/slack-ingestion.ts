/**
 * Ingestion batching + quiet-period debounce for Slack threads.
 *
 * A thread is eligible for processing only after its latest activity has been
 * quiet for at least `inactivityWindowMin` minutes. Loose top-level messages
 * (no replies) are batched per channel per poll window.
 *
 * State is kept in-memory; US-005 layers cursor + dedup persistence on top.
 */

import { SlackMessage } from './slack-client';
import { log } from './logger';
import { isThreadProcessed, markThreadIngested, removeThreadIngested } from './slack-cursor-store';

// ── Thread state tracking ──────────────────────────────────────────────────

interface ThreadState {
  /** Slack ts of the parent message */
  threadTs: string;
  /** ts of the most recent reply (or parent ts if no replies) */
  latestActivityTs: string;
  /** Epoch ms when we first saw this thread */
  firstSeenMs: number;
  /** Epoch ms when we last processed this thread, or 0 if never */
  lastProcessedMs: number;
  /** latestActivityTs at the time of last processing — used to detect new replies */
  latestActivityAtLastProcess: string;
}

// channelId -> (threadTs -> ThreadState)
const channelThreadState = new Map<string, Map<string, ThreadState>>();

function getChannelState(channelId: string): Map<string, ThreadState> {
  if (!channelThreadState.has(channelId)) {
    channelThreadState.set(channelId, new Map());
  }
  return channelThreadState.get(channelId)!;
}

function tsToMs(ts: string): number {
  return Math.floor(parseFloat(ts) * 1000);
}

// ── Batching result types ──────────────────────────────────────────────────

export interface ThreadBatch {
  /** ts of the parent message — use getThreadReplies(channelId, threadTs) */
  threadTs: string;
  /** Messages in the thread (parent + replies already fetched by the poller) */
  messages: SlackMessage[];
}

export interface LooseMessageBatch {
  /** All loose top-level messages for this channel in this poll window */
  messages: SlackMessage[];
}

export interface IngestBatchResult {
  /** Threads that are quiet and ready to process */
  readyThreads: ThreadBatch[];
  /** Loose messages batched for this channel */
  looseBatch: LooseMessageBatch | null;
}

// ── Core debounce logic ────────────────────────────────────────────────────

/**
 * Given raw channel history, decide what is ready for ingestion.
 *
 * Combines in-memory quiet-period tracking with persistent dedup from
 * slack-cursor-store so that re-running on an unchanged channel produces
 * zero new conversations.
 *
 * @param channelId  - Slack channel ID
 * @param messages   - Messages from getChannelHistory() (newest first from Slack,
 *                     but we handle either order)
 * @param threadRepliesMap - Pre-fetched replies keyed by threadTs
 * @param inactivityWindowMin - Minutes of silence before a thread is eligible
 * @param nowMs      - Current epoch ms (injected for testability)
 */
export function computeReadyBatches(
  channelId: string,
  messages: SlackMessage[],
  threadRepliesMap: Map<string, SlackMessage[]>,
  inactivityWindowMin: number,
  nowMs: number = Date.now(),
): IngestBatchResult {
  const inactivityMs = inactivityWindowMin * 60 * 1000;
  const state = getChannelState(channelId);

  const readyThreads: ThreadBatch[] = [];
  const looseMessages: SlackMessage[] = [];

  // Separate threads from loose messages
  for (const msg of messages) {
    const isThreadParent = msg.threadTs === undefined || msg.threadTs === msg.ts;
    const hasReplies = (msg.replyCount ?? 0) > 0;

    if (isThreadParent && hasReplies) {
      // This is a thread parent
      const latestActivity = msg.latestReply ?? msg.ts;
      const existing = state.get(msg.ts);

      if (existing) {
        // Update latest activity
        existing.latestActivityTs = latestActivity;
      } else {
        state.set(msg.ts, {
          threadTs: msg.ts,
          latestActivityTs: latestActivity,
          firstSeenMs: tsToMs(msg.ts),
          lastProcessedMs: 0,
          latestActivityAtLastProcess: '',
        });
      }
    } else if (isThreadParent && !hasReplies) {
      // Loose top-level message
      looseMessages.push(msg);
    }
    // Reply messages (threadTs !== ts) are handled via threadRepliesMap
  }

  // Evaluate each tracked thread for readiness
  for (const [threadTs, ts] of state) {
    const latestMs = tsToMs(ts.latestActivityTs);
    const quietMs = nowMs - latestMs;
    const isQuiet = quietMs >= inactivityMs;

    if (!isQuiet) {
      log('info', 'slack:ingestion', `Thread ${threadTs} still active (quiet ${Math.round(quietMs / 60000)}m / need ${inactivityWindowMin}m)`);
      continue;
    }

    const hasNewReplies = ts.lastProcessedMs === 0
      || ts.latestActivityTs !== ts.latestActivityAtLastProcess;

    // Also check persistent dedup: if persisted as processed and no new replies, skip
    const alreadyIngested = isThreadProcessed(channelId, threadTs);
    if (alreadyIngested && !hasNewReplies) {
      log('info', 'slack:ingestion', `Thread ${threadTs} already processed and unchanged`);
      continue;
    }

    // If thread got new replies, remove from dedup so it re-routes through the pipeline
    if (alreadyIngested && hasNewReplies) {
      removeThreadIngested(channelId, threadTs);
    }

    const replies = threadRepliesMap.get(threadTs) ?? [];
    readyThreads.push({ threadTs, messages: replies });
    log('info', 'slack:ingestion', `Thread ${threadTs} ready (quiet ${Math.round(quietMs / 60000)}m, ${replies.length} messages)`);
  }

  const looseBatch = looseMessages.length > 0 ? { messages: looseMessages } : null;

  return { readyThreads, looseBatch };
}

/**
 * Mark a thread as processed. Updates both in-memory state and persistent dedup.
 * Call after successful ingestion.
 */
export function markThreadProcessed(channelId: string, threadTs: string): void {
  const state = getChannelState(channelId);
  const ts = state.get(threadTs);
  if (ts) {
    ts.lastProcessedMs = Date.now();
    ts.latestActivityAtLastProcess = ts.latestActivityTs;
  }
  // Persist to cursor store so dedup survives restarts
  markThreadIngested(channelId, threadTs);
  log('info', 'slack:ingestion', `Marked thread ${threadTs} processed`);
}

/**
 * Clear all in-memory state for a channel (e.g. on disconnect or reset).
 */
export function clearChannelState(channelId: string): void {
  channelThreadState.delete(channelId);
}
