import * as assert from 'node:assert/strict';
import {
  classifyPendingSystemAudio,
  classifySystemAudioCapture,
  SYSTEM_AUDIO_PENDING_GRACE_MS,
} from '../src/renderer/audio-probe.ts';
import { captureSystemAudio } from '../src/renderer/system-audio.ts';

const macPermissions = { platform: 'darwin', microphone: 'granted', screen: 'granted' };

assert.equal(classifySystemAudioCapture(false, 0, macPermissions), 'missing');
assert.equal(classifySystemAudioCapture(true, 0.01, macPermissions), 'ok');
assert.equal(classifySystemAudioCapture(true, 0, macPermissions), 'pending');
assert.equal(classifySystemAudioCapture(true, 0, { ...macPermissions, screen: 'not-determined' }), 'pending');
assert.equal(classifySystemAudioCapture(true, 0, { ...macPermissions, screen: 'denied' }), 'missing');
assert.equal(classifySystemAudioCapture(true, 0, { ...macPermissions, screen: 'restricted' }), 'missing');
assert.equal(
  classifySystemAudioCapture(true, 0, { platform: 'win32', microphone: 'unknown', screen: 'unknown' }),
  'missing',
);
assert.equal(classifyPendingSystemAudio(0, SYSTEM_AUDIO_PENDING_GRACE_MS - 1), 'pending');
assert.equal(classifyPendingSystemAudio(0, SYSTEM_AUDIO_PENDING_GRACE_MS), 'missing');
assert.equal(classifyPendingSystemAudio(0.01, SYSTEM_AUDIO_PENDING_GRACE_MS), 'ok');

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
try {
  let videoStopped = false;
  const audioTrack = { stop: () => undefined };
  const videoTrack = { stop: () => { videoStopped = true; } };
  const healthyStream = {
    getAudioTracks: () => [audioTrack],
    getVideoTracks: () => [videoTrack],
    getTracks: () => [audioTrack, videoTrack],
  };

  let requestedConstraints: any;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getDisplayMedia: async (constraints: any) => {
          requestedConstraints = constraints;
          return healthyStream;
        },
      },
    },
  });

  const captured = await captureSystemAudio();
  assert.equal(captured, healthyStream);
  assert.equal(requestedConstraints.audio, true);
  assert.equal(requestedConstraints.video.frameRate.max, 1);
  assert.equal(videoStopped, true, 'display video is discarded immediately');

  let allTracksStopped = 0;
  const silentStream = {
    getAudioTracks: () => [],
    getVideoTracks: () => [],
    getTracks: () => [{ stop: () => { allTracksStopped += 1; } }],
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getDisplayMedia: async () => silentStream } },
  });
  await assert.rejects(() => captureSystemAudio(), /without a system-audio track/);
  assert.equal(allTracksStopped, 1);
} finally {
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else delete (globalThis as any).navigator;
}

console.log('renderer-platform: all tests passed');
