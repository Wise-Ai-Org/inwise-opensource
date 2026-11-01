/** Decode only finalized recordings. Keep the original bytes saved before calling. */
export async function decodeVoiceRecording(bytes: ArrayBuffer, preserveChannels = false): Promise<Uint8Array> {
  if (bytes.byteLength === 0) throw new Error('No audio was captured. Record for at least a second, then finish.');
  const ctx = new AudioContext({ sampleRate: 16000 });
  try {
    const decoded = await ctx.decodeAudioData(bytes.slice(0));
    if (!decoded.length) throw new Error('The recording contains no audio samples.');
    const channels = preserveChannels ? decoded.numberOfChannels : 1;
    const pcm = decoded.getChannelData(0);
    const wav = new ArrayBuffer(44 + pcm.length * channels * 2);
    const view = new DataView(wav);
    const text = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
    text(0, 'RIFF'); view.setUint32(4, wav.byteLength - 8, true);
    text(8, 'WAVE'); text(12, 'fmt '); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); view.setUint16(22, channels, true);
    view.setUint32(24, decoded.sampleRate, true); view.setUint32(28, decoded.sampleRate * channels * 2, true);
    view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
    text(36, 'data'); view.setUint32(40, pcm.length * channels * 2, true);
    for (let c = 0; c < channels; c++) {
      const samples = decoded.getChannelData(c);
      for (let i = 0; i < samples.length; i++) view.setInt16(44 + (i * channels + c) * 2, Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), true);
    }
    return new Uint8Array(wav);
  } finally { await ctx.close(); }
}

/** onstop follows the final dataavailable event; do not decode partial chunks. */
export function stopVoiceRecorder(recorder: MediaRecorder, timeoutMs = 10000): Promise<void> {
  if (recorder.state === 'inactive') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); recorder.removeEventListener('stop', stopped); recorder.removeEventListener('error', failed); };
    const stopped = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error('Audio capture was interrupted. Any captured audio will be kept for recovery.')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Audio capture did not finish. Any captured audio will be kept for recovery.')); }, timeoutMs);
    recorder.addEventListener('stop', stopped, { once: true });
    recorder.addEventListener('error', failed, { once: true });
    try { recorder.stop(); } catch (error) { cleanup(); reject(error); }
  });
}
