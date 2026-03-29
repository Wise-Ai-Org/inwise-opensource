import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('inwiseAPI', {
  // Config
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (updates: Record<string, any>) => ipcRenderer.invoke('config:set', updates),

  // Calendar
  testCalendarUrl: (url: string) => ipcRenderer.invoke('calendar:testUrl', url),
  getCalendarEvents: () => ipcRenderer.invoke('calendar:getEvents'),

  // Meetings
  getMeetings: () => ipcRenderer.invoke('db:getMeetings'),
  getMeeting: (id: string) => ipcRenderer.invoke('db:getMeeting', id),
  deleteMeeting: (id: string) => ipcRenderer.invoke('db:deleteMeeting', id),

  // Tasks
  getTasks: () => ipcRenderer.invoke('db:getTasks'),
  createTask: (data: any) => ipcRenderer.invoke('db:createTask', data),
  updateTask: (id: string, updates: any) => ipcRenderer.invoke('db:updateTask', id, updates),
  deleteTask: (id: string) => ipcRenderer.invoke('db:deleteTask', id),

  // People
  getPeople: () => ipcRenderer.invoke('db:getPeople'),

  // Recording (manual)
  startRecording: (title: string) => ipcRenderer.invoke('recording:start', title),
  stopRecording: () => ipcRenderer.invoke('recording:stop'),

  // Shell
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),

  // Events from main → renderer
  on: (channel: string, cb: (...args: any[]) => void) => {
    const allowed = ['recording:status', 'meeting:new', 'badge:show', 'badge:hide', 'calendar:events'];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_event, ...args) => cb(...args));
    }
  },
  off: (channel: string, cb: (...args: any[]) => void) => {
    ipcRenderer.removeListener(channel, cb);
  },
});
