// inwise-desktop-shared — TranscriptionAdapter interface
// NO runtime code — interfaces and type aliases only.

export interface TranscribeOpts {
  /** BCP-47 language hint (e.g. 'en', 'es'). Undefined = auto-detect. */
  language?: string;
  /** Whisper model variant — only meaningful for local transcription. */
  model?: 'tiny' | 'base' | 'small' | 'medium';
  /** Called with partial text as transcription progresses. */
  onProgress?: (partial: string) => void;
}

export interface TranscriptSegment {
  start: number;    // seconds
  end: number;      // seconds
  text: string;
  speaker?: string;
}

export interface TranscriptResult {
  text: string;
  segments?: TranscriptSegment[];
  language?: string;
  durationSecs?: number;
}

export interface TranscriptionAdapter {
  /** True if this adapter transcribes locally; false if it calls a remote API. */
  readonly isLocal: boolean;
  transcribe(audio: ArrayBuffer, opts?: TranscribeOpts): Promise<TranscriptResult>;
}
