import * as assert from 'node:assert/strict';
import { addCorrection, applyNameCorrections, mapStrings, replaceName } from './name-corrections';

// Whole words only, any case, keeps punctuation.
assert.equal(replaceName('Satya will fix it. satya, thanks!', 'Satya', 'Sacha'), 'Sacha will fix it. Sacha, thanks!');
assert.equal(replaceName('Satyam owns this', 'Satya', 'Sacha'), 'Satyam owns this');
assert.equal(replaceName("Satya's flow", 'Satya', 'Sacha'), "Sacha's flow");
assert.equal(replaceName('No change', '', 'Sacha'), 'No change');

// Multi-word names and regex characters are safe.
assert.equal(replaceName('Ask J.R. Smith', 'J.R. Smith', 'Jay Smith'), 'Ask Jay Smith');

// Remembered corrections apply in order.
assert.equal(applyNameCorrections('Satya and Bavin', { Satya: 'Sacha', Bavin: 'Bhavin' }), 'Sacha and Bhavin');
assert.equal(applyNameCorrections('Satya', null), 'Satya');

// Nested insights: strings change, ids and dates do not.
const insights = {
  summary: 'Satya demoed onboarding.',
  actionItems: [{ text: 'Fix flow', owner: 'Satya', taskId: 'Satya-1', dueDate: '2026-11-05' }],
  decisions: [{ text: 'Ship with Satya’s design' }],
};
const corrected = mapStrings(insights, (t) => replaceName(t, 'Satya', 'Sacha'));
assert.equal(corrected.summary, 'Sacha demoed onboarding.');
assert.equal(corrected.actionItems[0].owner, 'Sacha');
assert.equal(corrected.actionItems[0].taskId, 'Satya-1');
assert.equal(corrected.decisions[0].text, 'Ship with Sacha’s design');
assert.equal(insights.actionItems[0].owner, 'Satya', 'input is not mutated');

// Chains collapse and reversals drop the stale entry.
assert.deepEqual(addCorrection({ Satya: 'Sasha' }, 'Sasha', 'Sacha'), { Satya: 'Sacha', Sasha: 'Sacha' });
assert.deepEqual(addCorrection({ Satya: 'Sacha' }, 'Sacha', 'Satya'), { Sacha: 'Satya' });
assert.deepEqual(addCorrection({}, 'Sacha', 'sacha'), {});

console.log('name-corrections tests passed');
