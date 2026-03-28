import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('inwiseAPI', {
  on: (channel: string, cb: (...args: any[]) => void) => {
    const allowed = ['recording:start', 'recording:status'];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_event, ...args) => cb(...args));
    }
  },
});

contextBridge.exposeInMainWorld('electronAPI', {
  sendAudio: (payload: { buffer: Buffer; title: string; calendarEventId?: string }) => {
    ipcRenderer.send('recording:audio-data', payload);
  },
});
