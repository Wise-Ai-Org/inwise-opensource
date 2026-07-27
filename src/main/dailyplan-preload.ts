import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('inwiseDailyPlan', {
  getPlan: () => ipcRenderer.invoke('dailyPlan:get'),
  dismiss: () => ipcRenderer.send('dailyPlan:dismiss'),
  openInwise: () => ipcRenderer.send('dailyPlan:open-inwise'),
});
