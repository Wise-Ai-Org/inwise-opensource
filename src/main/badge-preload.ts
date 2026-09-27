import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('inwiseAPI', {
  on: (channel: string, cb: (...args: any[]) => void) => {
    const allowed = [
      'recording:start',
      'recording:status',
      'recording:stop-request',
      'recording:silence-prompt',
      'recording:silence-resolved',
      'reminder:start',
      'pill:switch-mic',
      'pipeline:secondary',
    ];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_event, ...args) => cb(...args));
    }
  },
  off: (channel: string, cb: (...args: any[]) => void) => {
    ipcRenderer.removeListener(channel, cb);
  },
  getConfig: () => ipcRenderer.invoke('config:get'),
  getDesktopSourceId: () => ipcRenderer.invoke('desktop:getSourceId'),
  getMediaPermissions: () => ipcRenderer.invoke('media:permissions'),
  requestMicrophonePermission: () => ipcRenderer.invoke('media:requestMicrophone'),
  openMediaSettings: (kind: 'microphone' | 'screen') => ipcRenderer.invoke('media:openSettings', kind),
  startRecording: (title: string, calendarEventId?: string, attendees?: string[]) =>
    ipcRenderer.invoke('recording:start', title, calendarEventId, attendees),
  resizePill: (width: number, height?: number) => ipcRenderer.send('pill:resize', { width, height }),
  showPillMenu: (payload: { mics: { id: string; label: string }[]; speakers: { id: string; label: string }[]; micOk?: boolean; spkOk?: boolean; recording: boolean; status?: string; title?: string; meetingId?: string }) => {
    ipcRenderer.send('pill:context-menu', payload);
  },
  openInwise: (meetingId?: string) => ipcRenderer.send('pill:open-inwise', meetingId),
  beginPillDrag: () => ipcRenderer.send('pill:drag-start'),
  movePill: () => ipcRenderer.send('pill:drag-move'),
  endPillDrag: () => ipcRenderer.send('pill:drag-end'),
  pillCancelled: () => ipcRenderer.send('pill:cancelled'),
  notifyRecordingSilence: (payload: { title: string; silenceMs: number; autoStopped?: boolean }) => {
    ipcRenderer.send('recording:silence-check-in', payload);
  },
  respondRecordingSilence: (response: 'keep' | 'sound' | 'stop') => {
    ipcRenderer.send('recording:silence-response', response);
  },
});

contextBridge.exposeInMainWorld('electronAPI', {
  sendAudio: (payload: { buffer: Buffer; title: string; calendarEventId?: string; attendees?: string[]; stereo?: boolean }) => {
    // Must be send(), not invoke(): main listens with ipcMain.on, and invoke only
    // routes to ipcMain.handle — the invoke pairing silently drops the audio.
    ipcRenderer.send('recording:audio-data', payload);
  },
  sendAudioHealth: (payload: { micOk: boolean; systemAudioOk: boolean; message?: string }) => {
    ipcRenderer.send('audio:health', payload);
  },
  reportUnhandledRejection: (payload: { name?: string; message?: string; stack?: string; source?: string }) => {
    ipcRenderer.send('renderer:unhandled-rejection', payload);
  },
});
