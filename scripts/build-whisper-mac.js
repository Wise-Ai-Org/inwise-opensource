const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { version: WHISPER_VERSION } = require('../src/main/whisper-runtime-config.json');
const SUPPORTED_ARCHES = new Set(['arm64', 'x64']);

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

if (process.platform !== 'darwin') {
  throw new Error('The macOS whisper.cpp binary must be built on macOS');
}
if (!SUPPORTED_ARCHES.has(process.arch)) {
  throw new Error(`Unsupported macOS architecture: ${process.arch}`);
}

const projectDir = path.resolve(__dirname, '..');
const buildRoot = path.join(projectDir, 'native', '.build');
const sourceDir = path.join(buildRoot, `whisper.cpp-${WHISPER_VERSION}`);
const buildDir = path.join(buildRoot, `build-${WHISPER_VERSION}-${process.arch}`);
const outputDir = path.join(projectDir, 'native', 'whisper', `darwin-${process.arch}`);
const outputBinary = path.join(outputDir, 'whisper-cli');

fs.mkdirSync(buildRoot, { recursive: true });
if (!fs.existsSync(path.join(sourceDir, '.git'))) {
  run('git', [
    'clone', '--depth', '1', '--branch', WHISPER_VERSION,
    'https://github.com/ggml-org/whisper.cpp.git', sourceDir,
  ], projectDir);
}

run('cmake', [
  '-S', sourceDir,
  '-B', buildDir,
  '-DCMAKE_BUILD_TYPE=Release',
  '-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0',
  '-DBUILD_SHARED_LIBS=OFF',
  '-DGGML_NATIVE=OFF',
  '-DGGML_METAL=ON',
  '-DGGML_METAL_EMBED_LIBRARY=ON',
  '-DWHISPER_BUILD_TESTS=OFF',
  '-DWHISPER_BUILD_SERVER=OFF',
  '-DWHISPER_BUILD_EXAMPLES=ON',
], projectDir);
run('cmake', ['--build', buildDir, '--config', 'Release', '--target', 'whisper-cli', '--parallel'], projectDir);

const builtBinary = path.join(buildDir, 'bin', 'whisper-cli');
if (!fs.existsSync(builtBinary)) {
  throw new Error(`whisper-cli was not produced at ${builtBinary}`);
}

fs.mkdirSync(outputDir, { recursive: true });
fs.copyFileSync(builtBinary, outputBinary);
fs.chmodSync(outputBinary, 0o755);
fs.copyFileSync(path.join(sourceDir, 'LICENSE'), path.join(outputDir, 'LICENSE.whisper.cpp'));

const sha256 = crypto.createHash('sha256').update(fs.readFileSync(outputBinary)).digest('hex');
fs.writeFileSync(path.join(outputDir, 'manifest.json'), `${JSON.stringify({
  version: WHISPER_VERSION,
  platform: 'darwin',
  arch: process.arch,
  deploymentTarget: '13.0',
  sha256,
}, null, 2)}\n`);

process.stdout.write(`Built ${outputBinary}\nsha256 ${sha256}\n`);
