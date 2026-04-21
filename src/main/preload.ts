import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('inwiseAPI', {
  // Config
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (updates: Record<string, any>) => ipcRenderer.invoke('config:set', updates),

  // Calendar
  testCalendarUrl: (url: string) => ipcRenderer.invoke('calendar:testUrl', url),
  getCalendarEvents: () => ipcRenderer.invoke('calendar:getEvents'),
  getActiveCalendarEvent: () => ipcRenderer.invoke('calendar:active-event'),
  getCalendarHealth: () => ipcRenderer.invoke('calendar:health'),
  seedDemoData: () => ipcRenderer.invoke('seed:demo'),
  clearDemoData: () => ipcRenderer.invoke('seed:clear'),

  // Meetings
  getMeetings: () => ipcRenderer.invoke('db:getMeetings'),
  getMeeting: (id: string) => ipcRenderer.invoke('db:getMeeting', id),
  deleteMeeting: (id: string) => ipcRenderer.invoke('db:deleteMeeting', id),
  createMeetingFromTranscript: (data: any) => ipcRenderer.invoke('db:createMeetingFromTranscript', data),
  reviewMeeting: (id: string) => ipcRenderer.invoke('db:reviewMeeting', id),

  // Tasks
  getTasks: () => ipcRenderer.invoke('db:getTasks'),
  createTask: (data: any) => ipcRenderer.invoke('db:createTask', data),
  updateTask: (id: string, updates: any) => ipcRenderer.invoke('db:updateTask', id, updates),
  deleteTask: (id: string) => ipcRenderer.invoke('db:deleteTask', id),

  // People
  getPeople: (search?: string) => ipcRenderer.invoke('db:getPeople', search),
  getArchivedPeople: () => ipcRenderer.invoke('db:getArchivedPeople'),
  getPerson: (id: string) => ipcRenderer.invoke('db:getPerson', id),
  addPerson: (data: any) => ipcRenderer.invoke('db:addPerson', data),
  addTrackedPeople: (names: string[]) => ipcRenderer.invoke('db:addTrackedPeople', names),
  archivePerson: (id: string) => ipcRenderer.invoke('db:archivePerson', id),
  unarchivePerson: (id: string) => ipcRenderer.invoke('db:unarchivePerson', id),
  getSuggestedPeople: () => ipcRenderer.invoke('db:getSuggestedPeople'),

  // Briefing + Task Scoring
  getBriefing: () => ipcRenderer.invoke('briefing:get'),
  getScoredTasks: () => ipcRenderer.invoke('tasks:scored'),

  // Voice prints
  saveVoicePrint: (data: { name: string; audioClip: Buffer; isUser: boolean }) =>
    ipcRenderer.invoke('voiceprint:save', data),
  getVoicePrints: () => ipcRenderer.invoke('voiceprint:list'),
  getVoicePrintAudio: (id: string) => ipcRenderer.invoke('voiceprint:get-audio', id),
  deleteVoicePrint: (id: string) => ipcRenderer.invoke('voiceprint:delete', id),
  getUserVoicePrint: () => ipcRenderer.invoke('voiceprint:get-user'),

  // Jira
  jiraConnect: () => ipcRenderer.invoke('jira:connect'),
  jiraDisconnect: () => ipcRenderer.invoke('jira:disconnect'),
  jiraStatus: () => ipcRenderer.invoke('jira:status'),
  jiraGetProjects: () => ipcRenderer.invoke('jira:getProjects'),
  jiraGetStories: (projectKey?: string) => ipcRenderer.invoke('jira:getStories', projectKey),
  jiraCreateIssue: (task: any) => ipcRenderer.invoke('jira:createIssue', task),
  jiraUpdateIssue: (issueKey: string, updates: any) => ipcRenderer.invoke('jira:updateIssue', issueKey, updates),
  jiraTransition: (issueKey: string, status: string) => ipcRenderer.invoke('jira:transition', issueKey, status),
  jiraAddComment: (issueKey: string, comment: string, meetingTitle?: string) => ipcRenderer.invoke('jira:addComment', issueKey, comment, meetingTitle),
  jiraLinkTask: (taskId: string, jiraKey: string, jiraUrl: string) => ipcRenderer.invoke('jira:linkTask', taskId, jiraKey, jiraUrl),
  jiraMatchTasks: (items: any[], projectKey?: string) => ipcRenderer.invoke('jira:matchTasks', items, projectKey),

  // Desktop capture
  getDesktopSourceId: () => ipcRenderer.invoke('desktop:getSourceId'),

  // Audio health (mic + system audio capture status)
  getAudioHealth: () => ipcRenderer.invoke('audio:health:get'),

  // Renderer error reporting
  reportUnhandledRejection: (payload: { name?: string; message?: string; stack?: string; source?: string }) =>
    ipcRenderer.send('renderer:unhandled-rejection', payload),

  // AI features
  generatePersonInsights: (personId: string) => ipcRenderer.invoke('ai:generatePersonInsights', personId),
  generateAgenda: (personId: string) => ipcRenderer.invoke('ai:generateAgenda', personId),
  generateMeetingAgenda: (title: string, attendees: string[]) => ipcRenderer.invoke('ai:generateMeetingAgenda', title, attendees),
  // prioritizeTasks removed — replaced by signal-based scorer (tasks:scored)
  searchMeetings: (query: string) => ipcRenderer.invoke('ai:searchMeetings', query),
  suggestTaskFields: (data: { title: string; modalType: string; context?: any }) =>
    ipcRenderer.invoke('ai:suggestTaskFields', data),

  // Recording (manual)
  startRecording: (title: string, calendarEventId?: string) =>
    ipcRenderer.invoke('recording:start', title, calendarEventId),
  stopRecording: () => ipcRenderer.invoke('recording:stop'),

  // Whisper setup
  setupWhisper: (model: string) => ipcRenderer.invoke('whisper:setup', model),

  // Mic test
  testMic: (buffer: Buffer) => ipcRenderer.invoke('mic:test', buffer),

  // Shell
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),

  // Events from main → renderer
  on: (channel: string, cb: (...args: any[]) => void) => {
    const allowed = ['recording:status', 'meeting:new', 'badge:show', 'badge:hide', 'calendar:events', 'meeting:reminder', 'whisper:progress', 'tasks:reprioritized', 'jira:auto-synced', 'pipeline:error', 'audio:health'];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_event, ...args) => cb(...args));
    }
  },
  off: (channel: string, cb: (...args: any[]) => void) => {
    ipcRenderer.removeListener(channel, cb);
  },
});
