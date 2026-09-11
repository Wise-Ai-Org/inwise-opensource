import assert from 'node:assert/strict';
import {
  buildRecordingSilencePrompt,
  recordingSilenceSecondsRemaining,
  RECORDING_SILENCE_RESPONSE_MS,
} from './recording-silence-policy';

assert.equal(RECORDING_SILENCE_RESPONSE_MS, 30_000, 'the user gets exactly 30 seconds to respond');

const prompt = buildRecordingSilencePrompt('  Weekly planning  ', 1_000);
assert.deepEqual(prompt, {
  title: 'Weekly planning',
  deadlineAt: 31_000,
  responseMs: 30_000,
});

assert.equal(buildRecordingSilencePrompt('', 0).title, 'This recording');
assert.equal(buildRecordingSilencePrompt('x'.repeat(140), 0).title.length, 120);
assert.equal(recordingSilenceSecondsRemaining(30_000, 0), 30);
assert.equal(recordingSilenceSecondsRemaining(30_000, 29_001), 1);
assert.equal(recordingSilenceSecondsRemaining(30_000, 30_001), 0);

console.log('recording silence policy tests passed');
