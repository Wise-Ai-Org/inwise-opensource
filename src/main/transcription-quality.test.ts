import * as assert from 'node:assert/strict';
import {
  assessTranscriptQuality,
  buildMeetingPrompt,
  chooseBetterTranscript,
  formatTinyDiarization,
  inferMeetingType,
  sanitizeDueDate,
  computeExtractionCoverage,
  normalizeSpeakerLabels,
} from './transcription-quality';
import { buildWhisperArgs } from './whisper-args';

const productionArgs = buildWhisperArgs('meeting.wav', {
  modelPath: 'ggml-base.bin',
  vadPath: 'ggml-silero-v6.2.0.bin',
  stereo: true,
  tinyDiarize: false,
  retry: false,
  useVad: true,
  outputBase: 'meeting-output',
  timeoutMs: 120_000,
});
assert.ok(productionArgs.includes('--vad'), 'validated stereo capture keeps VAD enabled');
assert.ok(productionArgs.includes('-di'), 'validated stereo capture keeps channel diarization enabled');
assert.ok(!productionArgs.includes('--prompt'), 'production transcription must not inject a meeting prompt');
assert.ok(!productionArgs.includes('--carry-initial-prompt'), 'production transcription must not carry prompt context');
assert.ok(!productionArgs.includes('-mc'), 'production transcription must not cap and carry decoder context');

const loop = Array.from({ length: 18 }, () => 'We are going to have a lot of fun.').join(' ');
const bad = assessTranscriptQuality(loop);
assert.equal(bad.ok, false);
assert.ok(bad.reasons.some(reason => reason.includes('phrase loop')));

const noises = assessTranscriptQuality('(dog barks) '.repeat(12));
assert.equal(noises.ok, false);
assert.ok(noises.reasons.some(reason => reason.includes('non-speech')));

const normal = assessTranscriptQuality(
  'We reviewed the onboarding flow and agreed to shorten the form. ' +
  'Tony will update the prototype by Friday, and Shravani will schedule user interviews next week.'
);
assert.equal(normal.ok, true);
assert.equal(chooseBetterTranscript(loop, 'Tony will share the updated prototype after the customer interview.'),
  'Tony will share the updated prototype after the customer interview.');

const embeddedLoop = [
  'We discussed the company history and the hiring plan.',
  ...Array.from({ length: 6 }, () => 'I did that for six years.'),
  'Then we moved on to the pricing strategy and next steps.',
].join(' ');
const embeddedQuality = assessTranscriptQuality(embeddedLoop);
assert.equal(embeddedQuality.ok, false);
assert.ok(embeddedQuality.reasons.some(reason => reason.includes('localized repeated phrase loop')));
const labelsOnly = assessTranscriptQuality(
  '(speaker 1): hello\n(speaker ?): hi\n(speaker 1): thanks\n(speaker ?): goodbye',
);
assert.equal(labelsOnly.ok, true, 'speaker markers alone should not be treated as non-speech');
assert.equal(labelsOnly.speakerMarkerCount, 4);

assert.equal(
  buildMeetingPrompt('Serval\ninterview', ['Tony', 'tony', 'Priya'], 'Shravani'),
  'Meeting: Serval interview. Names: Shravani, Tony, Priya.'
);

assert.equal(
  formatTinyDiarization('Hello there. [SPEAKER_TURN] Hi! [SPEAKER_TURN] How are you?'),
  'Speaker 1: Hello there.\nSpeaker 2: Hi!\nSpeaker 1: How are you?'
);

assert.equal(inferMeetingType('Ethan Galloway', 'We discussed customer onboarding pain points and next steps.'), 'customer');
assert.equal(sanitizeDueDate('2025-01-10', '2026-09-10T20:35:23.946Z'), undefined);
assert.equal(sanitizeDueDate('2026-09-12', '2026-09-10T20:35:23.946Z'), '2026-09-12');
assert.equal(
  normalizeSpeakerLabels('[SPEAKER_0]: hello\n[SPEAKER_1]: hi\n(speaker ?): unknown', 'Shravani', ['Ethan Galloway']),
  'Shravani: hello\nEthan Galloway: hi\nOther speaker: unknown',
);
assert.deepEqual(
  computeExtractionCoverage({ transcript: 'hello', summary: 'summary', signals: ['need'], missing: ['speaker identity'] }),
  { score: 0.4, missing: ['speaker identity'] },
);

console.log('transcription-quality tests passed');
