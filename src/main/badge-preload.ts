import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('inwiseAPI', {
  on: (channel: string, cb: (...args: any[]) => void) => {
    const allowed = ['recording:start', 'recording:status', 'recording:stop-request', 'recording:file-saved', 'recording:file-save-failed'];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_event, ...args) => cb(...args));
    }
  },
  off: (channel: string, cb: (...args: any[]) => void) => {
    ipcRenderer.removeListener(channel, cb);
  },
  getConfig: () => ipcRenderer.invoke('config:get'),
  getDesktopSourceId: () => ipcRenderer.invoke('desktop:getSourceId'),
  startRecording: (title: string) => ipcRenderer.invoke('recording:start', title),
});

contextBridge.exposeInMainWorld('electronAPI', {
  sendAudio: (payload: { buffer: Buffer; title: string; calendarEventId?: string; stereo?: boolean }) => {
    ipcRenderer.send('recording:audio-data', payload);
  },
  sendAudioHealth: (payload: { micOk: boolean; systemAudioOk: boolean; message?: string }) => {
    ipcRenderer.send('audio:health', payload);
  },
  reportUnhandledRejection: (payload: { name?: string; message?: string; stack?: string; source?: string }) => {
    ipcRenderer.send('renderer:unhandled-rejection', payload);
  },
});
