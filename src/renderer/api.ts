/**
 * Desktop API adapter layer
 *
 * Maps web-style API calls to Electron IPC calls so ported web components
 * work with minimal changes. Web components call fetch(URL, body); desktop
 * components call api.methodName(args) which delegates to inwiseAPI via IPC.
 *
 * Also exports dummy URL constants matching wiseai-web/src/config/api.ts so
 * that imports don't break even though these URLs are never fetched on desktop.
 */

const inwiseAPI = (window as any).inwiseAPI;

// ---------------------------------------------------------------------------
// Typed api object — every method from preload.ts
// ---------------------------------------------------------------------------

export const api = {
  // ── Config ───────────────────────────────────────────────────────────────
  getConfig: () => inwiseAPI.getConfig(),
  setConfig: (updates: Record<string, any>) => inwiseAPI.setConfig(updates),

  // ── Calendar ─────────────────────────────────────────────────────────────
  testCalendarUrl: (url: string) => inwiseAPI.testCalendarUrl(url),
  getCalendarEvents: () => inwiseAPI.getCalendarEvents(),
  getCalendarHealth: () => inwiseAPI.getCalendarHealth(),

  // ── Meetings ─────────────────────────────────────────────────────────────
  getMeetings: () => inwiseAPI.getMeetings(),
  getMeeting: (id: string) => inwiseAPI.getMeeting(id),
  deleteMeeting: (id: string) => inwiseAPI.deleteMeeting(id),
  createMeetingFromTranscript: (data: any) => inwiseAPI.createMeetingFromTranscript(data),
  reviewMeeting: (id: string) => inwiseAPI.reviewMeeting(id),

  // ── Tasks ────────────────────────────────────────────────────────────────
  getTasks: () => inwiseAPI.getTasks(),
  createTask: (data: any) => inwiseAPI.createTask(data),
  updateTask: (id: string, updates: any) => inwiseAPI.updateTask(id, updates),
  deleteTask: (id: string) => inwiseAPI.deleteTask(id),

  // ── Snoozed Tasks (US-006) ───────────────────────────────────────────────
  getSnoozedTasks: () => inwiseAPI.getSnoozedTasks(),
  snoozeTask: (id: string, reason: string) => inwiseAPI.snoozeTask(id, reason),
  bringBackTask: (id: string) => inwiseAPI.bringBackTask(id),
  bringBackAllTasks: () => inwiseAPI.bringBackAllTasks(),

  // ── Likely-done task confirmation (US-007) ───────────────────────────────
  confirmLikelyDone: (id: string) => inwiseAPI.confirmLikelyDone(id),
  rejectLikelyDone: (id: string) => inwiseAPI.rejectLikelyDone(id),

  // ── People ───────────────────────────────────────────────────────────────
  getPeople: (search?: string) => inwiseAPI.getPeople(search),
  getArchivedPeople: () => inwiseAPI.getArchivedPeople(),
  getPerson: (id: string) => inwiseAPI.getPerson(id),
  addPerson: (data: any) => inwiseAPI.addPerson(data),
  addTrackedPeople: (names: string[]) => inwiseAPI.addTrackedPeople(names),
  archivePerson: (id: string) => inwiseAPI.archivePerson(id),
  unarchivePerson: (id: string) => inwiseAPI.unarchivePerson(id),
  getSuggestedPeople: () => inwiseAPI.getSuggestedPeople(),

  // ── Briefing + Task Scoring ──────────────────────────────────────────────
  getBriefing: () => inwiseAPI.getBriefing(),
  getScoredTasks: () => inwiseAPI.getScoredTasks(),

  // ── Voice Prints ─────────────────────────────────────────────────────────
  saveVoicePrint: (data: { name: string; audioClip: Buffer; isUser: boolean }) =>
    inwiseAPI.saveVoicePrint(data),
  getVoicePrints: () => inwiseAPI.getVoicePrints(),
  deleteVoicePrint: (id: string) => inwiseAPI.deleteVoicePrint(id),
  getUserVoicePrint: () => inwiseAPI.getUserVoicePrint(),

  // ── Jira ─────────────────────────────────────────────────────────────────
  jiraConnect: () => inwiseAPI.jiraConnect(),
  jiraDisconnect: () => inwiseAPI.jiraDisconnect(),
  jiraStatus: () => inwiseAPI.jiraStatus(),
  jiraGetProjects: () => inwiseAPI.jiraGetProjects(),
  jiraGetStories: (projectKey?: string) => inwiseAPI.jiraGetStories(projectKey),
  jiraCreateIssue: (task: any) => inwiseAPI.jiraCreateIssue(task),
  jiraUpdateIssue: (issueKey: string, updates: any) => inwiseAPI.jiraUpdateIssue(issueKey, updates),
  jiraTransition: (issueKey: string, status: string) => inwiseAPI.jiraTransition(issueKey, status),
  jiraAddComment: (issueKey: string, comment: string, meetingTitle?: string) =>
    inwiseAPI.jiraAddComment(issueKey, comment, meetingTitle),
  jiraLinkTask: (taskId: string, jiraKey: string, jiraUrl: string) =>
    inwiseAPI.jiraLinkTask(taskId, jiraKey, jiraUrl),
  jiraMatchTasks: (items: any[], projectKey?: string) => inwiseAPI.jiraMatchTasks(items, projectKey),

  // ── Desktop Capture ──────────────────────────────────────────────────────
  getDesktopSourceId: () => inwiseAPI.getDesktopSourceId(),

  // ── AI Features ──────────────────────────────────────────────────────────
  generatePersonInsights: (personId: string) => inwiseAPI.generatePersonInsights(personId),
  generateAgenda: (personId: string) => inwiseAPI.generateAgenda(personId),
  generateMeetingAgenda: (title: string, attendees: string[]) =>
    inwiseAPI.generateMeetingAgenda(title, attendees),
  searchMeetings: (query: string) => inwiseAPI.searchMeetings(query),
  suggestTaskFields: (data: { title: string; modalType: string; context?: any }) =>
    inwiseAPI.suggestTaskFields(data),

  // ── Recording (manual) ──────────────────────────────────────────────────
  startRecording: (title: string) => inwiseAPI.startRecording(title),
  stopRecording: () => inwiseAPI.stopRecording(),

  // ── Whisper Setup ────────────────────────────────────────────────────────
  setupWhisper: (model: string) => inwiseAPI.setupWhisper(model),

  // ── Mic Test ─────────────────────────────────────────────────────────────
  testMic: (buffer: Buffer) => inwiseAPI.testMic(buffer),

  // ── Shell ────────────────────────────────────────────────────────────────
  openExternal: (url: string) => inwiseAPI.openExternal(url),

  // ── Event Listeners (main -> renderer) ───────────────────────────────────
  on: (channel: string, callback: (...args: any[]) => void) =>
    inwiseAPI.on?.(channel, callback),
  off: (channel: string, callback: (...args: any[]) => void) =>
    inwiseAPI.off?.(channel, callback),
};

// ---------------------------------------------------------------------------
// Hook — thin wrapper for components that prefer a hook import
// ---------------------------------------------------------------------------

export function useDesktopAPI() {
  return api;
}

// ---------------------------------------------------------------------------
// Dummy URL constants — match every export from wiseai-web/src/config/api.ts
// so web component imports don't break on desktop (URLs are never fetched).
// ---------------------------------------------------------------------------

const DESKTOP = 'desktop://local';

export const APPWISE_BASE_URL = DESKTOP;
export const INWISE_BASE_URL = DESKTOP;

// Appwise functions
export const GET_EXECUTIVE_SUMMARY_URL = DESKTOP;
export const GET_WHAT_NEEDS_ATTENTION_URL = DESKTOP;
export const LOGIN_TOKEN_VALIDATE_URL = DESKTOP;
export const PARSING_GET_LAST_URL = DESKTOP;
export const INSIGHT_FEEDBACK_URL = DESKTOP;
export const LOGIN_SALESFORCE_CODE_URL = DESKTOP;
export const LOGIN_ZOOM_CODE_URL = DESKTOP;
export const LOGIN_JIRA_CODE_URL = DESKTOP;
export const LOGIN_GITHUB_CODE_URL = DESKTOP;
export const GET_USER_ONE_URL = DESKTOP;
export const ZOOM_REMOVE_CREDENTIAL_URL = DESKTOP;
export const GET_APIDECK_CONSUMER_URL = DESKTOP;
export const EDIT_CUSTOM_PROMPT_URL = DESKTOP;
export const EDIT_USER_QUOTA_URL = DESKTOP;
export const GET_MEETING_NOT_ASSIGNED_URL = DESKTOP;
export const GET_DEAL_LIST_URL = DESKTOP;
export const EDIT_STAGE_SETTINGS_URL = DESKTOP;
export const GET_PROSPECT_LIST_URL = DESKTOP;
export const GET_PROSPECT_ONE_URL = DESKTOP;
export const EDIT_DEAL_START_ARCHIVE_URL = DESKTOP;
export const SET_DEAL_SEEN_URL = DESKTOP;
export const SEARCH_CORESIGNAL_URL = DESKTOP;
export const GET_MEETING_LIST_URL = DESKTOP;
export const ASSIGNMEETINGTODEAL_URL = DESKTOP;
export const EDITDEALCARD_URL = DESKTOP;
export const EDIT_ACTION_ITEM_URL = DESKTOP;
export const CREATE_AI_FROM_RAI_URL = DESKTOP;
export const TOGGLE_RECALL_SCHEDULE_URL = DESKTOP;
export const SET_MEETING_SEEN_URL = DESKTOP;
export const GET_ACTIONITEMS_LIST_URL = DESKTOP;
export const GET_DEAL_ONE_URL = DESKTOP;
export const EDIT_DEAL_OWNER_URL = DESKTOP;
export const GET_COLLECTION_ONE_URL = DESKTOP;
export const GET_COLLECTION_FILTER_URL = DESKTOP;
export const HANDLE_CONTACT_CTA_URL = DESKTOP;
export const LOGIN_USER_AUTHENTICATION_URL = DESKTOP;
export const LOGIN_GOOGLE_CODE_URL = DESKTOP;
export const LOGIN_MICROSOFT_CODE_URL = DESKTOP;
export const LOGIN_MICROSOFT_AUTHENTICATION_URL = DESKTOP;
export const GET_MEETING_ONE_URL = DESKTOP;
export const GET_JIRA_STORIES_URL = DESKTOP;
export const MAP_CONVERSATION_TO_JIRA_URL = DESKTOP;
export const LINK_TASK_TO_JIRA_STORY_URL = DESKTOP;
export const PUSH_TASK_TO_JIRA_URL = DESKTOP;
export const CREATE_TASK_URL = DESKTOP;
export const GET_CONVERSATION_MAPPINGS_URL = DESKTOP;
export const UPDATE_CONVERSATION_MAPPING_URL = DESKTOP;
export const CREATE_BLOCKER_URL = DESKTOP;
export const CREATE_COMMUNICATION_INSIGHT_URL = DESKTOP;
export const GET_COMMUNICATION_INSIGHT_URL = DESKTOP;
export const CREATE_MEETING_URL = DESKTOP;
export const SYNC_JIRA_TASKS_URL = DESKTOP;
export const FIND_SIMILAR_TASKS_URL = DESKTOP;
export const DELETE_MEETING_URL = DESKTOP;
export const ADD_PERSON_URL = DESKTOP;

// Inwise node functions
export const GET_BLOB_STORAGE_SAS_URL = DESKTOP;
export const TRANSCRIBE_VOICE_NOTE_URL = DESKTOP;
export const GET_TRANSCRIPTION_STATUS_URL = DESKTOP;
export const PARSING_DEAL_PARSING_VOICENOTE_URL = DESKTOP;
export const ORCHESTRATORS_URL = DESKTOP;
export const INTEGRATE_CALENDAR_SERVICE_URL = DESKTOP;
export const UPDATEUSERDETAILS_URL = DESKTOP;
export const USER_DELETE_ACCOUNT_URL = DESKTOP;
export const PDL_ENRICHMENT_SEARCH_URL = DESKTOP;
export const GENERATE_PRODUCT_PROFILE_URL = DESKTOP;
export const GET_PRODUCT_LIST_URL = DESKTOP;
export const CREATE_DEAL_TEST_2_URL = DESKTOP;
export const PROSPECT_CREATE_URL = DESKTOP;
export const GENERATE_PROSPECT_SUMMARIZE_URL = DESKTOP;
export const GENERATE_PROSPECT_CLASSIFICATION_URL = DESKTOP;
export const COMPANY_SUMMARIZE_URL = DESKTOP;
export const GENERATE_POST_MEETING_EMAIL_URL = DESKTOP;
export const GENERATE_TRANSCRIPT_SUMMARIZE_URL = DESKTOP;
export const GENERATE_MEETING_ACTION_ITEMS_URL = DESKTOP;
export const ASSIGN_MEETING_TO_DEAL_URL = DESKTOP;
export const ORCHESTRATION_APIDECK_PULL_URL = DESKTOP;
export const CREATE_DEAL_ORCHESTRATION_URL = DESKTOP;
export const CRM_PUSH_ORCHESTRATION_SF_URL = DESKTOP;
export const CRM_PUSH_ORCHESTRATION_HS_URL = DESKTOP;
export const POST_MEETING_ORCHESTRATION_URL = DESKTOP;
export const DISTILL_UPDATES_URL = DESKTOP;
export const SEMANTIC_MATCH_STORIES_URL = DESKTOP;
export const GENERATE_AGENDA_URL = DESKTOP;

// Parsing / confidence / scoring
export const GET_PARSING_DASHBOARD_URL = DESKTOP;
export const SAVE_REVIEW_EDITS_URL = DESKTOP;
export const CALIBRATE_CONFIDENCE_URL = DESKTOP;
export const SUGGEST_MODAL_FIELDS_URL = DESKTOP;
export const PROCESS_TEAM_MEMBER_PARSING_URL = DESKTOP;
export const PROCESS_PROJECT_PARSING_URL = DESKTOP;
export const PROCESS_PRODUCT_PARSING_URL = DESKTOP;
export const SCORE_TASKS_URL = DESKTOP;
export const ADD_JIRA_COMMENT_URL = DESKTOP;
export const GET_SUGGESTED_PEOPLE_URL = DESKTOP;
export const ADD_TRACKED_PEOPLE_URL = DESKTOP;

// Teams / People
export const GET_TEAM_DETAIL_URL = DESKTOP;
export const UPDATE_TEAM_INSIGHTS_URL = DESKTOP;
export const GENERATE_TEAM_OVERVIEW_URL = DESKTOP;
export const UPDATE_PERSON_PROFILE_URL = DESKTOP;
export const GENERATE_PERSON_INSIGHTS_URL = DESKTOP;
export const UPDATE_INSIGHT_ACTION_ITEM_URL = DESKTOP;
export const GET_USER_LIST_URL = DESKTOP;
export const CREATE_TEAM_URL = DESKTOP;
export const ARCHIVE_TEAM_URL = DESKTOP;
export const UNARCHIVE_TEAM_URL = DESKTOP;
export const ARCHIVE_PERSON_URL = DESKTOP;
export const UNARCHIVE_PERSON_URL = DESKTOP;

// Communication parsing
export const PARSE_COMMUNICATION_URL = DESKTOP;

// Fabric — user-created projects
export const CREATE_USER_PROJECT_URL = DESKTOP;
export const GET_USER_PROJECTS_URL = DESKTOP;
export const GET_PROJECT_ACTION_ITEMS_URL = DESKTOP;
export const GET_PROJECT_PENDING_URL = DESKTOP;
export const GENERATE_PROJECT_INSIGHTS_URL = DESKTOP;
export const ANALYZE_PROJECT_DESCRIPTION_URL = DESKTOP;
export const SUGGEST_PROJECT_ROLES_URL = DESKTOP;
export const ENRICH_TASK_DEFINITION_URL = DESKTOP;
export const DELETE_EPIC_URL = DESKTOP;
export const DELETE_TEAM_URL = DESKTOP;
export const DELETE_OKR_URL = DESKTOP;
export const GET_COMMUNICATION_COUNT_URL = DESKTOP;
export const GET_EPIC_LIST_URL = DESKTOP;
export const GET_OKR_LIST_URL = DESKTOP;
export const ESTIMATE_TASK_URL = DESKTOP;
