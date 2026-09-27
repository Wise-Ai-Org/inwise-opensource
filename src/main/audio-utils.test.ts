import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { analyzeWavChannels, splitWavFile } from './audio-utils';

function stereoWav(left: number[], right: number[], sampleRate = 16000): Buffer {
  assert.equal(left.length, right.length);
  const data = Buffer.alloc(left.length * 4);
  for (let i = 0; i < left.length; i++) {
    data.writeInt16LE(left[i], i * 4);
    data.writeInt16LE(right[i], i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const left = Array.from({ length: 3200 }, (_, i) => Math.round(Math.sin(i / 11) * 9000));
const duplicate = analyzeWavChannels(stereoWav(left, left));
assert.equal(duplicate.usableStereo, false);
assert.match(duplicate.reason, /duplicates/);

const silent = analyzeWavChannels(stereoWav(left, left.map(() => 0)));
assert.equal(silent.usableStereo, false);
assert.match(silent.reason, /silent|quiet/);

const right = Array.from({ length: 3200 }, (_, i) => Math.round(Math.sin(i / 17 + 0.8) * 7000));
const distinct = analyzeWavChannels(stereoWav(left, right));
assert.equal(distinct.usableStereo, true);
assert.ok((distinct.correlation || 0) < 0.999);

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inwise-audio-utils-test-'));
try {
  const inputPath = path.join(fixtureDir, 'input.wav');
  fs.writeFileSync(inputPath, stereoWav(
    Array.from({ length: 16_000 * 3 }, (_, i) => Math.sin(i / 11) * 9000),
    Array.from({ length: 16_000 * 3 }, (_, i) => Math.sin(i / 17) * 7000),
  ));
  const chunks = splitWavFile(inputPath, path.join(fixtureDir, 'chunks'), 1, 0.1);
  assert.equal(chunks.length, 4);
  assert.equal(Math.round(chunks[0].startSeconds * 10) / 10, 0);
  assert.equal(Math.round(chunks[0].endSeconds * 10) / 10, 1);
  assert.equal(Math.round(chunks[1].startSeconds * 10) / 10, 0.9);
  assert.ok(chunks.every(chunk => fs.existsSync(chunk.path)));
} finally {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}

console.log('audio-utils tests passed');
