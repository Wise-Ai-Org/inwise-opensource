import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { createWhisperRuntimePlan, WHISPER_VERSION } from './whisper-runtime';

const base = {
  isPackaged: false,
  appPath: path.join('work', 'inwise'),
  resourcesPath: path.join('Applications', 'Inwise.app', 'Contents', 'Resources'),
  userDataPath: path.join('Users', 'test', 'Inwise'),
};

{
  const plan = createWhisperRuntimePlan({ ...base, platform: 'win32', arch: 'x64' });
  assert.equal(plan.platform, 'win32');
  assert.ok(plan.downloadUrl?.includes(WHISPER_VERSION));
  assert.ok(plan.binaryCandidates[0].endsWith(path.join('Release', 'whisper-cli.exe')));
  assert.ok(plan.archivePath?.endsWith('whisper-bin.zip'));
}

{
  const plan = createWhisperRuntimePlan({ ...base, platform: 'darwin', arch: 'arm64' });
  assert.equal(plan.downloadUrl, null);
  assert.equal(
    plan.binaryCandidates[0],
    path.join(base.appPath, 'native', 'whisper', 'darwin-arm64', 'whisper-cli'),
  );
}

{
  const plan = createWhisperRuntimePlan({
    ...base,
    platform: 'darwin',
    arch: 'x64',
    isPackaged: true,
  });
  assert.deepEqual(plan.binaryCandidates, [path.join(base.resourcesPath, 'whisper', 'whisper-cli')]);
}

assert.throws(
  () => createWhisperRuntimePlan({ ...base, platform: 'linux', arch: 'x64' }),
  /not available on linux/,
);
assert.throws(
  () => createWhisperRuntimePlan({ ...base, platform: 'darwin', arch: 'ia32' }),
  /not available on ia32/,
);
assert.throws(
  () => createWhisperRuntimePlan({ ...base, platform: 'win32', arch: 'arm64' }),
  /Windows release currently supports x64 only/,
);

console.log('whisper-runtime: all tests passed');
