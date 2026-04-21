import * as assert from 'node:assert/strict';
import { matchesSelf } from './self-identity';

function run(): void {
  // Email-only match
  assert.equal(matchesSelf('alice@example.com', ['alice@example.com'], ''), true);

  // Display-name fallback match
  assert.equal(matchesSelf('Alice Smith', [], 'Alice Smith'), true);
  assert.equal(matchesSelf('Alice Smith', [], 'Alice'), true);

  // 'Name <email>' combined format
  assert.equal(
    matchesSelf('Alice Smith <alice@example.com>', ['alice@example.com'], ''),
    true,
  );
  assert.equal(
    matchesSelf('Alice Smith <alice@example.com>', [], 'Alice Smith'),
    true,
  );

  // Mixed-case on both sides
  assert.equal(matchesSelf('ALICE@EXAMPLE.COM', ['alice@example.com'], ''), true);
  assert.equal(matchesSelf('alice@example.com', ['ALICE@EXAMPLE.COM'], ''), true);
  assert.equal(matchesSelf('ALICE SMITH', [], 'alice smith'), true);

  // Multiple selfEmails, only one matches
  assert.equal(
    matchesSelf('bob@work.com', ['alice@example.com', 'bob@work.com'], ''),
    true,
  );

  // No match
  assert.equal(
    matchesSelf('charlie@example.com', ['alice@example.com'], 'Alice'),
    false,
  );

  // Empty config returns false (fresh-install behavior)
  assert.equal(matchesSelf('alice@example.com', [], ''), false);
  assert.equal(matchesSelf('Alice Smith', [], ''), false);

  // Empty / whitespace-only entries in selfEmails are ignored, not wildcarded
  assert.equal(matchesSelf('alice@example.com', ['', '   '], ''), false);

  // Whitespace-only userName is ignored (does not match everything)
  assert.equal(matchesSelf('alice@example.com', [], '   '), false);

  // Empty attendee
  assert.equal(matchesSelf('', ['alice@example.com'], 'Alice'), false);

  console.log('self-identity: all tests passed');
}

if (require.main === module) {
  run();
}

export { run };
