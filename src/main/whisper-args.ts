export interface WhisperRunOptions {
  modelPath: string;
  vadPath?: string;
  stereo: boolean;
  tinyDiarize: boolean;
  retry: boolean;
  useVad: boolean;
  outputBase: string;
  timeoutMs: number;
}

/**
 * Builds the production whisper.cpp command line. Initial prompts and carried
 * context are intentionally unsupported because they caused long recordings
 * to drift into repeated, invented phrases.
 */
export function buildWhisperArgs(audioPath: string, options: WhisperRunOptions): string[] {
  return [
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
}
