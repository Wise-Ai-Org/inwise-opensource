/**
 * Capture desktop audio through Electron's display-media handler. The main
 * process selects the screen and supplies the OS loopback stream, so recording
 * code stays identical on Windows, Intel Mac, and Apple Silicon Mac.
 */
export async function captureSystemAudio(): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    audio: true,
    video: {
      width: { ideal: 1 },
      height: { ideal: 1 },
      frameRate: { ideal: 1, max: 1 },
    },
  });

  // Video is required by Chromium to initiate display capture, but Inwise never
  // records it. Stop it immediately and retain only the system-audio track.
  stream.getVideoTracks().forEach(track => track.stop());
  if (stream.getAudioTracks().length === 0) {
    stream.getTracks().forEach(track => track.stop());
    throw new Error('Desktop capture started without a system-audio track');
  }
  return stream;
}
