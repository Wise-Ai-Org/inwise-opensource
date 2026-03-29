import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('inwiseAPI', {
  // Config
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (updates: Record<string, any>) => ipcRenderer.invoke('config:set', updates),

  // Auth
  loginGoogle: () => ipcRenderer.invoke('auth:google'),
  loginMicrosoft: () => ipcRenderer.invoke('auth:microsoft'),
  logout: (provider: string) => ipcRenderer.invoke('auth:logout', provider),

  // Meetings
  getMeetings: () => ipcRenderer.invoke('db:getMeetings'),
  getMeeting: (id: string) => ipcRenderer.invoke('db:getMeeting', id),
  deleteMeeting: (id: string) => ipcRenderer.invoke('db:deleteMeeting', id),

  // People
  getPeople: () => ipcRenderer.invoke('db:getPeople'),

  // Recording (manual)
  startRecording: (title: string) => ipcRenderer.invoke('recording:start', title),
  stopRecording: () => ipcRenderer.invoke('recording:stop'),

  // Shell
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),

  // Events from main → renderer
  on: (channel: string, cb: (...args: any[]) => void) => {
    const allowed = ['recording:status', 'meeting:new', 'badge:show', 'badge:hide'];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_event, ...args) => cb(...args));
    }
  },
  off: (channel: string, cb: (...args: any[]) => void) => {
    ipcRenderer.removeListener(channel, cb);
  },
});
