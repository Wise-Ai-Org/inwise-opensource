import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('inwiseAPI', {
  on: (channel: string, cb: (...args: any[]) => void) => {
    const allowed = ['recording:start', 'recording:status', 'recording:stop-request'];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_event, ...args) => cb(...args));
    }
  },
  getConfig: () => ipcRenderer.invoke('config:get'),
  getDesktopSourceId: () => ipcRenderer.invoke('desktop:getSourceId'),
  startRecording: (title: string) => ipcRenderer.invoke('recording:start', title),
});

contextBridge.exposeInMainWorld('electronAPI', {
  sendAudio: (payload: { buffer: Buffer; title: string; calendarEventId?: string; stereo?: boolean }) => {
    ipcRenderer.send('recording:audio-data', payload);
  },
});
