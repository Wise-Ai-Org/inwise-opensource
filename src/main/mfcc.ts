/**
 * Pure TypeScript MFCC (Mel-Frequency Cepstral Coefficients) engine.
 * No external ML dependencies — runs entirely in Node.js.
 *
 * Pipeline: PCM → pre-emphasis → framing → Hamming window → FFT →
 *           mel filterbank → log → DCT → 13 coefficients per frame
 */

// ── Constants ────────────────────────────────────────────────────────────────

const NUM_COEFFICIENTS = 13;
const NUM_MEL_FILTERS = 26;
const FRAME_SIZE_MS = 25;
const FRAME_STEP_MS = 10;
const PRE_EMPHASIS = 0.97;

// ── FFT (radix-2 Cooley-Tukey) ──────────────────────────────────────────────

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  // Butterfly
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < half; j++) {
        const a = i + j;
        const b = a + half;
        const tRe = curRe * re[b] - curIm * im[b];
        const tIm = curRe * im[b] + curIm * re[b];
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/** Power spectrum of a real signal (zero-padded to next power of 2). */
function powerSpectrum(frame: Float64Array): Float64Array {
  const n = nextPow2(frame.length);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(frame);
  fft(re, im);
  // Only need first n/2+1 bins (Nyquist)
  const half = (n >> 1) + 1;
  const power = new Float64Array(half);
  for (let i = 0; i < half; i++) {
    power[i] = re[i] * re[i] + im[i] * im[i];
  }
  return power;
}

// ── Mel scale ────────────────────────────────────────────────────────────────

function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}

function melToHz(mel: number): number {
  return 700 * (Math.pow(10, mel / 2595) - 1);
}

/** Build triangular mel filterbank matrix. */
function melFilterbank(numFilters: number, fftSize: number, sampleRate: number): Float64Array[] {
  const nBins = (fftSize >> 1) + 1;
  const lowMel = hzToMel(0);
  const highMel = hzToMel(sampleRate / 2);

  // numFilters + 2 points evenly spaced on mel scale
  const melPoints = new Float64Array(numFilters + 2);
  for (let i = 0; i < numFilters + 2; i++) {
    melPoints[i] = lowMel + (i * (highMel - lowMel)) / (numFilters + 1);
  }

  // Convert to FFT bin indices
  const binPoints = new Float64Array(numFilters + 2);
  for (let i = 0; i < numFilters + 2; i++) {
    binPoints[i] = Math.floor((melToHz(melPoints[i]) * fftSize) / sampleRate);
  }

  const filters: Float64Array[] = [];
  for (let m = 0; m < numFilters; m++) {
    const filter = new Float64Array(nBins);
    const left = binPoints[m];
    const center = binPoints[m + 1];
    const right = binPoints[m + 2];

    for (let k = Math.floor(left); k <= Math.min(Math.floor(right), nBins - 1); k++) {
      if (k < center) {
        filter[k] = center > left ? (k - left) / (center - left) : 0;
      } else {
        filter[k] = right > center ? (right - k) / (right - center) : 0;
      }
    }
    filters.push(filter);
  }
  return filters;
}

// ── DCT-II ───────────────────────────────────────────────────────────────────

function dctII(input: Float64Array, numCoeffs: number): Float64Array {
  const n = input.length;
  const output = new Float64Array(numCoeffs);
  for (let k = 0; k < numCoeffs; k++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += input[i] * Math.cos((Math.PI * k * (2 * i + 1)) / (2 * n));
    }
    output[k] = sum;
  }
  return output;
}

// ── MFCC computation ─────────────────────────────────────────────────────────

/**
 * Compute MFCC feature vectors from raw PCM samples.
 * @param samples - Int16 PCM samples (mono, 16-bit)
 * @param sampleRate - Sample rate in Hz (e.g., 16000)
 * @returns Array of MFCC vectors (13 coefficients each), one per frame
 */
export function computeMFCC(samples: Int16Array, sampleRate: number): Float64Array[] {
  // Convert to float [-1, 1]
  const signal = new Float64Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    signal[i] = samples[i] / 32768;
  }

  // Pre-emphasis
  const emphasized = new Float64Array(signal.length);
  emphasized[0] = signal[0];
  for (let i = 1; i < signal.length; i++) {
    emphasized[i] = signal[i] - PRE_EMPHASIS * signal[i - 1];
  }

  // Frame parameters
  const frameSize = Math.round(sampleRate * FRAME_SIZE_MS / 1000);
  const frameStep = Math.round(sampleRate * FRAME_STEP_MS / 1000);
  const numFrames = Math.max(0, Math.floor((emphasized.length - frameSize) / frameStep) + 1);

  if (numFrames === 0) return [];

  // Hamming window
  const hamming = new Float64Array(frameSize);
  for (let i = 0; i < frameSize; i++) {
    hamming[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (frameSize - 1));
  }

  // Mel filterbank (computed once)
  const fftSize = nextPow2(frameSize);
  const filters = melFilterbank(NUM_MEL_FILTERS, fftSize, sampleRate);

  const mfccs: Float64Array[] = [];

  for (let f = 0; f < numFrames; f++) {
    const start = f * frameStep;

    // Apply window
    const frame = new Float64Array(frameSize);
    for (let i = 0; i < frameSize; i++) {
      frame[i] = emphasized[start + i] * hamming[i];
    }

    // Power spectrum
    const power = powerSpectrum(frame);

    // Apply mel filterbank
    const melEnergies = new Float64Array(NUM_MEL_FILTERS);
    for (let m = 0; m < NUM_MEL_FILTERS; m++) {
      let sum = 0;
      const filter = filters[m];
      const len = Math.min(filter.length, power.length);
      for (let k = 0; k < len; k++) {
        sum += filter[k] * power[k];
      }
      // Floor to avoid log(0)
      melEnergies[m] = Math.log(Math.max(sum, 1e-22));
    }

    // DCT to get cepstral coefficients
    const coeffs = dctII(melEnergies, NUM_COEFFICIENTS);
    mfccs.push(coeffs);
  }

  return mfccs;
}

/**
 * Compute a fixed-length voice embedding by averaging MFCC vectors across all frames.
 * Returns a 13-dimensional fingerprint vector.
 */
export function computeVoiceEmbedding(samples: Int16Array, sampleRate: number): Float64Array {
  const mfccs = computeMFCC(samples, sampleRate);
  if (mfccs.length === 0) {
    return new Float64Array(NUM_COEFFICIENTS);
  }

  const avg = new Float64Array(NUM_COEFFICIENTS);
  for (const frame of mfccs) {
    for (let i = 0; i < NUM_COEFFICIENTS; i++) {
      avg[i] += frame[i];
    }
  }
  for (let i = 0; i < NUM_COEFFICIENTS; i++) {
    avg[i] /= mfccs.length;
  }
  return avg;
}

/**
 * Compute cosine similarity between two embedding vectors.
 * Returns a value between -1 and 1 (higher = more similar).
 */
export function cosineSimilarity(a: Float64Array | number[], b: Float64Array | number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Compare a voice sample against a set of enrolled voice prints.
 * Returns matches sorted by similarity (highest first).
 */
export function identifySpeaker(
  samples: Int16Array,
  sampleRate: number,
  enrolledPrints: { name: string; embedding: number[] }[],
): { name: string; similarity: number }[] {
  const embedding = computeVoiceEmbedding(samples, sampleRate);

  const results = enrolledPrints.map(print => ({
    name: print.name,
    similarity: cosineSimilarity(embedding, print.embedding),
  }));

  return results.sort((a, b) => b.similarity - a.similarity);
}

/** Threshold above which we consider a speaker match confident. */
export const SPEAKER_MATCH_THRESHOLD = 0.85;
