const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectDir = path.resolve(__dirname, '..');
const compiledDir = path.join(projectDir, 'dist', 'main');
const testRoot = path.join(projectDir, 'tmp', 'test-electron-store', String(process.pid));
const safeRoot = path.join(projectDir, 'tmp', 'test-electron-store') + path.sep;

if (!testRoot.startsWith(safeRoot)) {
  throw new Error(`Refusing unsafe test directory: ${testRoot}`);
}

const tests = fs.readdirSync(compiledDir)
  .filter((name) => name.endsWith('.test.js'))
  .sort();

if (tests.length === 0) {
  throw new Error(`No compiled tests found in ${compiledDir}`);
}

const failures = [];
for (const test of tests) {
  process.stdout.write(`\n--- ${test}\n`);
  const result = spawnSync(process.execPath, [path.join(compiledDir, test)], {
    cwd: projectDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      INWISE_STORE_DIR: path.join(testRoot, test.replace(/\.js$/, '')),
    },
  });
  if (result.status !== 0) failures.push(test);
}

fs.rmSync(testRoot, { recursive: true, force: true });

if (failures.length > 0) {
  process.stderr.write(`\nFailed tests: ${failures.join(', ')}\n`);
  process.exit(1);
}

process.stdout.write(`\nAll ${tests.length} test files passed.\n`);
