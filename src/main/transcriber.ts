import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';
import { execFileSync, spawn } from 'child_process';
import { app } from 'electron';
import { getConfig } from './config';
import { createWhisperRuntimePlan } from './whisper-runtime';
import { log } from './logger';
import { splitWavFile, WavChunk } from './audio-utils';
import {
  assessTranscriptQuality,
  chooseBetterTranscript,
  formatTinyDiarization,
} from './transcription-quality';

const MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
const TINY_DIARIZE_BASE_URL = 'https://huggingface.co/akashmjn/tinydiarize-whisper.cpp/resolve/main';
const VAD_MODEL = 'silero-v6.2.0';
const VAD_MODEL_URL = `https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-${VAD_MODEL}.bin`;
const TINY_DIARIZE_MODEL = 'small.en-tdrz';
const TRANSCRIPTION_CHUNK_SECONDS = 8 * 60;
const TRANSCRIPTION_CHUNK_OVERLAP_SECONDS = 1;
const TRANSCRIPTION_CHUNK_THRESHOLD_SECONDS = 10 * 60;

function getRuntimePlan() {
  return createWhisperRuntimePlan({
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath('userData'),
  });
}

function getWhisperExe(): string {
  const plan = getRuntimePlan();
  return plan.binaryCandidates.find(candidate => fs.existsSync(candidate)) ?? plan.binaryCandidates[0];
}

function getModelsDir(): string {
  return path.join(app.getPath('userData'), 'whisper-models');
}

function getModelPath(model: string): string {
  return path.join(getModelsDir(), `ggml-${model}.bin`);
}

function modelUrl(model: string): string {
  const base = model === TINY_DIARIZE_MODEL ? TINY_DIARIZE_BASE_URL : MODEL_BASE_URL;
  return `${base}/ggml-${model}.bin`;
}

type ProgressFn = (message: string, pct: number) => void;

function downloadFile(url: string, dest: string, onProgress?: ProgressFn): Promise<void> {
  return new Promise((resolve, reject) => {
    const partial = `${dest}.download`;
    const attempt = (nextUrl: string) => {
      const mod = nextUrl.startsWith('https') ? https : http;
      mod.get(nextUrl, { headers: { 'User-Agent': 'inwise-app' } }, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode!)) {
          res.resume();
          if (!res.headers.location) {
            reject(new Error(`Redirect without a location for ${nextUrl}`));
            return;
          }
          attempt(new URL(res.headers.location, nextUrl).toString());
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${nextUrl}`));
          return;
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        const file = fs.createWriteStream(partial);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress && total > 0) onProgress('', Math.round((received / total) * 100));
        });
        res.pipe(file);
        file.on('finish', () => file.close(() => {
          try {
            if (total > 0 && received !== total) {
              fs.unlinkSync(partial);
              reject(new Error(`Incomplete download for ${nextUrl}: received ${received} of ${total} bytes`));
              return;
            }
            if (fs.existsSync(dest)) fs.unlinkSync(dest);
            fs.renameSync(partial, dest);
            resolve();
          } catch (error) {
            reject(error);
          }
        }));
        file.on('error', (error) => {
          fs.unlink(partial, () => {});
          reject(error);
        });
      }).on('error', reject);
    };
    fs.unlink(partial, () => attempt(url));
  });
}

async function ensureBinary(onProgress?: ProgressFn): Promise<void> {
  const plan = getRuntimePlan();
  const exe = getWhisperExe();
  if (fs.existsSync(exe)) {
    if (plan.platform === 'darwin') fs.chmodSync(exe, 0o755);
    onProgress?.('Whisper engine ready', 100);
    return;
  }

  if (plan.platform === 'darwin') {
    throw new Error(
      `The bundled macOS Whisper engine is missing for ${plan.arch}. ` +
      'Development builds must run npm run build:whisper:mac before starting Inwise.',
    );
  }

  const dir = plan.installDir;
  fs.mkdirSync(dir, { recursive: true });
  const zipPath = plan.archivePath!;

  onProgress?.('Downloading Whisper engine…', 0);
  await downloadFile(plan.downloadUrl!, zipPath, (_, pct) => {
    onProgress?.(`Downloading Whisper engine… ${pct}%`, pct);
  });

  onProgress?.('Extracting…', 100);
  execFileSync('powershell', [
    '-NoProfile',
    '-Command',
    'Expand-Archive -Force -LiteralPath $args[0] -DestinationPath $args[1]',
    zipPath,
    dir,
  ], { stdio: 'pipe' });
  fs.unlinkSync(zipPath);

  if (!fs.existsSync(getWhisperExe())) throw new Error('Whisper binary not found after extraction');
}

async function ensureModel(model: string, onProgress?: ProgressFn): Promise<string> {
  fs.mkdirSync(getModelsDir(), { recursive: true });
  const modelPath = getModelPath(model);
  if (fs.existsSync(modelPath)) {
    onProgress?.('Model ready', 100);
    return modelPath;
  }

  onProgress?.(`Downloading ${model} model…`, 0);
  await downloadFile(modelUrl(model), modelPath, (_, pct) => {
    onProgress?.(`Downloading ${model} model… ${pct}%`, pct);
  });
  return modelPath;
}

async function ensureVadModel(onProgress?: ProgressFn): Promise<string> {
  fs.mkdirSync(getModelsDir(), { recursive: true });
  const vadPath = getModelPath(VAD_MODEL);
  if (fs.existsSync(vadPath)) {
    onProgress?.('Voice detector ready', 100);
    return vadPath;
  }
  onProgress?.('Downloading voice detector…', 0);
  await downloadFile(VAD_MODEL_URL, vadPath, (_, pct) => {
    onProgress?.(`Downloading voice detector… ${pct}%`, pct);
  });
  return vadPath;
}

// Called from onboarding to pre-download the normal model and the small VAD model.
export async function setupWhisper(model: string, onProgress: ProgressFn): Promise<void> {
  onProgress('Starting setup…', 0);
  await ensureBinary((msg, pct) => onProgress(msg, Math.round(pct * 0.3)));
  await ensureModel(model, (msg, pct) => onProgress(msg, 30 + Math.round(pct * 0.6)));
  await ensureVadModel((msg, pct) => onProgress(msg, 90 + Math.round(pct * 0.1)));
  onProgress('Setup complete', 100);
}

export interface TranscriptionOptions {
  meetingTitle?: string;
  attendees?: string[];
  userName?: string;
  /** Use TinyDiarize speaker-turn detection when separate audio channels are unavailable. */
  monoDiarization?: boolean;
}

interface WhisperRunOptions {
  modelPath: string;
  vadPath?: string;
  stereo: boolean;
  tinyDiarize: boolean;
  retry: boolean;
  useVad: boolean;
  outputBase: string;
  timeoutMs: number;
}

interface WhisperRunResult {
  text: string;
  segmentCount: number;
  averageLogprob?: number;
  averageNoSpeechProb?: number;
}

function numberFrom(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readWhisperSegmentStats(jsonPath: string): Pick<WhisperRunResult, 'segmentCount' | 'averageLogprob' | 'averageNoSpeechProb'> {
  try {
    const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as any;
    const segments = Array.isArray(parsed?.transcription)
      ? parsed.transcription
      : Array.isArray(parsed?.segments)
        ? parsed.segments
        : [];
    const logprobs = segments.map((segment: any) => numberFrom(segment?.avg_logprob)).filter((value: number | undefined): value is number => value !== undefined);
    const noSpeech = segments.map((segment: any) => numberFrom(segment?.no_speech_prob)).filter((value: number | undefined): value is number => value !== undefined);
    return {
      segmentCount: segments.length,
      ...(logprobs.length ? { averageLogprob: logprobs.reduce((sum: number, value: number) => sum + value, 0) / logprobs.length } : {}),
      ...(noSpeech.length ? { averageNoSpeechProb: noSpeech.reduce((sum: number, value: number) => sum + value, 0) / noSpeech.length } : {}),
    };
  } catch {
    return { segmentCount: 0 };
  }
}

async function runWhisper(audioPath: string, options: WhisperRunOptions): Promise<WhisperRunResult> {
  const exe = getWhisperExe();
  const txtPath = `${options.outputBase}.txt`;
  const jsonPath = `${options.outputBase}.json`;
  const vttPath = `${options.outputBase}.vtt`;
  for (const outputPath of [txtPath, jsonPath, vttPath]) {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  }

  const args = [
    '-m', options.modelPath,
    '-f', audioPath,
    '-nt',
    '--output-txt',
    '--output-vtt',
    '--output-json-full',
    '-of', options.outputBase,
    ...(options.useVad && options.vadPath ? [
      '--vad',
      '-vm', options.vadPath,
      '-vt', '0.50',
      '-vspd', '200',
      '-vsd', '600',
      '-vmsd', '30',
      '-vp', '100',
      '-vo', '0.10',
    ] : []),
    ...(options.stereo ? ['-di'] : []),
    ...(options.tinyDiarize ? ['-tdrz'] : []),
    ...(options.retry ? ['-nf', '-et', '2.20', '-nth', '0.45'] : []),
    ...(options.retry && !options.tinyDiarize ? ['-sns'] : []),
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn(exe, args, {
      cwd: path.dirname(exe),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    proc.stderr?.on('data', data => {
      stderr += data.toString();
      console.log('[whisper]', data.toString().trim());
    });
    proc.stdout?.on('data', data => {
      stdout += data.toString();
      console.log('[whisper out]', data.toString().trim());
    });

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error(`Whisper timed out after ${Math.round(options.timeoutMs / 1000)}s`));
    }, options.timeoutMs);

    proc.on('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    proc.on('close', code => {
      clearTimeout(timeout);
      const fileText = fs.existsSync(txtPath) ? fs.readFileSync(txtPath, 'utf8').trim() : '';
      const text = options.tinyDiarize && /\[SPEAKER_TURN\]/i.test(stdout)
        ? stdout.trim()
        : fileText || stdout.trim();
      const stats = fs.existsSync(jsonPath) ? readWhisperSegmentStats(jsonPath) : { segmentCount: 0 };
      for (const outputPath of [txtPath, jsonPath, vttPath]) {
        fs.unlink(outputPath, () => {});
      }
      if (text) {
        resolve({ text, ...stats });
        return;
      }
      if (code !== 0) {
        reject(new Error(`whisper exited ${code}: ${stderr.slice(-500)}`));
        return;
      }
      resolve({ text: '(no speech detected)', ...stats });
    });
  });
}

function stitchChunkText(previous: string, next: string): string {
  if (!previous.trim()) return next.trim();
  if (!next.trim()) return previous.trim();

  const previousTokens = previous.trim().split(/\s+/);
  const nextTrimmed = next.trim();
  const nextTokens = nextTrimmed.split(/\s+/);
  const normalize = (token: string) => token.toLowerCase().replace(/[^a-z0-9']+/g, '');
  const max = Math.min(20, previousTokens.length, nextTokens.length);
  let overlap = 0;
  for (let size = max; size >= 3; size--) {
    const left = previousTokens.slice(-size).map(normalize).join(' ');
    const right = nextTokens.slice(0, size).map(normalize).join(' ');
    if (left && left === right) {
      overlap = size;
      break;
    }
  }
  if (!overlap) return `${previous.trim()}\n${nextTrimmed}`;

  let offset = 0;
  for (let i = 0; i < overlap; i++) {
    offset = nextTrimmed.indexOf(nextTokens[i], offset) + nextTokens[i].length;
    while (/\s/.test(nextTrimmed[offset] || '')) offset++;
  }
  const remainder = nextTrimmed.slice(offset).trim();
  return remainder ? `${previous.trim()}\n${remainder}` : previous.trim();
}

export interface TranscriptionResult {
  transcript: string;
  quality: ReturnType<typeof assessTranscriptQuality>;
  metadata: {
    model: string;
    stereo: boolean;
    usedVad: boolean;
    usedInitialPrompt: boolean;
    chunkCount: number;
    chunkSeconds: number;
    overlapSeconds: number;
    chunks: Array<{
      startSeconds: number;
      endSeconds: number;
      textLength: number;
      segmentCount: number;
      quality: ReturnType<typeof assessTranscriptQuality>;
      averageLogprob?: number;
      averageNoSpeechProb?: number;
    }>;
  };
}

export async function transcribeAudioDetailed(
  audioPath: string,
  stereo = false,
  context: TranscriptionOptions = {},
): Promise<TranscriptionResult> {
  const { whisperModel } = getConfig();
  const tinyDiarize = !stereo && context.monoDiarization === true;
  const primaryModel = tinyDiarize ? TINY_DIARIZE_MODEL : whisperModel;

  await ensureBinary();
  const modelPath = await ensureModel(primaryModel);
  // The same-audio regression showed that whisper.cpp's stereo diarizer needs
  // VAD to find the right-channel speech after leading silence. The safe
  // rollback is therefore to remove carried prompt/context for stereo, not to
  // remove VAD itself.
  const useVad = true;
  const vadPath = useVad ? await ensureVadModel() : undefined;

  console.log('[whisper] transcribing:', audioPath,
    stereo ? '(validated stereo diarization)' : tinyDiarize ? '(mono TinyDiarize)' : '(mono)');

  // Whisper runs roughly 3–5x real-time on CPU. Give the stronger default and
  // retry pass enough room without allowing a hung child process indefinitely.
  const fileSize = fs.existsSync(audioPath) ? fs.statSync(audioPath).size : 0;
  const bytesPerSec = stereo ? 64000 : 32000;
  const audioSeconds = Math.max(1, fileSize / bytesPerSec);
  const maxRunSeconds = audioSeconds > TRANSCRIPTION_CHUNK_THRESHOLD_SECONDS
    ? TRANSCRIPTION_CHUNK_SECONDS
    : audioSeconds;
  const maxRunTimeoutMs = Math.max(120_000, Math.round(maxRunSeconds * 12 * 1000) + 60_000);
  console.log(`[whisper] audio ~${Math.round(audioSeconds)}s, max run timeout ${Math.round(maxRunTimeoutMs / 1000)}s, model ${primaryModel}, VAD ${useVad ? 'on' : 'off'}, chunks ${audioSeconds > TRANSCRIPTION_CHUNK_THRESHOLD_SECONDS ? 'on' : 'off'}`);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inwise-transcription-'));
  let chunks: WavChunk[] = [{ path: audioPath, startSeconds: 0, endSeconds: audioSeconds }];
  try {
    if (audioSeconds > TRANSCRIPTION_CHUNK_THRESHOLD_SECONDS) {
      chunks = splitWavFile(audioPath, tempDir, TRANSCRIPTION_CHUNK_SECONDS, TRANSCRIPTION_CHUNK_OVERLAP_SECONDS);
      log('info', 'pipeline:transcription-chunked', `chunks=${chunks.length} chunkSeconds=${TRANSCRIPTION_CHUNK_SECONDS} overlapSeconds=${TRANSCRIPTION_CHUNK_OVERLAP_SECONDS}`);
    }

    const texts: string[] = [];
    const chunkMetadata: TranscriptionResult['metadata']['chunks'] = [];
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index];
      const chunkDurationSeconds = Math.max(1, chunk.endSeconds - chunk.startSeconds);
      const chunkTimeoutMs = Math.max(120_000, Math.round(chunkDurationSeconds * 12 * 1000) + 60_000);
      const first = await runWhisper(chunk.path, {
        modelPath,
        vadPath,
        stereo,
        tinyDiarize,
        retry: false,
        useVad,
        outputBase: path.join(tempDir, `run-${String(index).padStart(4, '0')}-first`),
        timeoutMs: chunkTimeoutMs,
      });
      const firstQuality = assessTranscriptQuality(first.text);
      let selected = first;
      let selectedQuality = firstQuality;
      if (!firstQuality.ok) {
        const retryModel = tinyDiarize
          ? TINY_DIARIZE_MODEL
          : (whisperModel === 'tiny' || whisperModel === 'base' ? 'small' : whisperModel);
        const retryModelPath = retryModel === primaryModel ? modelPath : await ensureModel(retryModel);
        log('warn', 'pipeline:transcription-retry', `chunk=${index + 1}/${chunks.length} model=${retryModel} reasons=${firstQuality.reasons.join('; ')}`);
        const retry = await runWhisper(chunk.path, {
          modelPath: retryModelPath,
          vadPath,
          stereo,
          tinyDiarize,
          retry: true,
          useVad,
          outputBase: path.join(tempDir, `run-${String(index).padStart(4, '0')}-retry`),
          timeoutMs: chunkTimeoutMs,
        });
        const retryQuality = assessTranscriptQuality(retry.text);
        selected = chooseBetterTranscript(first.text, retry.text) === retry.text ? retry : first;
        selectedQuality = selected === retry ? retryQuality : firstQuality;
      }
      texts.push(selected.text);
      chunkMetadata.push({
        startSeconds: chunk.startSeconds,
        endSeconds: chunk.endSeconds,
        textLength: selected.text.length,
        segmentCount: selected.segmentCount,
        quality: selectedQuality,
        ...(selected.averageLogprob === undefined ? {} : { averageLogprob: selected.averageLogprob }),
        ...(selected.averageNoSpeechProb === undefined ? {} : { averageNoSpeechProb: selected.averageNoSpeechProb }),
      });
    }

    const stitched = texts.reduce((result, text) => stitchChunkText(result, text), '');
    const transcript = tinyDiarize ? formatTinyDiarization(stitched) : stitched;
    const quality = assessTranscriptQuality(transcript);
    const metadata: TranscriptionResult['metadata'] = {
      model: primaryModel,
      stereo,
      usedVad: useVad,
      usedInitialPrompt: false,
      chunkCount: chunks.length,
      chunkSeconds: TRANSCRIPTION_CHUNK_SECONDS,
      overlapSeconds: TRANSCRIPTION_CHUNK_OVERLAP_SECONDS,
      chunks: chunkMetadata,
    };
    try {
      fs.writeFileSync(`${audioPath}.transcription.json`, JSON.stringify({ quality, ...metadata }, null, 2));
    } catch (metadataError: any) {
      log('warn', 'pipeline:transcription-metadata-failed', metadataError.message);
    }
    return { transcript: transcript || '(no speech detected)', quality, metadata };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function transcribeAudio(
  audioPath: string,
  stereo = false,
  context: TranscriptionOptions = {},
): Promise<string> {
  const result = await transcribeAudioDetailed(audioPath, stereo, context);
  return result.transcript;
}
