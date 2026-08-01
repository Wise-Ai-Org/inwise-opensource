import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WHISPER_VERSION, WINDOWS_WHISPER_URL } from './whisper-runtime';

const projectDir = path.resolve(__dirname, '..', '..');
const read = (relativePath: string) => fs.readFileSync(path.join(projectDir, relativePath), 'utf8');
const packageJson = JSON.parse(read('package.json'));
const mac = packageJson.build?.mac;

assert.ok(mac, 'package.json must define a mac build');
assert.deepEqual(mac.target, ['dmg', 'zip']);
assert.equal(mac.minimumSystemVersion, '13.0.0');
assert.equal(mac.hardenedRuntime, true);
assert.equal(mac.notarize, true);
assert.equal(mac.entitlements, 'build/entitlements.mac.plist');
assert.equal(mac.entitlementsInherit, 'build/entitlements.mac.inherit.plist');
assert.ok(mac.binaries.includes('Contents/Resources/whisper/whisper-cli'));
assert.equal(mac.artifactName, 'Inwise-${version}-mac-${arch}.${ext}');
assert.ok(packageJson.build.files.includes('assets/**/*'), 'runtime window/tray assets must be packaged');
for (const excluded of [
  '!dist/main/**/*.test.js',
  '!dist/main/**/*.test.js.map',
  '!dist/**/*.map',
  '!node_modules/**/*.map',
]) {
  assert.ok(packageJson.build.files.includes(excluded), `release package must exclude ${excluded}`);
}

const whisperResource = mac.extraResources.find((entry: any) => entry.to === 'whisper');
assert.ok(whisperResource, 'mac package must include the native Whisper runtime');
assert.equal(whisperResource.from, 'native/whisper/darwin-${arch}');
for (const requiredFile of ['whisper-cli', 'manifest.json', 'LICENSE.whisper.cpp']) {
  assert.ok(whisperResource.filter.includes(requiredFile), `missing Whisper resource: ${requiredFile}`);
}

const info = mac.extendInfo;
for (const key of ['NSMicrophoneUsageDescription', 'NSAudioCaptureUsageDescription', 'NSScreenCaptureUsageDescription']) {
  assert.ok(typeof info[key] === 'string' && info[key].length > 20, `missing macOS usage description: ${key}`);
}

const mainEntitlements = read('build/entitlements.mac.plist');
const inheritedEntitlements = read('build/entitlements.mac.inherit.plist');
for (const entitlement of ['com.apple.security.device.audio-input', 'com.apple.security.cs.allow-jit']) {
  assert.ok(mainEntitlements.includes(entitlement), `main app missing entitlement: ${entitlement}`);
  assert.ok(inheritedEntitlements.includes(entitlement), `Electron helpers missing entitlement: ${entitlement}`);
}
for (const forbidden of [
  'com.apple.security.device.screen-capture',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.disable-library-validation',
  'com.apple.security.cs.allow-dyld-environment-variables',
]) {
  assert.ok(!mainEntitlements.includes(forbidden), `unnecessary high-risk entitlement present: ${forbidden}`);
  assert.ok(!inheritedEntitlements.includes(forbidden), `unnecessary inherited entitlement present: ${forbidden}`);
}

assert.match(WHISPER_VERSION, /^v\d+\.\d+\.\d+$/);
assert.ok(WINDOWS_WHISPER_URL.includes(`/${WHISPER_VERSION}/`));
const whisperBuild = read('scripts/build-whisper-mac.js');
assert.ok(whisperBuild.includes("require('../src/main/whisper-runtime-config.json')"));
for (const flag of [
  '-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0',
  '-DBUILD_SHARED_LIBS=OFF',
  '-DGGML_NATIVE=OFF',
  '-DGGML_METAL=ON',
  '-DGGML_METAL_EMBED_LIBRARY=ON',
]) {
  assert.ok(whisperBuild.includes(flag), `Mac Whisper build missing flag: ${flag}`);
}
const whisperVerify = read('scripts/verify-whisper-mac.js');
assert.ok(whisperVerify.includes("require('../src/main/whisper-runtime-config.json')"));
assert.ok(whisperVerify.includes('manifest.sha256 !== actualSha256'));
assert.equal(packageJson.scripts['verify:whisper:mac'], 'node scripts/verify-whisper-mac.js');
assert.ok(packageJson.scripts['dist:mac'].includes('npm run verify:whisper:mac'));
const whisperSmoke = read('scripts/smoke-whisper-mac.js');
assert.ok(whisperSmoke.includes('ggml-tiny.en.bin'));
assert.ok(whisperSmoke.includes('ask\\s+not\\s+what\\s+your\\s+country'));
assert.equal(packageJson.scripts['smoke:whisper:mac'], 'node scripts/smoke-whisper-mac.js');
const packageVerify = read('scripts/verify-packaged-mac.js');
for (const required of [
  "run('lipo'",
  "run('otool'",
  'Print :LSMinimumSystemVersion',
  'NSAudioCaptureUsageDescription',
  'PACKAGED_APP_HEALTHY',
]) {
  assert.ok(packageVerify.includes(required), `Mac package verifier missing: ${required}`);
}
assert.equal(packageJson.scripts['verify:package:mac'], 'node scripts/verify-packaged-mac.js');
assert.ok(packageJson.scripts['dist:mac'].includes('npm run verify:package:mac'));

const releaseWorkflow = read('.github/workflows/release-mac.yml');
for (const required of [
  'runner: macos-15\n            arch: arm64',
  'runner: macos-15-intel\n            arch: x64',
  'secrets.MAC_CSC_LINK',
  'secrets.APPLE_API_KEY',
  'secrets.APPLE_API_KEY_ID',
  'secrets.APPLE_API_ISSUER',
  'secrets.APPLE_TEAM_ID',
  '-c.forceCodeSigning=true',
  'codesign --verify --deep --strict',
  'spctl --assess --type execute',
  'xcrun stapler validate',
  'npm run verify:whisper:mac',
  'npm run smoke:whisper:mac',
  'npm run verify:package:mac',
  'release-v2/Inwise-*-mac-${{ matrix.arch }}.dmg',
  'release-v2/Inwise-*-mac-${{ matrix.arch }}.zip',
]) {
  assert.ok(releaseWorkflow.includes(required), `release workflow missing: ${required}`);
}

const ciWorkflow = read('.github/workflows/ci.yml');
for (const required of [
  'workflow_dispatch:',
  "branches: [master, 'codex/**']",
  'windows-latest',
  'macos-15',
  'macos-15-intel',
  'npm test',
  'npm run build:renderer',
  'npm run build:whisper:mac',
  'npm run smoke:whisper:mac',
  'electron-builder --mac --${{ matrix.target_arch }} --dir',
  'npm run verify:package:mac',
]) {
  assert.ok(ciWorkflow.includes(required), `CI workflow missing: ${required}`);
}

const icon = fs.readFileSync(path.join(projectDir, mac.icon));
assert.equal(icon.toString('ascii', 1, 4), 'PNG');
assert.equal(icon.readUInt32BE(16), 1024);
assert.equal(icon.readUInt32BE(20), 1024);

for (const shell of ['index.html', 'badge.html', 'dailyplan.html']) {
  assert.ok(fs.existsSync(path.join(projectDir, 'src', 'renderer', shell)), `renderer shell missing from source: ${shell}`);
}

console.log('mac-release-config: all tests passed');
