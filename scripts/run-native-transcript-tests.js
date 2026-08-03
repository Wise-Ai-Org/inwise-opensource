const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const testFiles = [
  'src/main/oauth-loopback.test.ts',
  'src/main/oauth-credentials.test.ts',
  'src/main/teams-oauth-config.test.ts',
  'src/main/teams-vtt-parser.test.ts',
  'src/main/teams-api.test.ts',
  'src/main/meet-oauth-config.test.ts',
  'src/main/meet-api.test.ts',
  'src/main/zoom-vtt-parser.test.ts',
  'src/main/zoom-transcript-ingestion.test.ts',
];

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inwise-native-transcript-tests-'));
const tsNodeBin = require.resolve('ts-node/dist/bin.js');
let failedStatus = 0;

try {
  for (const testFile of testFiles) {
    const result = spawnSync(
      process.execPath,
      [tsNodeBin, '-P', 'tsconfig.main.json', testFile],
      {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, INWISE_TEST_CONFIG_DIR: configDir },
        stdio: 'inherit',
      },
    );
    if (result.status !== 0) {
      failedStatus = result.status || 1;
      break;
    }
  }
} finally {
  fs.rmSync(configDir, { recursive: true, force: true });
}

process.exitCode = failedStatus;
