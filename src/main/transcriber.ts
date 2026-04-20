import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import { execSync, spawn } from 'child_process';
import { app } from 'electron';
import { getConfig } from './config';

const WHISPER_VERSION = 'v1.8.4';
const WHISPER_ZIP_URL = `https://github.com/ggerganov/whisper.cpp/releases/download/${WHISPER_VERSION}/whisper-bin-x64.zip`;
const MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

function getWhisperDir(): string {
  return path.join(app.getPath('userData'), 'whisper-bin');
}

function getWhisperExe(): string {
  const cli = path.join(getWhisperDir(), 'Release', 'whisper-cli.exe');
  const main = path.join(getWhisperDir(), 'Release', 'main.exe');
  return fs.existsSync(cli) ? cli : main;
}

function getModelsDir(): string {
  return path.join(app.getPath('userData'), 'whisper-models');
}

function getModelPath(model: string): string {
  return path.join(getModelsDir(), `ggml-${model}.bin`);
}

type ProgressFn = (message: string, pct: number) => void;

function downloadFile(url: string, dest: string, onProgress?: ProgressFn): Promise<void> {
  return new Promise((resolve, reject) => {
    const attempt = (url: string) => {
      const mod = url.startsWith('https') ? https : http;
      mod.get(url, { headers: { 'User-Agent': 'inwise-app' } }, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode!)) {
          attempt(res.headers.location!);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        const file = fs.createWriteStream(dest);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress && total > 0) {
            onProgress('', Math.round((received / total) * 100));
          }
        });
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', (e) => { fs.unlink(dest, () => {}); reject(e); });
      }).on('error', reject);
    };
    attempt(url);
  });
}

async function ensureBinary(onProgress?: ProgressFn): Promise<void> {
  const exe = getWhisperExe();
  if (fs.existsSync(exe)) {
    onProgress?.('Whisper engine ready', 100);
    return;
  }

  const dir = getWhisperDir();
  fs.mkdirSync(dir, { recursive: true });
  const zipPath = path.join(dir, 'whisper-bin.zip');

  onProgress?.('Downloading Whisper engine…', 0);
  await downloadFile(WHISPER_ZIP_URL, zipPath, (_, pct) => {
    onProgress?.(`Downloading Whisper engine… ${pct}%`, pct);
  });

  onProgress?.('Extracting…', 100);
  execSync(
    `powershell -NoProfile -Command "Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${dir}'"`,
    { stdio: 'pipe' }
  );
  fs.unlinkSync(zipPath);

  if (!fs.existsSync(getWhisperExe())) {
    throw new Error('Whisper binary not found after extraction');
  }
}

async function ensureModel(model: string, onProgress?: ProgressFn): Promise<string> {
  fs.mkdirSync(getModelsDir(), { recursive: true });
  const modelPath = getModelPath(model);

  if (fs.existsSync(modelPath)) {
    onProgress?.(`Model ready`, 100);
    return modelPath;
  }

  const url = `${MODEL_BASE_URL}/ggml-${model}.bin`;
  onProgress?.(`Downloading ${model} model…`, 0);
  await downloadFile(url, modelPath, (_, pct) => {
    onProgress?.(`Downloading ${model} model… ${pct}%`, pct);
  });

  return modelPath;
}

// Called from onboarding to pre-download everything
export async function setupWhisper(model: string, onProgress: ProgressFn): Promise<void> {
  onProgress('Starting setup…', 0);
  await ensureBinary((msg, pct) => onProgress(msg, Math.round(pct * 0.4)));          // 0–40%
  await ensureModel(model, (msg, pct) => onProgress(msg, 40 + Math.round(pct * 0.6))); // 40–100%
  onProgress('Setup complete', 100);
}

export async function transcribeAudio(audioPath: string, stereo?: boolean): Promise<string> {
  const { whisperModel } = getConfig();

  await ensureBinary();
  const modelPath = await ensureModel(whisperModel);
  const exe = getWhisperExe();

  console.log('[whisper] transcribing:', audioPath, stereo ? '(stereo diarize)' : '(mono)');

  // Calculate timeout based on file size — Whisper runs roughly 3-5x real-time on base model
  // 16kHz mono PCM = 32 KB/sec, stereo = 64 KB/sec. Allow 10x audio duration plus 60s buffer.
  const fileSize = fs.existsSync(audioPath) ? fs.statSync(audioPath).size : 0;
  const bytesPerSec = stereo ? 64000 : 32000;
  const audioSeconds = Math.max(60, fileSize / bytesPerSec);
  const timeoutMs = Math.max(120_000, Math.round(audioSeconds * 10 * 1000) + 60_000);
  console.log(`[whisper] audio ~${Math.round(audioSeconds)}s, timeout set to ${Math.round(timeoutMs / 1000)}s`);

  // whisper appends .txt keeping full filename: foo.wav → foo.wav.txt
  const txtPath = audioPath + '.txt';

  const args = [
    '-m', modelPath,
    '-f', audioPath,
    '-nt',
    '--output-txt',
    ...(stereo ? ['-di'] : []),
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn(exe, args, {
      cwd: path.dirname(exe),
      stdio: ['ignore', 'pipe', 'pipe'], // ignore stdin so process doesn't hang
    });

    let stderr = '';
    let stdout = '';
    proc.stderr?.on('data', (d) => { stderr += d.toString(); console.log('[whisper]', d.toString().trim()); });
    proc.stdout?.on('data', (d) => { stdout += d.toString(); console.log('[whisper out]', d.toString().trim()); });

    // Safety timeout — scaled to audio duration
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error(`Whisper timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    proc.on('error', (e) => { clearTimeout(timeout); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (fs.existsSync(txtPath)) {
        const text = fs.readFileSync(txtPath, 'utf8').trim();
        fs.unlink(txtPath, () => {});
        resolve(text || '(no speech detected)');
        return;
      }
      if (code !== 0) {
        reject(new Error(`whisper exited ${code}: ${stderr.slice(-500)}`));
        return;
      }
      resolve(stdout.trim() || '(no speech detected)');
    });
  });
}
