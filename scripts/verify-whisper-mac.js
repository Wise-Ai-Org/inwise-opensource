const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { version: expectedVersion } = require('../src/main/whisper-runtime-config.json');

if (process.platform !== 'darwin') {
  throw new Error('The macOS Whisper runtime can only be verified on macOS');
}
if (!['arm64', 'x64'].includes(process.arch)) {
  throw new Error(`Unsupported macOS architecture: ${process.arch}`);
}

const projectDir = path.resolve(__dirname, '..');
const runtimeDir = path.join(projectDir, 'native', 'whisper', `darwin-${process.arch}`);
const binaryPath = path.join(runtimeDir, 'whisper-cli');
const manifestPath = path.join(runtimeDir, 'manifest.json');
const licensePath = path.join(runtimeDir, 'LICENSE.whisper.cpp');

for (const requiredPath of [binaryPath, manifestPath, licensePath]) {
  if (!fs.existsSync(requiredPath)) throw new Error(`Missing macOS Whisper runtime file: ${requiredPath}`);
}
fs.accessSync(binaryPath, fs.constants.X_OK);

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const actualSha256 = crypto.createHash('sha256').update(fs.readFileSync(binaryPath)).digest('hex');
if (manifest.version !== expectedVersion) {
  throw new Error(`Whisper version mismatch: expected ${expectedVersion}, found ${manifest.version}`);
}
if (manifest.platform !== 'darwin' || manifest.arch !== process.arch) {
  throw new Error(`Whisper target mismatch: ${manifest.platform}-${manifest.arch}`);
}
if (manifest.deploymentTarget !== '13.0') {
  throw new Error(`Unexpected Whisper deployment target: ${manifest.deploymentTarget}`);
}
if (manifest.sha256 !== actualSha256) {
  throw new Error(`Whisper checksum mismatch: expected ${manifest.sha256}, found ${actualSha256}`);
}

process.stdout.write(`Verified ${binaryPath}\nsha256 ${actualSha256}\n`);
