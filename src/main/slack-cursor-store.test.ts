import * as assert from 'node:assert/strict';
import {
  __setSlackCursorStoreForTests,
  advanceCursorToNewest,
  getChannelCursor,
  getPendingThreads,
  markThreadIngested,
  isThreadProcessed,
  removePendingThread,
  upsertPendingThread,
} from './slack-cursor-store';

class MemoryStore {
  data: Record<string, any> = {};
  get(key: string): any { return this.data[key]; }
  set(key: string, value: any): void { this.data[key] = value; }
}

function run(): void {
  const store = new MemoryStore();
  __setSlackCursorStoreForTests(store as any);

  advanceCursorToNewest('C1', ['2.0', '7.0', '5.0']);
  assert.equal(getChannelCursor('C1'), '7.0');

  upsertPendingThread('C1', '10.0', '11.0', 123);
  upsertPendingThread('C1', '10.0', '12.0', 999);
  assert.deepEqual(getPendingThreads('C1'), [{
    threadTs: '10.0', latestActivityTs: '12.0', discoveredAtMs: 123,
  }]);

  markThreadIngested('C1', '10.0');
  assert.equal(isThreadProcessed('C1', '10.0'), true);
  removePendingThread('C1', '10.0');
  assert.deepEqual(getPendingThreads('C1'), []);

  console.log('slack-cursor-store: all tests passed');
}

if (require.main === module) run();

export { run };
