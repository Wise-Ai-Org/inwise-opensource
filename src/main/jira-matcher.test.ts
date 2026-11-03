import * as assert from 'node:assert/strict';
import { matchItemToStories, matchAllItems, semanticMatch } from './jira-matcher';

const stories = [
  { jiraKey: 'PILOT-42', title: 'Send onboarding survey to pilot customers', description: 'Survey covers setup time and support', jiraUrl: 'u/PILOT-42' },
  { jiraKey: 'PILOT-7', title: 'Fix login timeout on mobile', description: 'Session expires too early', jiraUrl: 'u/PILOT-7' },
  { jiraKey: 'OPS-3', title: 'Renew vendor contract', description: 'Legal review of the MSA', jiraUrl: 'u/OPS-3' },
];

async function run(): Promise<void> {
  // Spoken key dominates: weight 0.5 plus keyword overlap.
  {
    const c = matchItemToStories('Close out PILOT-42 this week', stories);
    assert.equal(c[0].jiraKey, 'PILOT-42');
    assert.equal(c[0].matchFactors.keyMention, 1);
    assert.ok(c[0].similarity >= 0.5, `key mention scores at least 0.5, got ${c[0].similarity}`);
  }

  // Keyword-only match without a key stays well below the 0.85 auto-link line.
  {
    const c = matchItemToStories('Send the onboarding survey to pilot customers', stories);
    assert.equal(c[0].jiraKey, 'PILOT-42');
    assert.equal(c[0].matchFactors.keyMention, 0);
    assert.ok(c[0].similarity < 0.85, 'no key spoken -> never an auto link on keywords alone');
    assert.ok(c[0].similarity >= 0.3, `strong keyword overlap lands in the middle band, got ${c[0].similarity}`);
  }

  // Unrelated text: no candidates above the 0.05 floor, or only weak ones.
  {
    const c = matchItemToStories('Book flights for the offsite', stories);
    assert.ok(c.length === 0 || c[0].similarity < 0.3);
  }

  // Sorted descending, capped at 5, rounded to 2 decimals.
  {
    const many = Array.from({ length: 8 }, (_, i) => ({ jiraKey: `A-${i}`, title: `survey item ${i}`, description: '', jiraUrl: '' }));
    const c = matchItemToStories('survey item', many);
    assert.ok(c.length <= 5);
    for (let i = 1; i < c.length; i++) assert.ok(c[i - 1].similarity >= c[i].similarity);
    for (const x of c) assert.equal(Math.round(x.similarity * 100) / 100, x.similarity);
  }

  // matchAllItems: autoApproved only at >= 0.85.
  {
    const results = matchAllItems(
      [{ text: 'PILOT-42 send onboarding survey to pilot customers' }, { text: 'Fix login timeout' }],
      stories,
    );
    assert.equal(results.length, 2);
    assert.equal(results[0].bestMatch?.jiraKey, 'PILOT-42');
    assert.equal(results[0].autoApproved, results[0].bestMatch!.similarity >= 0.85);
    assert.equal(results[1].autoApproved, false);
  }

  // semanticMatch without an API key returns {} (no network).
  {
    const res = await semanticMatch([{ text: 'x' }], [{ jiraKey: 'A-1', title: 'x' }]);
    assert.deepEqual(res, {});
    assert.deepEqual(await semanticMatch([], []), {});
  }

  console.log('jira-matcher: all tests passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
