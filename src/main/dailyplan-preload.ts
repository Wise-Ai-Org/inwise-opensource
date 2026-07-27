import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('inwiseDailyPlan', {
  getPlan: () => ipcRenderer.invoke('dailyPlan:get'),
  dismiss: () => ipcRenderer.send('dailyPlan:dismiss'),
  openInwise: () => ipcRenderer.send('dailyPlan:open-inwise'),
  updateTask: (id: string, updates: Record<string, any>) => ipcRenderer.invoke('db:updateTask', id, updates),
  snoozeTask: (id: string, reason: string) => ipcRenderer.invoke('db:snoozeTask', id, reason),
});
