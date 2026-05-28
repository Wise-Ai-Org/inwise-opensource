import { contextBridge, ipcRenderer } from 'electron';

// Map original callbacks → wrapped IPC listeners so off() can remove the right function
const handlers = new Map<Function, (...args: any[]) => void>();

contextBridge.exposeInMainWorld('toastAPI', {
  on: (channel: string, cb: (...args: any[]) => void) => {
    const allowed = ['meeting:reminder'];
    if (!allowed.includes(channel)) return;
    const wrapper = (_event: any, ...args: any[]) => cb(...args);
    handlers.set(cb, wrapper);
    ipcRenderer.on(channel, wrapper);
  },
  off: (channel: string, cb: (...args: any[]) => void) => {
    const wrapper = handlers.get(cb);
    if (wrapper) {
      ipcRenderer.removeListener(channel, wrapper);
      handlers.delete(cb);
    }
  },
  dismiss: () => ipcRenderer.send('toast:dismiss'),
  openJoinUrl: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
});
