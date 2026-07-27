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
  listCalendars: () => ipcRenderer.invoke('calendar:list'),
  addCalendar: (row: { label: string; provider: 'google' | 'outlook' | 'ics'; url: string; enabled: boolean }) =>
    ipcRenderer.invoke('calendar:add', row),
  updateCalendar: (id: string, patch: Partial<{ label: string; provider: 'google' | 'outlook' | 'ics'; url: string; enabled: boolean }>) =>
    ipcRenderer.invoke('calendar:update', id, patch),
  removeCalendar: (id: string) => ipcRenderer.invoke('calendar:remove', id),
  setSelfEmails: (emails: string[]) => ipcRenderer.invoke('config:setSelfEmails', emails),
  chooseMeetingForConflict: (chosenId: string) => ipcRenderer.invoke('meeting:conflict:choose', chosenId),
  seedDemoData: () => ipcRenderer.invoke('seed:demo'),
  clearDemoData: () => ipcRenderer.invoke('seed:clear'),

  // Meetings
  getMeetings: () => ipcRenderer.invoke('db:getMeetings'),
  getMeeting: (id: string) => ipcRenderer.invoke('db:getMeeting', id),
  deleteMeeting: (id: string) => ipcRenderer.invoke('db:deleteMeeting', id),
  createMeetingFromTranscript: (data: any) => ipcRenderer.invoke('db:createMeetingFromTranscript', data),
  attachTranscriptToMeeting: (meetingId: string, content: string) =>
    ipcRenderer.invoke('db:attachTranscriptToMeeting', meetingId, content),
  reviewMeeting: (id: string) => ipcRenderer.invoke('db:reviewMeeting', id),

  // Tasks
  getTasks: () => ipcRenderer.invoke('db:getTasks'),
  createTask: (data: any) => ipcRenderer.invoke('db:createTask', data),
  updateTask: (id: string, updates: any) => ipcRenderer.invoke('db:updateTask', id, updates),
  deleteTask: (id: string) => ipcRenderer.invoke('db:deleteTask', id),

  // Snoozed tasks (US-006)
  getSnoozedTasks: () => ipcRenderer.invoke('db:getSnoozedTasks'),
  snoozeTask: (id: string, reason: string) => ipcRenderer.invoke('db:snoozeTask', id, reason),
  bringBackTask: (id: string) => ipcRenderer.invoke('db:bringBackTask', id),
  bringBackAllTasks: () => ipcRenderer.invoke('db:bringBackAllTasks'),

  // Likely-done task confirmation (US-007)
  confirmLikelyDone: (id: string) => ipcRenderer.invoke('db:confirmLikelyDone', id),
  rejectLikelyDone: (id: string) => ipcRenderer.invoke('db:rejectLikelyDone', id),

  // People
  getPeople: (search?: string) => ipcRenderer.invoke('db:getPeople', search),
  getArchivedPeople: () => ipcRenderer.invoke('db:getArchivedPeople'),
  getPerson: (id: string) => ipcRenderer.invoke('db:getPerson', id),
  addPerson: (data: any) => ipcRenderer.invoke('db:addPerson', data),
  addTrackedPeople: (names: string[]) => ipcRenderer.invoke('db:addTrackedPeople', names),
  archivePerson: (id: string) => ipcRenderer.invoke('db:archivePerson', id),
  unarchivePerson: (id: string) => ipcRenderer.invoke('db:unarchivePerson', id),
  getSuggestedPeople: () => ipcRenderer.invoke('db:getSuggestedPeople'),
  getPersonMergeCandidates: () => ipcRenderer.invoke('people:mergeCandidates'),
  mergePeople: (keepId: string, dropId: string) => ipcRenderer.invoke('people:merge', keepId, dropId),
  markNotSamePerson: (idA: string, idB: string) => ipcRenderer.invoke('people:notSame', idA, idB),

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

  // Zoom
  zoomSaveCredentials: (clientId: string, clientSecret: string) => ipcRenderer.invoke('zoom:saveCredentials', clientId, clientSecret),
  zoomConnect: () => ipcRenderer.invoke('zoom:connect'),
  zoomDisconnect: () => ipcRenderer.invoke('zoom:disconnect'),
  zoomStatus: () => ipcRenderer.invoke('zoom:status'),
  zoomTest: () => ipcRenderer.invoke('zoom:test'),
  zoomRedirectUri: () => ipcRenderer.invoke('zoom:redirectUri'),
  zoomListRecordings: () => ipcRenderer.invoke('zoom:listRecordings'),
  zoomFetchTranscript: (recording: any) => ipcRenderer.invoke('zoom:fetchTranscript', recording),

  // Local MCP server ("Connect to AI")
  mcpStatus: () => ipcRenderer.invoke('mcp:status'),
  mcpSetEnabled: (enabled: boolean) => ipcRenderer.invoke('mcp:setEnabled', enabled),
  mcpSetPort: (port: number) => ipcRenderer.invoke('mcp:setPort', port),

  // Slack
  slackConnect: (token: string) => ipcRenderer.invoke('slack:connect', token),
  slackDisconnect: () => ipcRenderer.invoke('slack:disconnect'),
  slackStatus: () => ipcRenderer.invoke('slack:status'),
  slackListChannels: () => ipcRenderer.invoke('slack:listChannels'),

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

  // SoR audit log (US-001)
  sorListRecent: (limit?: number, sinceMs?: number) => ipcRenderer.invoke('sor:listRecent', limit, sinceMs),
  sorListByMeeting: (meetingId: string) => ipcRenderer.invoke('sor:listByMeeting', meetingId),
  sorListByTaskId: (taskId: string) => ipcRenderer.invoke('sor:listByTaskId', taskId),
  sorListByTargetRecord: (system: string, recordId: string) => ipcRenderer.invoke('sor:listByTargetRecord', system, recordId),
  sorAggregateByIntegration: (sinceMs?: number) => ipcRenderer.invoke('sor:aggregateByIntegration', sinceMs),
  sorListFailed: (system: string, sinceMs: number) => ipcRenderer.invoke('sor:listFailed', system, sinceMs),
  sorRetry: (id: string) => ipcRenderer.invoke('sor:retry', id),
  sorRetryFailed: (system: string, sinceMs: number) => ipcRenderer.invoke('sor:retryFailed', system, sinceMs),

  // SoR approval gate (US-006)
  sorListPendingApprovals: () => ipcRenderer.invoke('sor:listPendingApprovals'),
  sorApprove: (id: string, overrides?: Record<string, any>) => ipcRenderer.invoke('sor:approve', id, overrides),
  sorReject: (id: string) => ipcRenderer.invoke('sor:reject', id),

  // Desktop capture
  getDesktopSourceId: () => ipcRenderer.invoke('desktop:getSourceId'),

  // Audio health (mic + system audio capture status)
  getAudioHealth: () => ipcRenderer.invoke('audio:health:get'),

  // Welcome-back (returns null when not eligible)
  welcomeBackCompute: () => ipcRenderer.invoke('welcomeBack:compute'),
  welcomeBackDismiss: () => ipcRenderer.invoke('welcomeBack:dismiss'),
  welcomeBackLiveMeeting: () => ipcRenderer.invoke('welcomeBack:liveMeeting'),
  setLoginItemOpenAtLogin: (enabled: boolean) =>
    ipcRenderer.invoke('app:setLoginItemOpenAtLogin', enabled),
  getLoginItemSettings: () => ipcRenderer.invoke('app:getLoginItemSettings'),

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
  startRecording: (title: string, calendarEventId?: string, attendees?: string[]) =>
    ipcRenderer.invoke('recording:start', title, calendarEventId, attendees),
  stopRecording: () => ipcRenderer.invoke('recording:stop'),

  // Whisper setup
  setupWhisper: (model: string) => ipcRenderer.invoke('whisper:setup', model),

  // Mic test
  testMic: (buffer: Buffer) => ipcRenderer.invoke('mic:test', buffer),

  // Voice memos
  transcribeVoiceMemo: (buffer: Uint8Array, durationSec: number) =>
    ipcRenderer.invoke('voice:transcribe', buffer, durationSec),
  classifyVoiceMemo: (transcript: string, ctx: any) =>
    ipcRenderer.invoke('voice:classify', transcript, ctx),
  applyVoiceMemo: (payload: any) => ipcRenderer.invoke('voice:applyMemo', payload),

  // Shell
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),

  // Popup window controls
  pinPopup: (pinned: boolean) => ipcRenderer.invoke('popup:pin', pinned),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  checkForUpdates: () => ipcRenderer.invoke('app:check-for-updates'),
  openReviewWindow: (meetingId: string, initialTab?: string) =>
    ipcRenderer.invoke('review-window:open', meetingId, initialTab),
  renameVoicePrint: (id: string, name: string) => ipcRenderer.invoke('voiceprint:rename', id, name),

  // Events from main → renderer
  on: (channel: string, cb: (...args: any[]) => void) => {
    const allowed = ['recording:status', 'meeting:new', 'meeting:open-details', 'badge:show', 'badge:hide', 'calendar:events', 'meeting:reminder', 'meeting:conflict', 'meeting:conflict:resolved', 'whisper:progress', 'tasks:reprioritized', 'tasks:likely-done-updated', 'jira:auto-synced', 'sor:write-completed', 'pipeline:error', 'audio:health', 'app:navigate'];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_event, ...args) => cb(...args));
    }
  },
  off: (channel: string, cb: (...args: any[]) => void) => {
    ipcRenderer.removeListener(channel, cb);
  },
});
