import * as fs from 'fs';
import * as path from 'path';

export interface WavChannelAnalysis {
  channels: number;
  sampleRate: number;
  durationSeconds: number;
  rms: number[];
  peak: number[];
  correlation: number | null;
  differenceRms: number | null;
  usableStereo: boolean;
  reason: string;
}

interface ParsedWav {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataOffset: number;
  dataSize: number;
}

export interface WavChunk {
  path: string;
  startSeconds: number;
  endSeconds: number;
}

function parseWav(buf: Buffer): ParsedWav {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Invalid WAV file');
  }
  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let audioFormat = 0;
  let dataOffset = 0;
  let dataSize = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= buf.length) {
      audioFormat = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bitsPerSample = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      dataOffset = body;
      dataSize = Math.min(size, buf.length - body);
      break;
    }
    offset = body + size + (size % 2);
  }
  if (audioFormat !== 1 || bitsPerSample !== 16 || channels < 1 || !sampleRate || !dataOffset) {
    throw new Error('WAV channel validation requires 16-bit PCM audio');
  }
  return { channels, sampleRate, bitsPerSample, dataOffset, dataSize };
}

/**
 * Inspect the finished PCM file before enabling whisper.cpp channel diarization.
 * A captured stream only counts as stereo when both channels contain signal and
 * they are meaningfully different; duplicated channels caused the original
 * runaway transcript failure.
 */
export function analyzeWavChannels(input: string | Buffer): WavChannelAnalysis {
  const buf = typeof input === 'string' ? fs.readFileSync(input) : input;
  const wav = parseWav(buf);
  const bytesPerSample = wav.bitsPerSample / 8;
  const frameSize = wav.channels * bytesPerSample;
  const frames = Math.floor(wav.dataSize / frameSize);
  const step = Math.max(1, Math.floor(frames / 300_000));
  const sums = Array(wav.channels).fill(0);
  const sumsSq = Array(wav.channels).fill(0);
  const peaks = Array(wav.channels).fill(0);
  let cross = 0;
  let sampled = 0;

  for (let frame = 0; frame < frames; frame += step) {
    const base = wav.dataOffset + frame * frameSize;
    const values: number[] = [];
    for (let channel = 0; channel < wav.channels; channel++) {
      const value = buf.readInt16LE(base + channel * bytesPerSample) / 32768;
      values.push(value);
      sums[channel] += value;
      sumsSq[channel] += value * value;
      peaks[channel] = Math.max(peaks[channel], Math.abs(value));
    }
    if (wav.channels >= 2) cross += values[0] * values[1];
    sampled++;
  }

  const rms = sumsSq.map(value => Math.sqrt(value / Math.max(1, sampled)));
  let correlation: number | null = null;
  let differenceRms: number | null = null;
  if (wav.channels >= 2 && sampled > 0) {
    const mean0 = sums[0] / sampled;
    const mean1 = sums[1] / sampled;
    const variance0 = Math.max(0, sumsSq[0] / sampled - mean0 * mean0);
    const variance1 = Math.max(0, sumsSq[1] / sampled - mean1 * mean1);
    const covariance = cross / sampled - mean0 * mean1;
    const denom = Math.sqrt(variance0 * variance1);
    correlation = denom > 1e-12 ? covariance / denom : null;
    differenceRms = Math.sqrt(Math.max(0, (sumsSq[0] + sumsSq[1] - 2 * cross) / sampled));
  }

  let usableStereo = wav.channels >= 2;
  let reason = usableStereo ? 'two distinct active channels' : 'recording is mono';
  if (usableStereo && (rms[0] < 0.0002 || rms[1] < 0.0002 || peaks[0] < 0.001 || peaks[1] < 0.001)) {
    usableStereo = false;
    reason = 'one stereo channel is silent or too quiet';
  } else if (usableStereo && differenceRms !== null && correlation !== null
      && correlation > 0.999 && differenceRms < Math.max(0.0002, Math.max(rms[0], rms[1]) * 0.01)) {
    usableStereo = false;
    reason = 'left and right channels are duplicates';
  }

  return {
    channels: wav.channels,
    sampleRate: wav.sampleRate,
    durationSeconds: frames / wav.sampleRate,
    rms,
    peak: peaks,
    correlation,
    differenceRms,
    usableStereo,
    reason,
  };
}

/**
 * Split a PCM WAV into bounded, slightly-overlapping files for transcription.
 * Keeping the overlap in the audio (rather than in Whisper's text context)
 * preserves words at chunk boundaries without allowing a two-hour recording to
 * carry decoder state from one unrelated conversation into the next.
 */
export function splitWavFile(
  wavPath: string,
  outputDir: string,
  chunkSeconds = 8 * 60,
  overlapSeconds = 1,
): WavChunk[] {
  const buf = fs.readFileSync(wavPath);
  const wav = parseWav(buf);
  if (wav.channels < 1 || wav.bitsPerSample !== 16) {
    throw new Error('WAV chunking requires 16-bit PCM audio');
  }
  if (!Number.isFinite(chunkSeconds) || chunkSeconds <= 0) {
    throw new Error('WAV chunk duration must be positive');
  }
  const frameSize = wav.channels * (wav.bitsPerSample / 8);
  const totalFrames = Math.floor(wav.dataSize / frameSize);
  const chunkFrames = Math.max(1, Math.floor(chunkSeconds * wav.sampleRate));
  const overlapFrames = Math.max(0, Math.min(
    chunkFrames - 1,
    Math.floor(Math.max(0, overlapSeconds) * wav.sampleRate),
  ));
  const advanceFrames = Math.max(1, chunkFrames - overlapFrames);

  fs.mkdirSync(outputDir, { recursive: true });
  const chunks: WavChunk[] = [];
  let startFrame = 0;
  let index = 0;
  while (startFrame < totalFrames) {
    const endFrame = Math.min(totalFrames, startFrame + chunkFrames);
    const dataStart = wav.dataOffset + startFrame * frameSize;
    const dataEnd = wav.dataOffset + endFrame * frameSize;
    const data = buf.subarray(dataStart, dataEnd);
    const header = Buffer.alloc(44);
    const dataLength = data.length;
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataLength, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(wav.channels, 22);
    header.writeUInt32LE(wav.sampleRate, 24);
    header.writeUInt32LE(wav.sampleRate * frameSize, 28);
    header.writeUInt16LE(frameSize, 32);
    header.writeUInt16LE(wav.bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataLength, 40);

    const chunkPath = path.join(outputDir, `chunk-${String(index).padStart(4, '0')}.wav`);
    fs.writeFileSync(chunkPath, Buffer.concat([header, data]));
    chunks.push({
      path: chunkPath,
      startSeconds: startFrame / wav.sampleRate,
      endSeconds: endFrame / wav.sampleRate,
    });

    if (endFrame >= totalFrames) break;
    startFrame += advanceFrames;
    index++;
  }
  return chunks;
}

/**
 * Extract Int16 PCM samples from a WAV buffer (assumes 16-bit PCM).
 */
export function wavBufferToSamples(wav: Buffer): Int16Array {
  // Find 'data' chunk
  let dataOffset = 12;
  let dataSize = 0;
  while (dataOffset < wav.length - 8) {
    const chunkId = wav.toString('ascii', dataOffset, dataOffset + 4);
    const chunkSize = wav.readUInt32LE(dataOffset + 4);
    if (chunkId === 'data') {
      dataOffset += 8;
      dataSize = chunkSize;
      break;
    }
    dataOffset += 8 + chunkSize;
  }

  const numChannels = wav.readUInt16LE(22);
  const bytesPerSample = wav.readUInt16LE(34) / 8;

  if (numChannels === 1 && bytesPerSample === 2) {
    // Mono 16-bit — direct copy
    const samples = new Int16Array(dataSize / 2);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = wav.readInt16LE(dataOffset + i * 2);
    }
    return samples;
  }

  // Multi-channel: take first channel only
  const frameSize = numChannels * bytesPerSample;
  const totalFrames = Math.floor(dataSize / frameSize);
  const samples = new Int16Array(totalFrames);
  for (let i = 0; i < totalFrames; i++) {
    samples[i] = wav.readInt16LE(dataOffset + i * frameSize);
  }
  return samples;
}

/**
 * Extract a single channel from a stereo WAV file and return as a mono WAV buffer.
 * channel 0 = left (mic/user), channel 1 = right (system/others)
 */
export function extractChannel(wavPath: string, channel: 0 | 1): Buffer {
  const buf = fs.readFileSync(wavPath);

  // Parse WAV header
  const numChannels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);
  const bytesPerSample = bitsPerSample / 8;

  if (numChannels < 2) {
    throw new Error('WAV is not stereo — cannot extract channel');
  }

  // Find 'data' chunk
  let dataOffset = 12;
  while (dataOffset < buf.length - 8) {
    const chunkId = buf.toString('ascii', dataOffset, dataOffset + 4);
    const chunkSize = buf.readUInt32LE(dataOffset + 4);
    if (chunkId === 'data') {
      dataOffset += 8;
      break;
    }
    dataOffset += 8 + chunkSize;
  }

  const frameSize = numChannels * bytesPerSample;
  const dataEnd = Math.min(buf.length, dataOffset + buf.readUInt32LE(dataOffset - 4));
  const totalFrames = Math.floor((dataEnd - dataOffset) / frameSize);

  // Extract target channel samples
  const monoSamples = Buffer.alloc(totalFrames * bytesPerSample);
  for (let i = 0; i < totalFrames; i++) {
    const srcOffset = dataOffset + i * frameSize + channel * bytesPerSample;
    buf.copy(monoSamples, i * bytesPerSample, srcOffset, srcOffset + bytesPerSample);
  }

  // Build mono WAV
  const monoDataLength = monoSamples.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + monoDataLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);           // fmt chunk size
  header.writeUInt16LE(1, 20);            // PCM
  header.writeUInt16LE(1, 22);            // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * bytesPerSample, 28); // byte rate
  header.writeUInt16LE(bytesPerSample, 32);              // block align
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(monoDataLength, 40);

  return Buffer.concat([header, monoSamples]);
}

/**
 * Trim a WAV buffer to at most `maxSeconds` seconds (from the start).
 * Returns the original buffer if it's already shorter.
 */
export function trimWav(wav: Buffer, maxSeconds: number): Buffer {
  const sampleRate = wav.readUInt32LE(24);
  const numChannels = wav.readUInt16LE(22);
  const bitsPerSample = wav.readUInt16LE(34);
  const bytesPerSample = bitsPerSample / 8;
  const frameSize = numChannels * bytesPerSample;
  const maxFrames = sampleRate * maxSeconds;
  const maxDataBytes = maxFrames * frameSize;

  const dataSize = wav.readUInt32LE(40);
  if (dataSize <= maxDataBytes) return wav;

  const trimmedDataSize = maxDataBytes;
  const trimmed = Buffer.alloc(44 + trimmedDataSize);
  wav.copy(trimmed, 0, 0, 44); // copy header
  wav.copy(trimmed, 44, 44, 44 + trimmedDataSize); // copy trimmed data

  // Fix header sizes
  trimmed.writeUInt32LE(36 + trimmedDataSize, 4);  // RIFF size
  trimmed.writeUInt32LE(trimmedDataSize, 40);        // data size

  return trimmed;
}
