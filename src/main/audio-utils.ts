import * as fs from 'fs';

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
