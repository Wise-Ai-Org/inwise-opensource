import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { getConfig } from './config';

export async function transcribeAudio(audioPath: string): Promise<string> {
  const { whisperModel } = getConfig();

  // nodejs-whisper wraps whisper.cpp — model files are downloaded on first use
  // and cached in the app's userData directory
  const { nodewhisper } = await import('nodejs-whisper');

  const modelDir = path.join(app.getPath('userData'), 'whisper-models');
  fs.mkdirSync(modelDir, { recursive: true });

  const result = await nodewhisper(audioPath, {
    modelName: whisperModel,
    autoDownloadModelName: whisperModel,
    removeWavFileAfterTranscription: false,
    withCuda: false,
    whisperOptions: {
      outputInText: true,
      outputInVtt: false,
      outputInSrt: false,
      translateToEnglish: false,
      timestamps_length: 60,
      splitOnWord: true,
    },
  } as any);

  if (typeof result === 'string') return (result as string).trim();

  // result may be an array of segments
  if (Array.isArray(result)) {
    return (result as any[]).map((s: any) => s.speech || s.text || '').join(' ').trim();
  }

  throw new Error('Unexpected transcription result format');
}
