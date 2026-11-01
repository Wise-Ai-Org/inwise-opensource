const { spawnSync } = require('child_process');
const path = require('path');
const electron = require('electron');
for (const args of [
  ['scripts/voice-audio-repro.cjs'],
  ['scripts/test-recording-recovery.cjs'],
  ['scripts/test-recording-recovery.cjs', '--restart-state=' + path.resolve('artifacts/restart-test-state.json')],
  ['scripts/test-voice-ui.cjs'],
]) {
  const result = spawnSync(electron, args, { stdio: 'inherit', timeout: 90000 });
  if (result.error) console.error(result.error);
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
console.log('All recording recovery integration checks passed.');
