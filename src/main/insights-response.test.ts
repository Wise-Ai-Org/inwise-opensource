import * as assert from 'node:assert/strict';
import { InsightsResponseError, readClaudeInsights } from './insights-response';

const complete = { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"summary":"Saved summary"}' }] };

async function run() {
  const limits: number[] = [];
  const result = await readClaudeInsights(async limit => {
    limits.push(limit);
    return limits.length === 1
      ? { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"summary":"partial"}' }] }
      : complete;
  }, JSON.parse);
  assert.deepEqual(limits, [4096, 8192]);
  assert.equal(result.summary, 'Saved summary');

  let attempts = 0;
  await assert.rejects(readClaudeInsights(async () => {
    attempts++;
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"summary":' }] };
  }, JSON.parse), (error: any) => error instanceof InsightsResponseError && error.code === 'INSIGHTS_INVALID_JSON');
  assert.equal(attempts, 2);

  await assert.rejects(readClaudeInsights(async () => ({ ...complete, stop_reason: 'max_tokens' }), JSON.parse),
    (error: any) => error.code === 'INSIGHTS_TRUNCATED');
  await assert.rejects(readClaudeInsights(async () => ({ ...complete, content: [{ type: 'text', text: 'null' }] }), JSON.parse),
    (error: any) => error.code === 'INSIGHTS_INVALID_JSON');

  let networkCalls = 0;
  await assert.rejects(readClaudeInsights(async () => {
    networkCalls++;
    throw new Error('HTTP 401');
  }, JSON.parse), /HTTP 401/);
  assert.equal(networkCalls, 1);
  console.log('Insights response tests passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
