/**
 * Polling loop for Slack channel ingestion.
 *
 * Fetches new messages from each selected read channel, runs them through
 * the normalize → batch/debounce → existing local task pipeline. Stores
 * cursors so re-runs always start from the last seen position.
 */

import { getChannelHistory, getThreadReplies, SlackMessage, isSlackConnected } from './slack-client';
import { computeReadyBatches, markThreadProcessed } from './slack-ingestion';
import { normalizeSlackThread } from './slack-normalizer';
import {
  getChannelCursor,
  advanceCursorToNewest,
} from './slack-cursor-store';
import { getConfig } from './config';
import { log } from './logger';

// Injected by main.ts after DB is ready
type PipelineFn = (channelId: string, channelName: string, messages: SlackMessage[]) => Promise<void>;

let pipelineFn: PipelineFn | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export function registerSlackPipeline(fn: PipelineFn): void {
  pipelineFn = fn;
}

// ── Poll a single channel ─────────────────────────────────────────────────

async function pollChannel(channelId: string, channelName: string, inactivityWindowMin: number): Promise<void> {
  log('info', 'slack:poll', `Polling #${channelName} (${channelId})`);

  const cursor = getChannelCursor(channelId);
  const { messages, nextCursor } = await getChannelHistory(channelId, cursor);

  if (messages.length === 0) {
    log('info', 'slack:poll', `No new messages in #${channelName}`);
    return;
  }

  // Advance cursor to the newest ts in this batch so the next poll starts after it
  advanceCursorToNewest(channelId, messages.map(m => m.ts));

  // Pre-fetch replies for all thread parents with replies
  const threadRepliesMap = new Map<string, SlackMessage[]>();
  const threadParents = messages.filter(
    m => (m.threadTs === undefined || m.threadTs === m.ts) && (m.replyCount ?? 0) > 0,
  );

  await Promise.all(
    threadParents.map(async (parent) => {
      try {
        const replies = await getThreadReplies(channelId, parent.ts);
        threadRepliesMap.set(parent.ts, replies);
      } catch (err: any) {
        log('warn', 'slack:poll', `Failed to fetch replies for ${parent.ts}: ${err.message}`);
      }
    }),
  );

  // Compute which threads are ready to ingest
  const { readyThreads, looseBatch } = computeReadyBatches(
    channelId,
    messages,
    threadRepliesMap,
    inactivityWindowMin,
  );

  // Process ready threads through the pipeline
  for (const batch of readyThreads) {
    if (!pipelineFn) continue;
    try {
      await pipelineFn(channelId, channelName, batch.messages);
      markThreadProcessed(channelId, batch.threadTs);
    } catch (err: any) {
      log('error', 'slack:poll', `Pipeline failed for thread ${batch.threadTs}: ${err.message}`);
    }
  }

  // Process loose messages as a single batch
  if (looseBatch && looseBatch.messages.length > 0 && pipelineFn) {
    try {
      await pipelineFn(channelId, channelName, looseBatch.messages);
    } catch (err: any) {
      log('error', 'slack:poll', `Pipeline failed for loose batch in #${channelName}: ${err.message}`);
    }
  }

  if (nextCursor) {
    // If Slack returned a pagination cursor, advance past the fetched page
    // (advanceCursorToNewest already moved us; nextCursor is for pagination not position)
    log('info', 'slack:poll', `#${channelName}: pagination cursor present (${nextCursor.slice(0, 12)}…)`);
  }
}

// ── Main poll loop ────────────────────────────────────────────────────────

async function runPoll(): Promise<void> {
  if (!isSlackConnected()) return;

  const config = getConfig();
  const readChannels: string[] = (config as any).slackReadChannels ?? [];
  const inactivityWindowMin: number = (config as any).slackInactivityWindowMin ?? 60;

  if (readChannels.length === 0) {
    log('info', 'slack:poll', 'No read channels configured — skipping poll');
    return;
  }

  // Build a quick name lookup from config-stored channel list if available,
  // otherwise fall back to channel ID as name placeholder
  for (const channelId of readChannels) {
    try {
      await pollChannel(channelId, channelId, inactivityWindowMin);
    } catch (err: any) {
      log('error', 'slack:poll', `Error polling channel ${channelId}: ${err.message}`);
    }
  }
}

// ── Start / stop ──────────────────────────────────────────────────────────

export function startSlackPoller(intervalMs: number = DEFAULT_POLL_INTERVAL_MS): void {
  if (pollTimer) return; // already running

  log('info', 'slack:poller', `Starting — interval ${intervalMs / 1000}s`);

  // Run immediately on start, then on the interval
  runPoll().catch(err => log('error', 'slack:poller', `Initial poll error: ${err.message}`));
  pollTimer = setInterval(() => {
    runPoll().catch(err => log('error', 'slack:poller', `Poll error: ${err.message}`));
  }, intervalMs);
}

export function stopSlackPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    log('info', 'slack:poller', 'Stopped');
  }
}
