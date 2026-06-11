// Ported from desktop-recording-sdk (ralph/recording-observability).
// Always-on Silero VAD mic capture with a 5s pre-roll ring buffer.
// OSS adaptation: SDK-only globals (window.inwiseLog / window.inwiseAPI cloud
// callbacks) are swapped for console logging. The recording itself is still
// performed by the existing Badge MediaRecorder pipeline — this module only
// detects speech and exposes events the renderer wires to start/stop recording.

// Force webpack to emit vad-web assets to dist/renderer/ via the asset/resource rules in webpack.renderer.config.js.
// The worklet URL is used to derive BASE_ASSET_PATH so MicVAD finds all assets as file:// URLs.
import workletUrl from '@ricky0123/vad-web/dist/vad.worklet.bundle.min.js';
import preRollWorkletUrl from './pre-roll-worklet.js';
import '@ricky0123/vad-web/dist/silero_vad_legacy.onnx';
import '@ricky0123/vad-web/dist/silero_vad_v5.onnx';
import 'onnxruntime-web/ort-wasm-simd-threaded.wasm';
import 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm';
import 'onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm';
import 'onnxruntime-web/ort-wasm-simd-threaded.jspi.wasm';
// ORT dynamic-import()s these ESM glue modules at runtime; force-emit them too.
import 'onnxruntime-web/ort-wasm-simd-threaded.mjs';
import 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs';
import 'onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs';
import 'onnxruntime-web/ort-wasm-simd-threaded.jspi.mjs';

import { MicVAD } from '@ricky0123/vad-web';

export interface ClientAudioStats {
  avgRms: number;
  peakRms: number;
  silenceRatio: number;
  vadSpeechMs: number;
  vadSilenceMs: number;
  sampleCount: number;
  durationMs: number;
  trackMuteEventCount: number;
  trackUnmuteEventCount: number;
  trackEndedEventCount: number;
  trackEndedDuringRecording: boolean;
  preRollPrependedMs: number;
  triggerSource: 'auto' | 'manual';
}

// Directory where webpack emitted all vad-web assets.
// Stripping the filename gives the base path that MicVAD uses to build model/worklet URLs.
const BASE_ASSET_PATH = (workletUrl as string).replace(/vad\.worklet\.bundle\.min\.js$/, '');

// ---------------------------------------------------------------------------
// EventEmitter-style API
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyListener = (payload?: any) => void;

type AudioCaptureEvent =
  | 'speech-start'
  | 'speech-end'
  | 'rms-tick'
  | 'track-mute'
  | 'track-unmute'
  | 'track-ended'
  | 'track-reinit-ok'
  | 'track-reinit-failed';

const _listeners = new Map<AudioCaptureEvent, Set<AnyListener>>();

function _emit(event: 'speech-start' | 'track-mute' | 'track-unmute' | 'track-ended' | 'track-reinit-ok' | 'track-reinit-failed'): void;
function _emit(event: 'speech-end', payload: Float32Array): void;
function _emit(event: 'rms-tick', payload: { rms: number }): void;
function _emit(event: AudioCaptureEvent, payload?: unknown): void {
  const handlers = _listeners.get(event);
  if (!handlers) return;
  for (const h of handlers) h(payload);
}

export function on(event: 'speech-end', listener: (audio: Float32Array) => void): () => void;
export function on(event: 'rms-tick', listener: (data: { rms: number }) => void): () => void;
export function on(
  event: 'speech-start' | 'track-mute' | 'track-unmute' | 'track-ended' | 'track-reinit-ok' | 'track-reinit-failed',
  listener: () => void
): () => void;
export function on(event: AudioCaptureEvent, listener: AnyListener): () => void {
  if (!_listeners.has(event)) _listeners.set(event, new Set());
  _listeners.get(event)!.add(listener);
  return () => {
    _listeners.get(event)?.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// Capture state
// ---------------------------------------------------------------------------

let _stream: MediaStream | null = null;
let _ctx: AudioContext | null = null;
let _vad: MicVAD | null = null;
let _preRollNode: AudioWorkletNode | null = null;
let _rmsTimer: ReturnType<typeof setInterval> | null = null;
let _running = false;

// Track health counters
let trackMuteEventCount = 0;
let trackUnmuteEventCount = 0;
let trackEndedEventCount = 0;
let _trackEndedDuringRecording = false;
let _trackCleanups: Array<() => void> = [];

// Recording stats accumulators
let _statsStartMs = 0;
let _statsSampleCount = 0;
let _statsRmsSum = 0;
let _statsPeakRms = 0;
let _statsSilentSamples = 0;
let _statsVadSpeechMs = 0;
let _statsVadSilenceMs = 0;
let _statsVadSpeechStartMs: number | null = null;
let _statsVadSilenceStartMs: number | null = null;
let _statsTriggerSource: 'auto' | 'manual' = 'manual';
let _statsPreRollMs = 0;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function startAudioCapture(): Promise<void> {
  if (_running) return;

  // Verify that the model assets are local (file:// or relative), not fetched from a CDN.
  // In Electron renderer with webpack asset/resource, BASE_ASSET_PATH should always be file:// or relative.
  if (BASE_ASSET_PATH.startsWith('https://')) {
    console.error('[AudioCapture] asset_path_not_local', { baseAssetPath: BASE_ASSET_PATH });
    throw new Error('AudioCapture: model assets must be bundled locally, not fetched from a CDN');
  }

  _running = true;
  await _initCapture(0);
}

export async function stopAudioCapture(): Promise<void> {
  _running = false;
  await _teardown();
}

export const SILENCE_STOP_MS = 60_000;

export function getStream(): MediaStream | null {
  return _stream;
}

export function getTrackHealthStats(): {
  trackMuteEventCount: number;
  trackUnmuteEventCount: number;
  trackEndedEventCount: number;
  trackEndedDuringRecording: boolean;
} {
  return { trackMuteEventCount, trackUnmuteEventCount, trackEndedEventCount, trackEndedDuringRecording: _trackEndedDuringRecording };
}

export function snapshotPreRoll(): Promise<Float32Array> {
  if (!_preRollNode) return Promise.reject(new Error('AudioCapture not running'));
  return new Promise<Float32Array>((resolve) => {
    const port = _preRollNode!.port;
    const handler = (e: MessageEvent) => {
      if (e.data?.type !== 'snapshot') return;
      port.removeEventListener('message', handler);
      resolve(new Float32Array(e.data.buffer));
    };
    port.addEventListener('message', handler);
    port.postMessage({ type: 'snapshot' });
  });
}

export function resetRecordingStats(triggerSource: 'auto' | 'manual', preRollMs = 0): void {
  _statsStartMs = Date.now();
  _statsSampleCount = 0;
  _statsRmsSum = 0;
  _statsPeakRms = 0;
  _statsSilentSamples = 0;
  _statsVadSpeechMs = 0;
  _statsVadSilenceMs = 0;
  _statsVadSpeechStartMs = null;
  _statsVadSilenceStartMs = null;
  _statsTriggerSource = triggerSource;
  _statsPreRollMs = preRollMs;
}

export function getRecordingStats(): ClientAudioStats {
  const durationMs = Date.now() - _statsStartMs;
  const avgRms = _statsSampleCount > 0 ? _statsRmsSum / _statsSampleCount : 0;
  const silenceRatio = _statsSampleCount > 0 ? _statsSilentSamples / _statsSampleCount : 0;
  const health = getTrackHealthStats();
  return {
    avgRms,
    peakRms: _statsPeakRms,
    silenceRatio,
    vadSpeechMs: _statsVadSpeechMs,
    vadSilenceMs: _statsVadSilenceMs,
    sampleCount: _statsSampleCount,
    durationMs,
    trackMuteEventCount: health.trackMuteEventCount,
    trackUnmuteEventCount: health.trackUnmuteEventCount,
    trackEndedEventCount: health.trackEndedEventCount,
    trackEndedDuringRecording: health.trackEndedDuringRecording,
    preRollPrependedMs: _statsPreRollMs,
    triggerSource: _statsTriggerSource,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function _teardown(): Promise<void> {
  for (const cleanup of _trackCleanups) cleanup();
  _trackCleanups = [];

  if (_rmsTimer !== null) {
    clearInterval(_rmsTimer);
    _rmsTimer = null;
  }
  if (_vad) {
    await _vad.destroy();
    _vad = null;
  }
  if (_preRollNode) {
    _preRollNode.disconnect();
    _preRollNode = null;
  }
  if (_stream) {
    _stream.getTracks().forEach(t => t.stop());
    _stream = null;
  }
  if (_ctx) {
    await _ctx.close();
    _ctx = null;
  }
}

async function _initCapture(attempt: number): Promise<void> {
  if (attempt > 0) {
    console.warn('[AudioCapture] track_ended_reinit', { attempt });
  }

  _stream = await navigator.mediaDevices.getUserMedia({
    audio: { sampleRate: 16000, channelCount: 1 },
  });

  const capturedStream = _stream;
  capturedStream.getAudioTracks().forEach(track => {
    const muteHandler = () => {
      trackMuteEventCount++;
      console.warn('[AudioCapture] track_mute', { trackLabel: track.label, readyState: track.readyState });
      _emit('track-mute');
    };
    const unmuteHandler = () => {
      trackUnmuteEventCount++;
      console.warn('[AudioCapture] track_unmute', { trackLabel: track.label, readyState: track.readyState });
      _emit('track-unmute');
    };
    const endedHandler = () => {
      trackEndedEventCount++;
      console.warn('[AudioCapture] track_ended', { trackLabel: track.label, readyState: track.readyState });
      _emit('track-ended');
      if (_running) {
        _trackEndedDuringRecording = true;
        _scheduleReinit(attempt + 1);
      }
    };

    track.addEventListener('mute', muteHandler);
    track.addEventListener('unmute', unmuteHandler);
    track.addEventListener('ended', endedHandler);

    _trackCleanups.push(
      () => track.removeEventListener('mute', muteHandler),
      () => track.removeEventListener('unmute', unmuteHandler),
      () => track.removeEventListener('ended', endedHandler),
    );
  });

  _ctx = new AudioContext({ sampleRate: 16000 });
  const source = _ctx.createMediaStreamSource(capturedStream);
  const analyser = _ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);

  // Pre-roll ring buffer: 5 seconds of PCM always running in parallel with VAD.
  await _ctx.audioWorklet.addModule(preRollWorkletUrl as string);
  _preRollNode = new AudioWorkletNode(_ctx, 'pre-roll-processor');
  source.connect(_preRollNode);
  _preRollNode.port.start();

  // 10 Hz RMS tick via AnalyserNode time-domain data
  const buf = new Float32Array(analyser.fftSize);
  _rmsTimer = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    _emit('rms-tick', { rms });
    // Accumulate RMS stats
    _statsSampleCount++;
    _statsRmsSum += rms;
    if (rms > _statsPeakRms) _statsPeakRms = rms;
    if (rms < 0.01) _statsSilentSamples++;
  }, 100);

  // MicVAD reuses the same stream and AudioContext; getStream override prevents a second getUserMedia call.
  _vad = await MicVAD.new({
    audioContext: _ctx,
    baseAssetPath: BASE_ASSET_PATH,
    onnxWASMBasePath: BASE_ASSET_PATH,
    getStream: () => Promise.resolve(capturedStream),
    startOnLoad: true,
    // Tuning to suppress false triggers (vad-web defaults are very sensitive:
    // positiveSpeechThreshold 0.3 / minSpeechMs 400). Require stronger speech
    // probability and ~0.8s of sustained speech before firing speech-start, so
    // ambient noise and brief blips do not spawn unprompted recordings.
    positiveSpeechThreshold: 0.6,
    negativeSpeechThreshold: 0.4,
    minSpeechMs: 800,
    onSpeechStart: () => {
      // Accumulate silence duration up to this point
      if (_statsVadSilenceStartMs !== null) {
        _statsVadSilenceMs += Date.now() - _statsVadSilenceStartMs;
        _statsVadSilenceStartMs = null;
      }
      _statsVadSpeechStartMs = Date.now();
      _emit('speech-start');
    },
    onSpeechEnd: audio => {
      // Accumulate speech duration
      if (_statsVadSpeechStartMs !== null) {
        _statsVadSpeechMs += Date.now() - _statsVadSpeechStartMs;
        _statsVadSpeechStartMs = null;
      }
      _statsVadSilenceStartMs = Date.now();
      _emit('speech-end', audio);
    },
  });
}

// Wait 5 s then attempt one new getUserMedia call, tearing down the old capture first.
function _scheduleReinit(attempt: number): void {
  setTimeout(async () => {
    if (!_running) return;
    await _teardown();
    try {
      await _initCapture(attempt);
      _emit('track-reinit-ok');
    } catch (err) {
      console.warn('[AudioCapture] track_ended_reinit_failed', {
        attempt,
        error: String(err),
      });
      _emit('track-reinit-failed');
    }
  }, 5000);
}
