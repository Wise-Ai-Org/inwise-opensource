const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout || ''}${result.stderr || ''}`);
  }
  return result.stdout.trim();
}

function findPackagedApp(projectDir) {
  const outputDir = path.join(projectDir, 'release-v2');
  for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('mac')) continue;
    const candidate = path.join(outputDir, entry.name, 'Inwise.app');
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`No packaged Inwise.app found below ${outputDir}`);
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  if (process.platform !== 'darwin') throw new Error('The macOS package verifier must run on macOS');

  const projectDir = path.resolve(__dirname, '..');
  const expectedArch = process.env.INWISE_EXPECTED_ARCH || process.arch;
  const expectedMachArch = expectedArch === 'x64' ? 'x86_64' : expectedArch;
  const appPath = findPackagedApp(projectDir);
  const contentsPath = path.join(appPath, 'Contents');
  const binaryPath = path.join(contentsPath, 'Resources', 'whisper', 'whisper-cli');
  const manifestPath = path.join(contentsPath, 'Resources', 'whisper', 'manifest.json');
  const infoPath = path.join(contentsPath, 'Info.plist');
  const executablePath = path.join(contentsPath, 'MacOS', 'Inwise');

  for (const requiredPath of [binaryPath, manifestPath, infoPath, executablePath]) {
    if (!fs.existsSync(requiredPath)) throw new Error(`Missing packaged Mac file: ${requiredPath}`);
  }
  fs.accessSync(binaryPath, fs.constants.X_OK);
  fs.accessSync(executablePath, fs.constants.X_OK);

  const actualMachArch = run('lipo', ['-archs', binaryPath]);
  if (actualMachArch !== expectedMachArch) {
    throw new Error(`Whisper architecture mismatch: expected ${expectedMachArch}, found ${actualMachArch}`);
  }
  run(binaryPath, ['--help']);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.platform !== 'darwin' || manifest.arch !== expectedArch) {
    throw new Error(`Whisper manifest mismatch: ${manifest.platform}-${manifest.arch}`);
  }

  const linkedLibraries = run('otool', ['-L', binaryPath])
    .split(/\r?\n/)
    .slice(1)
    .map(line => line.trim().split(/\s+/)[0])
    .filter(Boolean);
  const unexpectedLibraries = linkedLibraries.filter(
    library => !library.startsWith('/System/Library/') && !library.startsWith('/usr/lib/'),
  );
  if (unexpectedLibraries.length > 0) {
    throw new Error(`Non-system Whisper libraries: ${unexpectedLibraries.join(', ')}`);
  }

  const plistBuddy = '/usr/libexec/PlistBuddy';
  if (run(plistBuddy, ['-c', 'Print :LSMinimumSystemVersion', infoPath]) !== '13.0.0') {
    throw new Error('Packaged app has the wrong minimum macOS version');
  }
  for (const key of [
    'NSMicrophoneUsageDescription',
    'NSAudioCaptureUsageDescription',
    'NSScreenCaptureUsageDescription',
  ]) {
    if (!run(plistBuddy, ['-c', `Print :${key}`, infoPath])) {
      throw new Error(`Packaged app is missing ${key}`);
    }
  }

  const smokeDir = fs.mkdtempSync(path.join(os.tmpdir(), `inwise-package-${expectedArch}-`));
  const storeDir = path.join(smokeDir, 'store');
  const profileDir = path.join(smokeDir, 'profile');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });

  let output = '';
  const child = spawn(executablePath, [`--user-data-dir=${profileDir}`, '--hidden'], {
    env: { ...process.env, INWISE_STORE_DIR: storeDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  const ended = new Promise(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', error => resolve({ error }));
  });

  try {
    const earlyResult = await Promise.race([
      ended.then(result => ({ ended: true, result })),
      delay(10_000).then(() => ({ ended: false })),
    ]);
    if (earlyResult.ended) {
      throw new Error(`Packaged app exited during smoke test: ${JSON.stringify(earlyResult.result)}\n${output}`);
    }
    process.stdout.write(`PACKAGED_APP_HEALTHY arch=${expectedArch} pid=${child.pid}\n`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.race([ended, delay(3_000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    fs.rmSync(smokeDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
