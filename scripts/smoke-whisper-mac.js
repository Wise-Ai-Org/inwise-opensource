const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { version: whisperVersion } = require('../src/main/whisper-runtime-config.json');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status})\n${result.stdout || ''}${result.stderr || ''}`,
    );
  }
  return result;
}

if (process.platform !== 'darwin') {
  throw new Error('The macOS Whisper smoke test must run on macOS');
}

const projectDir = path.resolve(__dirname, '..');
const buildRoot = path.join(projectDir, 'native', '.build');
const binaryPath = path.join(projectDir, 'native', 'whisper', `darwin-${process.arch}`, 'whisper-cli');
const samplePath = path.join(buildRoot, `whisper.cpp-${whisperVersion}`, 'samples', 'jfk.wav');
const modelDir = path.join(buildRoot, 'models');
const modelPath = path.join(modelDir, 'ggml-tiny.en.bin');
const partialModelPath = `${modelPath}.part`;
const outputStem = path.join(buildRoot, `smoke-${process.arch}`);

for (const requiredPath of [binaryPath, samplePath]) {
  if (!fs.existsSync(requiredPath)) throw new Error(`Missing Whisper smoke-test input: ${requiredPath}`);
}

fs.mkdirSync(modelDir, { recursive: true });
if (!fs.existsSync(modelPath)) {
  fs.rmSync(partialModelPath, { force: true });
  run('curl', [
    '--fail', '--location', '--retry', '3',
    'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin',
    '--output', partialModelPath,
  ], { stdio: 'inherit' });
  fs.renameSync(partialModelPath, modelPath);
}

fs.rmSync(`${outputStem}.txt`, { force: true });
run(binaryPath, [
  '-m', modelPath,
  '-f', samplePath,
  '-nt',
  '--output-txt',
  '-of', outputStem,
], { stdio: 'inherit' });

const transcriptPath = `${outputStem}.txt`;
const transcript = fs.readFileSync(transcriptPath, 'utf8').trim();
if (!/ask\s+not\s+what\s+your\s+country/i.test(transcript)) {
  throw new Error(`Unexpected Whisper smoke transcript: ${transcript}`);
}

process.stdout.write(`WHISPER_TRANSCRIPTION_HEALTHY arch=${process.arch}\n${transcript}\n`);
