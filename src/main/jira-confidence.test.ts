import * as assert from 'node:assert/strict';
import { computeWriteConfidence, normalizeCertainty, spokenIssueKeys, DEFAULT_EXTRACTION_CERTAINTY } from './jira-confidence';
import { decideJiraWrite, resolveJiraWriteMode, taskReviewOf, JIRA_AUTO_THRESHOLD } from './jira-gate';
import { normalizeActionItems, normalizeTicketIntents } from './extractor';

function run(): void {
  // ── normalizeCertainty ────────────────────────────────────────────────
  assert.equal(normalizeCertainty(undefined), DEFAULT_EXTRACTION_CERTAINTY);
  assert.equal(normalizeCertainty(null), 0.5);
  assert.equal(normalizeCertainty('abc'), 0.5);
  assert.equal(normalizeCertainty(0.8), 0.8);
  assert.equal(normalizeCertainty('0.7'), 0.7);
  assert.equal(normalizeCertainty(85), 0.85, 'percent answers are scaled');
  assert.equal(normalizeCertainty(-1), 0);
  assert.equal(normalizeCertainty(500), 1);

  // ── computeWriteConfidence: create ────────────────────────────────────
  {
    const full = computeWriteConfidence({ operation: 'create', extractionCertainty: 1, ownerIdentified: true, dueDateExplicit: true, matchStrength: 0 });
    assert.equal(full.confidence, 1);
    const bare = computeWriteConfidence({ operation: 'create' });
    // 0.5*0.5 + 0 + 0 + 0.25*1
    assert.equal(bare.confidence, 0.5);
    const likelyDup = computeWriteConfidence({ operation: 'create', extractionCertainty: 1, ownerIdentified: true, dueDateExplicit: true, matchStrength: 0.7 });
    assert.ok(likelyDup.confidence < JIRA_AUTO_THRESHOLD, 'a likely existing ticket keeps a create below auto');
    const noDue = computeWriteConfidence({ operation: 'create', extractionCertainty: 0.9, ownerIdentified: true, matchStrength: 0 });
    assert.equal(noDue.confidence, 0.85, 'without an explicit due date a create stays under 0.9');
  }

  // ── computeWriteConfidence: change to an existing ticket ──────────────
  {
    const spoken = computeWriteConfidence({ operation: 'transition', extractionCertainty: 1, keySpoken: true, ownerIdentified: true, dueDateExplicit: true });
    assert.equal(spoken.confidence, 1);
    assert.equal(spoken.parts.target, 1);
    const matched = computeWriteConfidence({ operation: 'comment', extractionCertainty: 1, matchStrength: 0.6, ownerIdentified: true, dueDateExplicit: true });
    // 0.45 + 0.35*0.6 + 0.1 + 0.1 = 0.86
    assert.equal(matched.confidence, 0.86);
    const unsure = computeWriteConfidence({ operation: 'update', extractionCertainty: 0.2, matchStrength: 0.5 });
    assert.ok(unsure.confidence < 0.5);
    // Deterministic: same input, same output.
    assert.deepEqual(
      computeWriteConfidence({ operation: 'comment', extractionCertainty: 0.7, matchStrength: 0.4 }),
      computeWriteConfidence({ operation: 'comment', extractionCertainty: 0.7, matchStrength: 0.4 }),
    );
    // Missing LLM value never means ungated: it is a number.
    assert.equal(typeof computeWriteConfidence({ operation: 'comment' }).confidence, 'number');
  }

  // ── spokenIssueKeys ───────────────────────────────────────────────────
  assert.deepEqual(spokenIssueKeys('PILOT-42 is done, and so is OPS-3. pilot-9 no'), ['PILOT-42', 'OPS-3']);
  assert.deepEqual(spokenIssueKeys(''), []);

  // ── decideJiraWrite ───────────────────────────────────────────────────
  const base = { mode: 'ask' as const, confidence: 0.99, initiator: 'system' as const, taskReview: 'none' as const };
  assert.equal(decideJiraWrite({ ...base, initiator: 'user' }).action, 'push', 'a click is approval');
  assert.equal(decideJiraWrite(base).action, 'hold', 'ask mode holds even very sure writes');
  assert.equal(decideJiraWrite({ ...base, mode: 'auto' }).action, 'push');
  assert.equal(decideJiraWrite({ ...base, mode: 'auto', confidence: 0.89 }).action, 'hold');
  assert.equal(decideJiraWrite({ ...base, mode: 'auto', confidence: 0.9 }).action, 'push', 'threshold is inclusive');
  assert.equal(decideJiraWrite({ ...base, mode: 'auto', confidence: Number.NaN }).action, 'hold', 'NaN never pushes');
  assert.equal(decideJiraWrite({ ...base, mode: 'auto', confidence: 0.4, taskReview: 'approved' }).action, 'push', 'auto + kept task');
  assert.equal(decideJiraWrite({ ...base, mode: 'ask', confidence: 0.4, taskReview: 'approved' }).action, 'hold', 'ask mode: keeping the task is not a Jira OK');
  assert.equal(decideJiraWrite({ ...base, mode: 'auto', taskReview: 'rejected' }).action, 'drop');
  assert.equal(decideJiraWrite({ ...base, mode: 'auto', dedupPending: true }).action, 'wait');
  assert.equal(decideJiraWrite({ ...base, mode: 'auto', forceReview: true }).action, 'hold', 'suggestions always need a person');

  assert.equal(taskReviewOf(null), 'none');
  assert.equal(taskReviewOf({ approval: { status: 'pending' } }), 'pending');
  assert.equal(taskReviewOf({ approval: { status: 'rejected' } }), 'rejected');
  assert.equal(taskReviewOf({ approval: { status: 'auto_approved' } }), 'approved');
  assert.equal(taskReviewOf({}), 'approved');

  // ── settings migration ────────────────────────────────────────────────
  assert.equal(resolveJiraWriteMode(undefined), 'ask', 'fresh install');
  assert.equal(resolveJiraWriteMode({ approvalGateEnabled: false, approvalThreshold: 0.6 }), 'ask', 'shipped defaults -> ask');
  assert.equal(resolveJiraWriteMode({ approvalGateEnabled: true, approvalThreshold: 0.6 }), 'auto', 'explicitly turned the gate on');
  assert.equal(resolveJiraWriteMode({ approvalGateEnabled: false, approvalThreshold: 0.75 }), 'auto', 'explicitly moved the threshold');
  assert.equal(resolveJiraWriteMode({ writeMode: 'ask', approvalGateEnabled: true }), 'ask', 'the new setting wins');
  assert.equal(resolveJiraWriteMode({ writeMode: 'auto' }), 'auto');

  // ── extractor normalization ───────────────────────────────────────────
  {
    const items = normalizeActionItems([
      { text: ' Send survey ', certainty: 0.9, dueDate: '2099-01-05', dueDateExplicit: true, issueKey: 'PILOT-42', evidence: 'I will send it' },
      { text: 'Old shape', confidence: 0.7 },
      { text: 'No certainty' },
      { text: '' },
      null,
      { text: 'Bad key', issueKey: 'not a key', dueDateExplicit: true },
    ], '2099-01-01');
    assert.equal(items.length, 4);
    assert.equal(items[0].text, 'Send survey');
    assert.equal(items[0].certainty, 0.9);
    assert.equal(items[0].dueDateExplicit, true);
    assert.equal(items[0].issueKey, 'PILOT-42');
    assert.equal(items[1].certainty, 0.7, 'falls back to the older confidence field');
    assert.equal(items[2].certainty, 0.5, 'safe default when missing');
    assert.equal(items[3].issueKey, null);
    assert.equal(items[3].dueDateExplicit, false, 'explicit only with a surviving date');
    assert.deepEqual(normalizeActionItems(undefined), []);
  }
  {
    const intents = normalizeTicketIntents([
      { kind: 'done', issueKey: 'PILOT-42', ticketHint: 'survey', text: 'The survey is done', evidence: 'survey is done', certainty: 0.95 },
      { kind: 'due_moved', ticketHint: 'login fix', text: 'Slipped to Tuesday', dueDate: '2099-01-06', certainty: 0.8 },
      { kind: 'due_moved', ticketHint: 'no date', text: 'slipped' },
      { kind: 'nonsense', text: 'x' },
      { kind: 'decision', text: '', ticketHint: '' },
    ], '2099-01-01');
    assert.equal(intents.length, 2);
    assert.equal(intents[0].kind, 'done');
    assert.equal(intents[1].dueDate, '2099-01-06');
    assert.equal(intents[1].issueKey, null);
  }

  console.log('jira-confidence: all tests passed');
}

run();
