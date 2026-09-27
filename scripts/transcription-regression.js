/*
 * Compare the transcription decoder variants on exactly the same WAV.
 *
 * Usage:
 *   npm run test:transcription -- C:\\path\\meeting.wav --duration-ms=900000
 *
 * The default window is the first 15 minutes so this is practical on CPU.
 * The output directory contains each variant's text and a JSON summary. This
 * is intentionally an explicit script rather than an automatic production
 * retry: it makes decoder regressions reproducible without changing a user's
 * saved transcript.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const wavPath = args.find(arg => !arg.startsWith('--'));
const durationArg = args.find(arg => arg.startsWith('--duration-ms='));
const durationMs = durationArg ? Number(durationArg.split('=')[1]) : 15 * 60 * 1000;

if (!wavPath || !fs.existsSync(wavPath)) {
  console.error('Usage: npm run test:transcription -- <wav-path> [--duration-ms=900000]');
  process.exit(2);
}
if (!Number.isFinite(durationMs) || durationMs <= 0) {
  console.error('--duration-ms must be a positive number');
  process.exit(2);
}

const userData = process.env.INWISE_USER_DATA || path.join(process.env.APPDATA || os.homedir(), 'inwise-opensource');
const exe = process.env.INWISE_WHISPER_EXE || path.join(userData, 'whisper-bin', 'Release', 'whisper-cli.exe');
const model = process.env.INWISE_WHISPER_MODEL || path.join(userData, 'whisper-models', 'ggml-small.bin');
const vad = process.env.INWISE_VAD_MODEL || path.join(userData, 'whisper-models', 'ggml-silero-v6.2.0.bin');
const reportDir = path.join(
  path.dirname(wavPath),
  `${path.basename(wavPath, path.extname(wavPath))}.transcription-regression-${Date.now()}`,
);
fs.mkdirSync(reportDir, { recursive: true });

const prompt = 'Meeting: Serval interview. Names: Shravani Vatti.';
const common = ['-m', model, '-f', wavPath, '-d', String(Math.round(durationMs)), '-nt', '--output-txt'];
const variants = [
  {
    name: 'legacy-stereo',
    args: ['-di'],
    description: 'small model + stereo diarization only',
  },
  {
    name: 'stereo-vad',
    args: ['--vad', '-vm', vad, '-vt', '0.50', '-vspd', '200', '-vsd', '600', '-vmsd', '30', '-vp', '100', '-vo', '0.10', '-di'],
    description: 'stereo diarization plus VAD',
  },
  {
    name: 'stereo-context',
    args: ['-mc', '64', '--prompt', prompt, '--carry-initial-prompt', '-di'],
    description: 'stereo diarization plus carried prompt/context',
  },
  {
    name: 'new-combined',
    args: ['--vad', '-vm', vad, '-vt', '0.50', '-vspd', '200', '-vsd', '600', '-vmsd', '30', '-vp', '100', '-vo', '0.10', '-mc', '64', '--prompt', prompt, '--carry-initial-prompt', '-di'],
    description: 'the previous production combination',
  },
];

function metrics(text) {
  const words = (text.match(/[a-z0-9']+/gi) || []).map(word => word.toLowerCase());
  const counts = new Map();
  let maxRepeatedFiveGram = 0;
  for (let i = 0; i <= words.length - 5; i++) {
    const gram = words.slice(i, i + 5).join(' ');
    const count = (counts.get(gram) || 0) + 1;
    counts.set(gram, count);
    maxRepeatedFiveGram = Math.max(maxRepeatedFiveGram, count);
  }
  return {
    chars: text.length,
    words: words.length,
    uniqueWordRatio: words.length ? new Set(words).size / words.length : 1,
    maxRepeatedFiveGram,
    repeatedSixYears: (text.match(/I did that for six years/gi) || []).length,
  };
}

const results = [];
for (const variant of variants) {
  const outputBase = path.join(reportDir, variant.name);
  const txtPath = `${outputBase}.txt`;
  try {
    execFileSync(exe, [...common, '-of', outputBase, ...variant.args], {
      cwd: path.dirname(exe),
      stdio: ['ignore', 'ignore', 'pipe'],
      maxBuffer: 2 * 1024 * 1024,
    });
    const text = fs.existsSync(txtPath) ? fs.readFileSync(txtPath, 'utf8').trim() : '';
    results.push({ ...variant, ok: true, metrics: metrics(text), textPath: txtPath });
  } catch (error) {
    results.push({
      ...variant,
      ok: false,
      error: String(error.stderr || error.message || error).slice(-1000),
      textPath: fs.existsSync(txtPath) ? txtPath : undefined,
    });
  }
}

const report = {
  wavPath: path.resolve(wavPath),
  durationMs,
  executable: exe,
  model,
  createdAt: new Date().toISOString(),
  results,
};
const reportPath = path.join(reportDir, 'summary.json');
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ reportPath, results }, null, 2));
