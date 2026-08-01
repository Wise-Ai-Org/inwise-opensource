import * as assert from 'node:assert/strict';
import { pollSlackChannel, SlackPollState } from './slack-poller';
import type { SlackMessage } from './slack-client';
import type { SlackPendingThread } from './slack-cursor-store';

function memoryState(): SlackPollState & { cursors: Map<string, string>; pending: Map<string, SlackPendingThread>; processed: Set<string> } {
  const cursors = new Map<string, string>();
  const pending = new Map<string, SlackPendingThread>();
  const processed = new Set<string>();
  const key = (channelId: string, threadTs: string) => `${channelId}:${threadTs}`;
  return {
    cursors,
    pending,
    processed,
    getCursor: (channelId) => cursors.get(channelId),
    advanceCursor: (channelId, timestamps) => {
      const newest = timestamps.reduce((a, b) => parseFloat(a) > parseFloat(b) ? a : b);
      cursors.set(channelId, newest);
    },
    getPending: (channelId) => [...pending.entries()]
      .filter(([entryKey]) => entryKey.startsWith(`${channelId}:`))
      .map(([, value]) => value),
    upsertPending: (channelId, threadTs, latestActivityTs, discoveredAtMs = Date.now()) => {
      const entryKey = key(channelId, threadTs);
      const existing = pending.get(entryKey);
      const value = {
        threadTs,
        latestActivityTs,
        discoveredAtMs: existing?.discoveredAtMs ?? discoveredAtMs,
      };
      pending.set(entryKey, value);
      return value;
    },
    removePending: (channelId, threadTs) => { pending.delete(key(channelId, threadTs)); },
    isProcessed: (channelId, threadTs) => processed.has(key(channelId, threadTs)),
    markProcessed: (channelId, threadTs) => { processed.add(key(channelId, threadTs)); },
  };
}

async function run(): Promise<void> {
  const state = memoryState();
  const base = 1_000_000;
  let now = (base + 40) * 1000;
  let historyCall = 0;
  const imported: SlackMessage[][] = [];
  const parent: SlackMessage = {
    ts: `${base}.0`,
    user: 'U1',
    text: 'Parent',
    replyCount: 1,
    latestReply: `${base + 30}.0`,
  };
  const replies: SlackMessage[] = [
    parent,
    { ts: `${base + 30}.0`, user: 'U2', text: 'Reply', threadTs: parent.ts },
  ];

  const common = {
    state,
    nowMs: () => now,
    getHistory: async () => ({ messages: historyCall++ === 0 ? [parent] : [] }),
    getReplies: async () => replies,
    pipeline: async (_channelId: string, _channelName: string, messages: SlackMessage[]) => {
      imported.push(messages);
    },
  };

  const first = await pollSlackChannel('C1', 'launch', 1, common);
  assert.equal(first.cursorAdvanced, true);
  assert.equal(first.threadsImported, 0);
  assert.equal(first.threadsPending, 1);
  assert.equal(state.pending.size, 1, 'active thread is durably pending');
  assert.equal(imported.length, 0);

  now = (base + 100) * 1000;
  const second = await pollSlackChannel('C1', 'launch', 1, common);
  assert.equal(second.historyMessages, 0, 'second poll has no new top-level history');
  assert.equal(second.threadsImported, 1, 'persisted thread matures on an empty history poll');
  assert.equal(state.pending.size, 0);
  assert.equal(state.processed.has(`C1:${parent.ts}`), true);
  assert.deepEqual(imported[0].map((message) => message.ts), [parent.ts, `${base + 30}.0`]);

  {
    const looseState = memoryState();
    const loose: SlackMessage = { ts: '200.0', user: 'U1', text: 'Loose message' };
    const failed = await pollSlackChannel('C2', 'general', 1, {
      state: looseState,
      getHistory: async () => ({ messages: [loose] }),
      getReplies: async () => [],
      pipeline: async () => { throw new Error('extractor offline'); },
    });
    assert.equal(failed.cursorAdvanced, false, 'failed loose batch does not commit its timestamp cursor');
    assert.equal(looseState.cursors.has('C2'), false);
  }

  console.log('slack-poller: all tests passed');
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { run };
