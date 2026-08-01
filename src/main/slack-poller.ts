/**
 * Lossless Slack channel polling.
 *
 * History is fully paginated by slack-client before its timestamp cursor is
 * committed. Thread parents are first persisted as pending, then independently
 * rechecked until their inactivity window elapses. This lets an empty later
 * history poll mature a previously active thread without losing its messages.
 */

import { getChannelHistory, getThreadReplies, SlackMessage, getSlackConnectionInfo } from './slack-client';
import { isSlackThreadQuiet, latestSlackActivityTs, partitionSlackHistory } from './slack-ingestion';
import {
  SlackPendingThread,
  getChannelCursor,
  advanceCursorToNewest,
  getPendingThreads,
  upsertPendingThread,
  removePendingThread,
  isThreadProcessed,
  markThreadIngested,
} from './slack-cursor-store';

type PipelineFn = (channelId: string, channelName: string, messages: SlackMessage[]) => Promise<void>;

export interface SlackPollState {
  getCursor(channelId: string): string | undefined;
  advanceCursor(channelId: string, messageTsList: string[]): void;
  getPending(channelId: string): SlackPendingThread[];
  upsertPending(channelId: string, threadTs: string, latestActivityTs: string, discoveredAtMs?: number): SlackPendingThread;
  removePending(channelId: string, threadTs: string): void;
  isProcessed(channelId: string, threadTs: string): boolean;
  markProcessed(channelId: string, threadTs: string): void;
}

export interface SlackPollDeps {
  getHistory?: typeof getChannelHistory;
  getReplies?: typeof getThreadReplies;
  pipeline?: PipelineFn | null;
  state?: SlackPollState;
  nowMs?: () => number;
}

export interface SlackChannelPollResult {
  historyMessages: number;
  looseBatches: number;
  threadsImported: number;
  threadsPending: number;
  threadFailures: number;
  cursorAdvanced: boolean;
}

const defaultState: SlackPollState = {
  getCursor: getChannelCursor,
  advanceCursor: advanceCursorToNewest,
  getPending: getPendingThreads,
  upsertPending: upsertPendingThread,
  removePending: removePendingThread,
  isProcessed: isThreadProcessed,
  markProcessed: markThreadIngested,
};

let pipelineFn: PipelineFn | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollRunInFlight: Promise<void> | null = null;

const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;

function appLog(level: 'info' | 'warn' | 'error', message: string, detail?: string): void {
  try {
    (require('./logger') as typeof import('./logger')).log(level, message, detail);
  } catch {
    // Polling and its unit tests must not depend on Electron logging startup.
  }
}

export function registerSlackPipeline(fn: PipelineFn): void {
  pipelineFn = fn;
}

export async function pollSlackChannel(
  channelId: string,
  channelName: string,
  inactivityWindowMin: number,
  deps: SlackPollDeps = {},
): Promise<SlackChannelPollResult> {
  const state = deps.state ?? defaultState;
  const getHistory = deps.getHistory ?? getChannelHistory;
  const getReplies = deps.getReplies ?? getThreadReplies;
  const pipeline = deps.pipeline === undefined ? pipelineFn : deps.pipeline;
  const nowMs = deps.nowMs ?? Date.now;
  const result: SlackChannelPollResult = {
    historyMessages: 0,
    looseBatches: 0,
    threadsImported: 0,
    threadsPending: 0,
    threadFailures: 0,
    cursorAdvanced: false,
  };

  appLog('info', 'slack:poll', `Polling #${channelName} (${channelId})`);
  const cursor = state.getCursor(channelId);
  const { messages } = await getHistory(channelId, cursor);
  result.historyMessages = messages.length;

  const { threadParents, looseMessages } = partitionSlackHistory(messages);

  // Persist every discovered thread before the top-level history cursor moves.
  for (const parent of threadParents) {
    if (state.isProcessed(channelId, parent.ts)) continue;
    state.upsertPending(
      channelId,
      parent.ts,
      parent.latestReply ?? parent.ts,
      nowMs(),
    );
  }

  // A failed loose-message batch keeps the history cursor in place so the
  // complete page set is fetched and retried on the next poll.
  let historySafeToCommit = looseMessages.length === 0;
  if (looseMessages.length > 0 && pipeline) {
    try {
      await pipeline(channelId, channelName, looseMessages);
      result.looseBatches = 1;
      historySafeToCommit = true;
    } catch (error: any) {
      appLog('error', 'slack:poll', `Pipeline failed for loose batch in #${channelName}: ${error.message}`);
    }
  }

  // Recheck persisted threads even when this poll returned no new history.
  // Calls are sequential to cooperate with Slack's per-method rate limits.
  for (const pending of state.getPending(channelId)) {
    if (state.isProcessed(channelId, pending.threadTs)) {
      state.removePending(channelId, pending.threadTs);
      continue;
    }

    try {
      const replies = await getReplies(channelId, pending.threadTs);
      if (replies.length === 0) {
        result.threadsPending++;
        appLog('warn', 'slack:poll', `Thread ${pending.threadTs} returned no messages; keeping pending`);
        continue;
      }

      const latestActivityTs = latestSlackActivityTs(replies, pending.latestActivityTs);
      state.upsertPending(channelId, pending.threadTs, latestActivityTs, pending.discoveredAtMs);

      if (!isSlackThreadQuiet(latestActivityTs, inactivityWindowMin, nowMs())) {
        result.threadsPending++;
        continue;
      }

      if (!pipeline) {
        result.threadsPending++;
        continue;
      }

      await pipeline(channelId, channelName, replies);
      state.markProcessed(channelId, pending.threadTs);
      state.removePending(channelId, pending.threadTs);
      result.threadsImported++;
      appLog('info', 'slack:poll', `Imported quiet thread ${pending.threadTs} from #${channelName}`);
    } catch (error: any) {
      result.threadFailures++;
      result.threadsPending++;
      appLog('error', 'slack:poll', `Thread ${pending.threadTs} remains pending: ${error.message}`);
    }
  }

  if (messages.length > 0 && historySafeToCommit) {
    state.advanceCursor(channelId, messages.map((message) => message.ts));
    result.cursorAdvanced = true;
  } else if (messages.length === 0) {
    appLog('info', 'slack:poll', `No new top-level messages in #${channelName}`);
  }

  return result;
}

async function runPoll(): Promise<void> {
  if (!getSlackConnectionInfo().threadCapable) return;

  const { getConfig } = require('./config') as typeof import('./config');
  const config = getConfig() as any;
  const readChannels: string[] = config.slackReadChannels ?? [];
  const inactivityWindowMin: number = config.slackInactivityWindowMin ?? 60;

  if (readChannels.length === 0) {
    appLog('info', 'slack:poll', 'No read channels configured — skipping poll');
    return;
  }

  for (const channelId of readChannels) {
    try {
      await pollSlackChannel(channelId, channelId, inactivityWindowMin);
    } catch (error: any) {
      appLog('error', 'slack:poll', `Error polling channel ${channelId}: ${error.message}`);
    }
  }
}

export function runSlackPollNow(): Promise<void> {
  if (pollRunInFlight) return pollRunInFlight;
  pollRunInFlight = runPoll().finally(() => { pollRunInFlight = null; });
  return pollRunInFlight;
}

export function startSlackPoller(intervalMs: number = DEFAULT_POLL_INTERVAL_MS): void {
  if (pollTimer) return;

  appLog('info', 'slack:poller', `Starting — interval ${intervalMs / 1000}s`);
  runSlackPollNow().catch((error) => appLog('error', 'slack:poller', `Initial poll error: ${error.message}`));
  pollTimer = setInterval(() => {
    runSlackPollNow().catch((error) => appLog('error', 'slack:poller', `Poll error: ${error.message}`));
  }, intervalMs);
}

export function stopSlackPoller(): void {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
  appLog('info', 'slack:poller', 'Stopped');
}
