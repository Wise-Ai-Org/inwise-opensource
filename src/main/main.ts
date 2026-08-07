import { app, BrowserWindow, ipcMain, globalShortcut, Menu, shell, Notification, desktopCapturer, protocol, nativeImage, powerMonitor, screen } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { session } from 'electron';
import { installDisplayMediaHandler, installSessionPermissionHandlers } from './session-permissions';

import { getConfig, setConfig, getSorJiraPrefs, getMcpPrefs, migrateLegacyCalendars, listCalendars, addCalendar, updateCalendar, removeCalendar, setSelfEmails, markAppOpened, markWelcomeBackSeen, getDaysSinceLastOpen, getLastOpenedAtSnapshot, getWelcomeBackLastSeenAt, getDailyPlanPrefs, markDailyPlanShown, wasAutostartConfigured, markAutostartConfigured, CalendarSubscription } from './config';
import { isSelf } from './self-identity';
import { fuzzyNameScore, SAME_PERSON_THRESHOLD } from './fuzzy-name';
import { log } from './logger';
import { CalendarWatcher } from './calendar-watcher';
import { transcribeAudio, setupWhisper } from './transcriber';
import { extractInsights, searchMeetings, detectContradictions, generateAgenda, suggestTaskFields, classifyVoiceMemo, VoiceMemoItem } from './extractor';
import {
  initDatabase,
  createMeeting, updateMeetingTranscript, saveInsights, updateMeetingStatus,
  findRecentRecordingMeeting, appendMeetingTranscript,
  getMeetings, getMeeting, deleteMeeting, getAllPastDecisions, getOverdueCommitments,
  createMeetingFromTranscript,
  createVoiceMemo, createVoiceMemoTask,
  getTasks, createTask, updateTask, deleteTask,
  getSnoozedTasks, snoozeTask, bringBackTask,
  markLikelyDone, confirmLikelyDone, rejectLikelyDone,
  getPeople, getArchivedPeople, getPerson, addPerson, addTrackedPeople,
  archivePerson, unarchivePerson, getSuggestedPeople, updatePersonProfile,
  dedupePeopleByName, dedupeCalendarSyncMeetings,
  getPersonMergeCandidates, mergePeople, markNotSamePerson,
  getPersonAgendaContext, getMeetingAgendaContext,
  saveVoicePrint, getVoicePrints, getVoicePrint, deleteVoicePrint,
  getUserVoicePrint, getVoicePrintByName, getVoicePrintsWithEmbeddings,
  renameVoicePrint,
  syncCalendarEventsToDb,
  getAllTasksForDedup, getMeetingsById, appendTaskMention,
  mergeTasksManual, undoSplitMention, resolvePendingDedup,
  bumpTaskPriority, dismissTaskNudge,
} from './database';
import { decideMention, retrieveCandidates, classifyCandidates, buildMentionThread, providerModelLabel } from './task-dedup';
import { ASK_THRESHOLD, AUTO_MERGE_THRESHOLD } from './dedup-constants';
import { logMatchDecision, listMatchDecisions, getMatchDecisionStats } from './match-decision-log';
import { randomUUID } from 'crypto';
import { extractChannel, trimWav, wavBufferToSamples, stitchWavBuffers } from '@inwise/desktop-shared';
import {
  connectJira, disconnectJira, isJiraConnected, getJiraInfo,
  getJiraProjects, getJiraStories, createJiraIssue, updateJiraIssue,
  transitionJiraIssue, addJiraComment, retryJiraWrite, approveJiraWrite,
} from './jira-client';
import {
  initSorWriteLog, onWriteCompleted,
  recordWrite as sorRecordWrite,
  markCompleted as sorMarkCompleted,
  applyApprovalEdit as sorApplyApprovalEdit,
  listRecent as sorListRecent,
  listByMeeting as sorListByMeeting,
  listByTaskId as sorListByTaskId,
  listByTargetRecord as sorListByTargetRecord,
  aggregateByIntegration as sorAggregateByIntegration,
  listFailedSince as sorListFailedSince,
  listStuckEntries as sorListStuckEntries,
  getWriteEntry as sorGetWriteEntry,
  shouldGateWrite as sorShouldGateWrite,
  computeCreateDiffs as sorComputeCreateDiffs,
  PushParams as SorPushParams,
} from './sor-write-log';
import {
  initPendingApprovals, stashPending, listPending, getPending, removePending,
} from './sor-pending-approvals';
import { buildActionExecutionSummary, getActionExecution, initActionExecutionLog } from './action-execution-log';
import { matchAllItems, semanticMatch } from './jira-matcher';
import { scoreTasks } from './task-scorer';
import { computeVoiceEmbedding, identifySpeaker, SPEAKER_MATCH_THRESHOLD } from '@inwise/desktop-shared';
import { createTray, updateTrayMenu, destroyTray, getTrayBounds } from './tray';
import { sweepStaleTasks, getLastSweepResult } from './staleness-sweep';
import { computeWelcomeBack } from './welcome-back';
import {
  computeDailyPlanGate, selectTodaysMeetings, hasAgendaHistory, buildGreeting,
  DAILY_PLAN_DELAY_MS, DAILY_PLAN_RECHECK_MS,
} from './daily-plan';
import { findLiveMeetingForBanner } from './live-meeting-banner';
import { inferCompletedTaskIds } from './task-completion-inference';
import {
  saveZoomCredentials, connectZoom, disconnectZoom, getZoomStatus, testZoomConnection,
  ZOOM_REDIRECT_URI_DISPLAY,
} from './zoom-oauth';
import { listZoomRecordings, getTranscriptDownloadUrl } from './zoom-recordings';
import { downloadAndParseVtt } from './zoom-vtt-parser';
import { ingestNormalizedTranscript } from './zoom-transcript-ingestion';
import {
  connectTeams, disconnectTeams, getTeamsStatus, saveTeamsCredentials,
  testTeamsConnection, TEAMS_REDIRECT_URI_DISPLAY,
} from './teams-oauth';
import { fetchTeamsTranscriptArtifact, listTeamsMeetings } from './teams-api';
import { parseTeamsVtt } from './teams-vtt-parser';
import {
  connectMeet, disconnectMeet, getMeetStatus, saveMeetCredentials,
  testMeetConnection, MEET_REDIRECT_URI_DISPLAY,
} from './meet-oauth';
import { fetchMeetTranscript, listMeetConferenceRecords } from './meet-api';
import {
  validateToken,
  getSlackConnectionInfo,
  listChannels as slackListChannels,
  postWiserNote,
} from './slack-client';
import { connectSlackWithOAuth } from './slack-oauth';
import { normalizeSlackThread } from './slack-normalizer';
import { startSlackPoller, stopSlackPoller, registerSlackPipeline, runSlackPollNow } from './slack-poller';
import { startMcpServer, stopMcpServer, getMcpStatus, setUpcomingEventsProvider } from './mcp-server';
import { computePopupBounds } from './popup-position';
import { installApplicationMenu } from './application-menu';
import { getMediaPermissions, openMediaSettings, requestMicrophonePermission } from './media-permissions';
import { createLoginItemRegistration, shouldStartHidden } from './login-item';

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let dailyPlanWindow: BrowserWindow | null = null;
let dailyPlanTimer: NodeJS.Timeout | null = null;
// Set by the login-item registration; when launched at OS login the main
// window stays hidden and the app lives in the tray until the user opens it.
const startHidden = process.argv.includes('--hidden');
const calendarWatcher = new CalendarWatcher();
let activeRecording: { mediaRecorder?: any; chunks: Buffer[]; tmpPath?: string } | null = null;

type AudioHealth = { micOk: boolean; systemAudioOk: boolean; message?: string };
let latestAudioHealth: AudioHealth | null = null;
let isRecordingActive = false;
const AUDIO_HEALTH_NOTIFY_DEBOUNCE_MS = 60 * 1000;
let lastMicFailureNotifiedAt = 0;
let lastSysAudioFailureNotifiedAt = 0;
const RECORDING_SILENCE_NOTIFY_DEBOUNCE_MS = 60 * 1000;
let lastRecordingSilenceNotifiedAt = 0;

// Meeting conflict detection (US-006)
const MEETING_CONFLICT_WINDOW_MS = 90 * 1000;
const MEETING_CONFLICT_AUTO_SELECT_MS = 30 * 1000;
type MeetingEvent = { id: string; title: string; startTime: Date; endTime: Date; attendees: string[]; meetingLink?: string; sourceCalendarId?: string };
let lastMeetingStarting: { event: MeetingEvent; at: number } | null = null;
let pendingConflict:
  | { active: MeetingEvent; incoming: MeetingEvent; timer: NodeJS.Timeout }
  | null = null;

// â”€â”€ Windows â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Tray-popup dimensions — the main window is a slim taskbar popup, not a desktop window.
const POPUP_WIDTH = 380;
const POPUP_HEIGHT = 680;

// While an external auth flow (Zoom/Google/MS OAuth in the system browser) is in
// progress the popup must not hide on blur — the browser stealing focus IS a blur.
// Renderer sets this via popup:pin around auth flows.
let popupPinned = false;

function positionPopupWindow(win: BrowserWindow): void {
  try {
    const trayBounds = getTrayBounds();
    const display = trayBounds
      ? screen.getDisplayMatching(trayBounds)
      : screen.getPrimaryDisplay();
    win.setBounds(computePopupBounds({
      platform: process.platform,
      trayBounds,
      workArea: display.workArea,
      width: POPUP_WIDTH,
      height: POPUP_HEIGHT,
    }));
  } catch { /* positioning is best-effort; default placement is acceptable */ }
}

// Clicking the tray icon blurs the popup, which hides it — then the click event
// would immediately re-show it. Treat a tray click right after a blur-hide as
// "the user clicked to close".
let lastBlurHideAt = 0;

export function togglePopupWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (Date.now() - lastBlurHideAt < 350) return;
  if (mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
  } else {
    positionPopupWindow(mainWindow);
    mainWindow.show();
    mainWindow.focus();
  }
}

const VOICE_CAPTURE_SHORTCUT = 'Alt+,';

function openVoiceCapture(): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;

  positionPopupWindow(win);
  win.show();
  win.focus();

  const navigate = () => {
    if (!win.isDestroyed()) win.webContents.send('app:navigate', 'voice-capture');
  };
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => setTimeout(navigate, 100));
  } else {
    navigate();
  }
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: POPUP_WIDTH,
    height: POPUP_HEIGHT,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    backgroundColor: '#f8fafc',
    icon: path.join(__dirname, process.platform === 'win32' ? '../../assets/icon.ico' : '../../assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Inwise',
    show: false,
  });

  mainWindow.loadURL('app://bundle/index.html');
  // TEMP DIAG: pipe renderer console into the main log to trace VAD lifecycle.
  mainWindow.webContents.on("console-message", (...a) => {
    let msg;
    if (a.length >= 3 && typeof a[2] === "string") msg = a[2];
    else if (a[0] && typeof a[0] === "object" && "message" in a[0]) msg = a[0].message;
    else msg = a.map(String).join(" ");
    console.log("[renderer] " + msg);
  });
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }
  // Electron persists per-origin zoom; a stray Ctrl+= at any point would leave
  // the 380px popup permanently rendering oversized, clipped content. Pin it.
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.webContents.setZoomFactor(1);
    mainWindow?.webContents.setVisualZoomLevelLimits(1, 1);
  });

  mainWindow.once('ready-to-show', () => {
    markAppOpened();
    if (mainWindow) positionPopupWindow(mainWindow);
    let openedAsHidden = shouldStartHidden(process.platform, startHidden);
    if (process.platform === 'darwin') {
      try {
        openedAsHidden = shouldStartHidden(process.platform, startHidden, app.getLoginItemSettings());
      } catch { /* keep flag */ }
    }
    if (!openedAsHidden) mainWindow?.show();
  });

  mainWindow.on('show', () => {
    markAppOpened();
  });

  // Tray-popup behavior: clicking anywhere else hides the popup — unless an
  // auth flow pinned it open, or we're in development (devtools focus would
  // otherwise hide the window on every inspection).
  mainWindow.on('blur', () => {
    if (popupPinned) return;
    if (process.env.NODE_ENV === 'development') return;
    if (mainWindow?.webContents.isDevToolsFocused()) return;
    lastBlurHideAt = Date.now();
    mainWindow?.hide();
  });

  mainWindow.on('close', (e) => {
    e.preventDefault();
    mainWindow?.hide();
  });
}

// ── Transcript review window ─────────────────────────────────────────────────
// The full transcript review flow is unusable at popup width, so it opens in a
// normal resizable window — the one place the app steps outside the popup.
let reviewWindow: BrowserWindow | null = null;

function createReviewWindow(meetingId: string, initialTab?: string): void {
  if (reviewWindow && !reviewWindow.isDestroyed()) {
    reviewWindow.close();
  }
  reviewWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: '#f8fafc',
    icon: path.join(__dirname, process.platform === 'win32' ? '../../assets/icon.ico' : '../../assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Inwise — Transcript review',
    show: false,
  });
  const tab = initialTab ? `&tab=${encodeURIComponent(initialTab)}` : '';
  reviewWindow.loadURL(`app://bundle/index.html?review=${encodeURIComponent(meetingId)}${tab}`);
  reviewWindow.once('ready-to-show', () => reviewWindow?.show());
  reviewWindow.on('closed', () => { reviewWindow = null; });
}

// Recorder pill window: collapsed capsule that the renderer resizes on hover
// via 'pill:resize'. Height covers the 44px pill plus halo margin.
const PILL_WIDTH = 240;
const PILL_HEIGHT = 72;

function pillPosition(): { x: number; y: number } {
  const cfg = getConfig();
  return {
    x: typeof cfg.pillX === 'number' ? cfg.pillX : 20,
    y: typeof cfg.pillY === 'number' ? cfg.pillY : 20,
  };
}

let pillMoveTimer: NodeJS.Timeout | null = null;
function trackPillPosition(win: BrowserWindow): void {
  // 'move' (not 'moved'): on Windows 'moved' only fires when a user drag ends,
  // so programmatic moves would never persist. Debounce absorbs the drag stream.
  win.on('move', () => {
    if (pillMoveTimer) clearTimeout(pillMoveTimer);
    pillMoveTimer = setTimeout(() => {
      if (win.isDestroyed()) return;
      const [x, y] = win.getPosition();
      setConfig({ pillX: x, pillY: y });
    }, 500);
  });
}

function createPillWindow(): BrowserWindow {
  const { x, y } = pillPosition();
  const win = new BrowserWindow({
    width: PILL_WIDTH,
    height: PILL_HEIGHT,
    x,
    y,
    alwaysOnTop: true,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'badge-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Invisible to screen capture and screen shares — the pill is for the user only.
  win.setContentProtection(true);
  trackPillPosition(win);
  win.loadFile(path.join(__dirname, '../../dist/renderer/badge.html'));
  return win;
}

function createOverlayWindow(title: string, calendarEventId?: string): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('recording:start', title, calendarEventId);
    return;
  }
  overlayWindow = createPillWindow();
  overlayWindow.webContents.once('did-finish-load', () => {
    overlayWindow?.webContents.send('recording:start', title, calendarEventId);
  });
}

function createReminderBadge(title: string): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) return; // don't interrupt active recording

  const win = createPillWindow();
  win.webContents.once('did-finish-load', () => {
    // Dedicated reminder channel — 'recording:start' would run the full
    // preflight/countdown/record flow, which a reminder must never do.
    win.webContents.send('reminder:start', title);
  });

  // Auto-dismiss after 30 seconds if user doesn't interact
  setTimeout(() => { if (!win.isDestroyed()) win.close(); }, 30_000);
}

// ── Daily plan ("Wiser planned your day") ────────────────────────────────────

const DAILY_PLAN_WIDTH = 400;
const DAILY_PLAN_HEIGHT = 660;

function createDailyPlanWindow(): void {
  if (dailyPlanWindow && !dailyPlanWindow.isDestroyed()) {
    dailyPlanWindow.show();
    dailyPlanWindow.focus();
    return;
  }
  const workArea = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({
    width: DAILY_PLAN_WIDTH,
    height: DAILY_PLAN_HEIGHT,
    x: workArea.x + workArea.width - DAILY_PLAN_WIDTH - 16,
    y: workArea.y + workArea.height - DAILY_PLAN_HEIGHT - 16,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'dailyplan-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '../../dist/renderer/dailyplan.html'));
  win.once('ready-to-show', () => {
    win.show();
    // On top just long enough to be noticed, then behave like a normal window.
    setTimeout(() => { if (!win.isDestroyed()) win.setAlwaysOnTop(false); }, 4_000);
  });
  win.on('closed', () => { dailyPlanWindow = null; });
  dailyPlanWindow = win;
}

/** In a meeting right now? Recording, overlay pill up, or a live calendar event. */
function dailyPlanBusyNow(): boolean {
  if (isRecordingActive) return true;
  if (overlayWindow && !overlayWindow.isDestroyed()) return true;
  return findLiveMeetingForBanner({
    events: calendarWatcher.getUpcomingEvents(),
    now: new Date(),
    isRecordingActive: false,
    overlayWindowOpen: false,
  }) !== null;
}

function scheduleDailyPlan(delayMs: number): void {
  const prefs = getDailyPlanPrefs();
  const gate = computeDailyPlanGate({
    now: new Date(),
    enabled: prefs.enabled,
    lastShownAt: prefs.lastShownAt,
    liveMeeting: false,
  });
  if (gate !== 'show') return;
  if (dailyPlanTimer) clearTimeout(dailyPlanTimer);
  dailyPlanTimer = setTimeout(() => tryShowDailyPlan(), delayMs);
  log('info', 'daily-plan', `Scheduled in ${Math.round(delayMs / 60_000)} min`);
}

function tryShowDailyPlan(force = false): void {
  dailyPlanTimer = null;
  if (!force) {
    const prefs = getDailyPlanPrefs();
    const gate = computeDailyPlanGate({
      now: new Date(),
      enabled: prefs.enabled,
      lastShownAt: prefs.lastShownAt,
      liveMeeting: dailyPlanBusyNow(),
    });
    if (gate === 'disabled' || gate === 'already-shown') return;
    if (gate === 'defer') {
      log('info', 'daily-plan', 'Meeting in progress — deferring until it ends');
      dailyPlanTimer = setTimeout(() => tryShowDailyPlan(), DAILY_PLAN_RECHECK_MS);
      return;
    }
  }
  createDailyPlanWindow();
  markDailyPlanShown();
}

/**
 * First-run default: register the app to start at OS login (hidden, tray only).
 * Runs once — after that the Settings toggle owns the login item. Skipped in
 * dev so `electron .` runs never register electron.exe as a login item.
 */
function applyAutostartDefault(): void {
  if (wasAutostartConfigured() || !app.isPackaged) return;
  try {
    app.setLoginItemSettings(createLoginItemRegistration(process.platform, true));
    log('info', 'login-item', 'Autostart enabled by default (first run)');
  } catch (err) {
    log('error', 'login-item', `Default autostart failed: ${String(err)}`);
  }
  markAutostartConfigured();
}

// Transcriptions of finished recordings run as background jobs; the pill shows
// them in a secondary slot so a new recording is never interrupted by an old
// meeting's pipeline status.
let activePipelineJobs = 0;
function emitSecondary(msg: { jobId: string; title: string; state: 'transcribing' | 'processing' | 'done' | 'error'; message?: string }) {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('pipeline:secondary', msg);
  }
}

// The pill lives from first recording start until the last queued transcription
// drains — never close it mid-job.
function maybeCloseOverlay(delayMs = 2500): void {
  setTimeout(() => {
    if (isRecordingActive) return;
    if (activePipelineJobs > 0 || pendingAudio.size > 0) return;
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
    overlayWindow = null;
  }, delayMs);
}

// â”€â”€ Voice auto-enrollment â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function replaceSpeakerLabels(transcript: string, attendees: string[]): Promise<string> {
  const config = getConfig();
  const userName = config.userName?.trim();

  // Build speaker name map
  // Whisper diarization with stereo uses: [SPEAKER_0] = left channel (mic/user), [SPEAKER_1] = right channel (system/others)
  // Also handles variations: (SPEAKER_0), SPEAKER 0, [SPEAKER 0], speaker0, etc.
  const speakerMap: Record<string, string> = {};

  // Speaker 0 = user (mic channel)
  if (userName) {
    speakerMap['0'] = userName;
  }

  // Speaker 1 = other participant(s)
  const otherAttendees = attendees.filter(a => !isSelf(a));

  if (otherAttendees.length === 1) {
    // 1:1 â€” we know exactly who speaker 1 is
    speakerMap['1'] = otherAttendees[0];
  } else if (otherAttendees.length > 1) {
    // Group â€” try to identify via voice prints, otherwise use "Others"
    // For now, label as the group. MFCC per-segment matching is a future enhancement.
    speakerMap['1'] = 'Others';
  }

  if (Object.keys(speakerMap).length === 0) {
    return transcript;
  }

  // Replace all speaker label patterns
  // Whisper.cpp -di outputs: [SPEAKER_0], [SPEAKER_1], etc.
  // Also handle: (SPEAKER_0), SPEAKER_0:, [SPEAKER 0], speaker 0, etc.
  const replaced = transcript.replace(
    /[\[(]?SPEAKER[_\s]?(\d+)[\])]?:?/gi,
    (match, num) => {
      const name = speakerMap[num];
      if (name) return `${name}:`;
      return match;
    }
  );

  const replacementCount = (transcript.match(/SPEAKER[_\s]?\d+/gi) || []).length;
  if (replacementCount > 0) {
    log('info', 'pipeline:label-replace', `replaced ${replacementCount} speaker labels (${Object.entries(speakerMap).map(([k, v]) => `${k}â†’${v}`).join(', ')})`);
  }

  return replaced;
}

function computeEmbeddingFromWav(wavBuffer: Buffer): number[] | null {
  try {
    const samples = wavBufferToSamples(wavBuffer);
    const emb = computeVoiceEmbedding(samples, 16000);
    return Array.from(emb);
  } catch {
    return null;
  }
}

async function autoEnrollVoices(audioPath: string, attendees: string[]): Promise<void> {
  const config = getConfig();
  const userName = config.userName?.trim();
  if (!userName) {
    log('info', 'voice-enroll:skip', 'no userName configured');
    return;
  }

  // Filter out the user from attendees
  const otherAttendees = attendees.filter(a => !isSelf(a));

  if (otherAttendees.length === 0) {
    log('info', 'voice-enroll:skip', 'no other attendees');
    return;
  }

  // Extract right channel (system audio = other participants), trim to 60s
  let rightChannelClip: Buffer;
  try {
    const rightChannel = extractChannel(audioPath, 1);
    rightChannelClip = trimWav(rightChannel, 60);
  } catch (e: any) {
    log('error', 'voice-enroll:extract-failed', e.message);
    return;
  }

  // Compute embedding for this clip
  const clipEmbedding = computeEmbeddingFromWav(rightChannelClip);

  // Check which attendees already have voice prints — fuzzy name match so
  // "Zee" and "Zeeshan Khan" resolve to the same enrolled voice.
  const allPrints = await getVoicePrints();
  const enrolled: string[] = [];
  const unenrolled: string[] = [];
  for (const name of otherAttendees) {
    const existing = await getVoicePrintByName(name)
      || (allPrints as any[]).find(p => !p.isUser && fuzzyNameScore(p.name, name) >= SAME_PERSON_THRESHOLD);
    if (existing) enrolled.push(name);
    else unenrolled.push(name);
  }

  log('info', 'voice-enroll:status', `attendees=${otherAttendees.length} enrolled=${enrolled.length} unenrolled=${unenrolled.length}`);

  // Tier 1: 1:1 meeting â€” only one other person, auto-enroll them
  if (otherAttendees.length === 1 && unenrolled.length === 1) {
    const name = unenrolled[0];
    await saveVoicePrint({ name, audioClip: rightChannelClip, isUser: false, embedding: clipEmbedding || undefined });
    log('info', 'voice-enroll:auto', `enrolled "${name}" from 1:1 recording`);
    return;
  }

  // Tier 2: Group call, all but one attendee already enrolled â€” enroll by elimination
  if (unenrolled.length === 1) {
    const name = unenrolled[0];
    await saveVoicePrint({ name, audioClip: rightChannelClip, isUser: false, embedding: clipEmbedding || undefined });
    log('info', 'voice-enroll:elimination', `enrolled "${name}" by elimination (${enrolled.length} already enrolled)`);
    return;
  }

  // Tier 3: Multiple unknowns â€” try MFCC matching against stored voice prints
  if (unenrolled.length > 1 && clipEmbedding) {
    const storedPrints = await getVoicePrintsWithEmbeddings();
    // Only match against non-user prints that have embeddings
    const candidates = storedPrints.filter((p: any) => !p.isUser && p.embedding);

    if (candidates.length > 0) {
      const samples = wavBufferToSamples(rightChannelClip);
      const matches = identifySpeaker(samples, 16000, candidates);
      const bestMatch = matches[0];

      if (bestMatch && bestMatch.similarity >= SPEAKER_MATCH_THRESHOLD) {
        // We recognized one of the speakers â€” mark them as identified
        log('info', 'voice-enroll:mfcc-match', `matched "${bestMatch.name}" with similarity ${bestMatch.similarity.toFixed(3)}`);

        // Remove the matched person from unenrolled list
        const remainingUnenrolled = unenrolled.filter(
          n => !n.toLowerCase().includes(bestMatch.name.toLowerCase()) &&
               !bestMatch.name.toLowerCase().includes(n.toLowerCase())
        );

        // If only one unknown remains after MFCC match, enroll by elimination
        if (remainingUnenrolled.length === 1) {
          const name = remainingUnenrolled[0];
          await saveVoicePrint({ name, audioClip: rightChannelClip, isUser: false, embedding: clipEmbedding });
          log('info', 'voice-enroll:mfcc-elimination', `enrolled "${name}" by MFCC-assisted elimination`);
          return;
        }
      } else {
        log('info', 'voice-enroll:mfcc-no-match', `best similarity ${bestMatch?.similarity.toFixed(3) ?? 'n/a'} below threshold ${SPEAKER_MATCH_THRESHOLD}`);
      }
    }

    // Still can't resolve â€” store as unidentified with embedding for future matching
    const label = `Unidentified (${unenrolled.join(', ')})`;
    await saveVoicePrint({ name: label, audioClip: rightChannelClip, isUser: false, embedding: clipEmbedding });
    log('info', 'voice-enroll:unidentified', `stored clip with embedding for ${unenrolled.length} unknown voices`);
  } else if (unenrolled.length > 1) {
    // No embedding computed â€” store raw clip only
    const label = `Unidentified (${unenrolled.join(', ')})`;
    await saveVoicePrint({ name: label, audioClip: rightChannelClip, isUser: false });
    log('info', 'voice-enroll:unidentified', `stored clip (no embedding) for ${unenrolled.length} unknown voices`);
  }
}

// â”€â”€ Recording pipeline â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runRecordingPipeline(audioPath: string, meetingTitle: string, calendarEventId?: string, stereo?: boolean, attendees?: string[], jobId?: string): Promise<boolean> {
  const job = jobId || path.basename(audioPath);
  emitSecondary({ jobId: job, title: meetingTitle, state: 'transcribing' });
  log('info', 'pipeline:start', `title="${meetingTitle}" stereo=${!!stereo} path=${audioPath}`);

  // Create the meeting record FIRST so failed transcriptions are still recoverable.
  // If this title already produced a recording meeting within the last hour,
  // treat this audio as another segment of that meeting instead of a new one.
  const durationSec = getAudioDuration(audioPath);
  log('info', 'pipeline:transcribe', `duration=${durationSec}s`);

  const existing = await findRecentRecordingMeeting(meetingTitle, calendarEventId, 60 * 60 * 1000);
  const merging = !!existing;
  const meetingId = existing
    ? existing._id
    : await createMeeting({
        title: meetingTitle,
        date: new Date().toISOString(),
        duration: durationSec,
        calendarEventId,
        source: 'desktop_recording',
        attendees: attendees || [],
      });
  log('info', merging ? 'pipeline:meeting-merged' : 'pipeline:meeting-created', meetingId);
  await updateMeetingStatus(meetingId, 'transcribing');
  mainWindow?.webContents.send('meeting:new', await getMeeting(meetingId));

  try {
    let transcript = await transcribeAudio(audioPath, stereo);
    log('info', 'pipeline:transcribed', `length=${transcript.length} chars`);

    // Replace speaker labels with real names
    if (stereo) {
      transcript = await replaceSpeakerLabels(transcript, attendees || []);
    }

    if (merging) {
      await appendMeetingTranscript(meetingId, transcript, durationSec);
    } else {
      await updateMeetingTranscript(meetingId, transcript, durationSec);
    }

    // Always notify renderer so meeting appears even if insights fail
    mainWindow?.webContents.send('meeting:new', await getMeeting(meetingId));

    emitSecondary({ jobId: job, title: meetingTitle, state: 'processing' });
    try {
      // When merging segments, re-extract insights from the combined transcript
      const fullTranscript = merging ? ((await getMeeting(meetingId))?.transcript || transcript) : transcript;
      const insights = await extractInsights(fullTranscript);

      // Detect contradictions against past decisions
      try {
        if (insights.decisions && insights.decisions.length > 0) {
          emitSecondary({ jobId: job, title: meetingTitle, state: 'processing' });
          const pastDecisions = await getAllPastDecisions();
          const contradictions = await detectContradictions(insights.decisions, pastDecisions);
          insights.contradictions = contradictions;
          if (contradictions.length > 0) {
            log('info', 'pipeline:contradictions-found', `${contradictions.length} contradiction(s) detected`);
          }
        }
      } catch (contradictionErr: any) {
        log('error', 'pipeline:contradiction-check-failed', contradictionErr.message);
      }

      await saveInsights(meetingId, insights);
      mainWindow?.webContents.send('meeting:new', await getMeeting(meetingId));
      log('info', 'pipeline:insights-saved', meetingId);

      // Auto-push to Jira if enabled â€” match to existing stories first
      const jiraConfig = getConfig();
      if ((jiraConfig as any).jiraAutoPush && (jiraConfig as any).jiraTokens && (jiraConfig as any).jiraDefaultProject) {
        try {
          const projectKey = (jiraConfig as any).jiraDefaultProject;
          const stories = await getJiraStories(projectKey);
          const matches = matchAllItems(insights.actionItems, stories);

          const sorJiraPrefs = getSorJiraPrefs();
          let created = 0;
          let linked = 0;
          let gated = 0;

          for (let i = 0; i < matches.length; i++) {
            const match = matches[i];
            const item = insights.actionItems[i];

            // Create the local task first so we can pass its id as `linkedTaskId`
            // provenance to the Jira push. If the Jira call then fails, the local
            // task survives as an unsynced record â€” strictly better than losing it.
            const task = await createTask({
              title: item.text,
              description: `From meeting: ${meetingTitle}`,
              priority: item.priority || 'medium',
              dueDate: item.dueDate,
              status: 'todo',
            });

            const transcriptSpan = item.text
              ? { start: 0, end: item.text.length, snippet: item.text }
              : undefined;
            // Confidence signal: the jira-matcher's best-match similarity. If
            // matching found no candidate at all, confidence is undefined and
            // the gate never fires (per PRD US-006 "NEVER gate them").
            const confidence = match.bestMatch ? match.bestMatch.similarity : undefined;
            const provenance = {
              sourceMeetingId: meetingId,
              sourceTranscriptSpan: transcriptSpan,
              linkedTaskId: task._id,
              confidence,
              approvalPath: 'auto' as const,
            };

            const gate = sorShouldGateWrite(
              confidence,
              sorJiraPrefs.approvalGateEnabled,
              sorJiraPrefs.approvalThreshold,
            );

            if (gate) {
              // Gated: record the would-be write as pending-approval and stash
              // the push params for the user to approve / reject later from the
              // Inbox. Do NOT push and do NOT link the task's source yet â€” both
              // happen on approve.
              const isLink = match.autoApproved && match.bestMatch;
              let pushParams: SorPushParams;
              let fieldDiffs: Array<{ field: string; before: any; after: any }>;
              let commentBody: string | null = null;
              let targetRecordId: string;
              let targetRecordUrl: string | null = null;

              if (isLink && match.bestMatch) {
                const body = `Action item: ${item.text}\nOwner: ${item.owner || 'Unassigned'}`;
                pushParams = {
                  operation: 'comment',
                  args: { issueKey: match.bestMatch.jiraKey, comment: body, meetingTitle },
                };
                fieldDiffs = [];
                commentBody = `[Inwise] From "${meetingTitle}":\n\n${body}`;
                targetRecordId = match.bestMatch.jiraKey;
                targetRecordUrl = match.bestMatch.jiraUrl;
              } else {
                pushParams = {
                  operation: 'create',
                  args: {
                    title: item.text,
                    description: `From meeting: ${meetingTitle}\nOwner: ${item.owner || 'Unassigned'}`,
                    priority: item.priority || 'medium',
                    dueDate: item.dueDate,
                    projectKey,
                  },
                };
                fieldDiffs = sorComputeCreateDiffs({
                  title: item.text,
                  description: `From meeting: ${meetingTitle}\nOwner: ${item.owner || 'Unassigned'}`,
                  priority: item.priority || 'medium',
                  dueDate: item.dueDate,
                  projectKey,
                });
                targetRecordId = '(pending-create)';
                targetRecordUrl = null;
              }

              const pendingId = await sorRecordWrite({
                targetSystem: 'jira',
                targetRecordId,
                targetRecordUrl,
                operation: pushParams.operation,
                fieldDiffs,
                commentBody,
                provenance: { ...provenance, approvalPath: 'opt-in-gated' as const },
                pushParams,
                result: 'pending-approval',
              });
              await stashPending({
                _id: pendingId,
                targetSystem: 'jira',
                pushParams,
                meetingTitle,
                linkedTaskId: task._id,
                createdAt: new Date().toISOString(),
              });
              gated++;
              continue;
            }

            if (match.autoApproved && match.bestMatch) {
              // High-confidence match â€” link to existing story via comment
              await addJiraComment(
                match.bestMatch.jiraKey,
                `Action item: ${item.text}\nOwner: ${item.owner || 'Unassigned'}`,
                meetingTitle,
                provenance,
              );
              await updateTask(task._id, {
                source: { type: 'jira', id: match.bestMatch.jiraKey, url: match.bestMatch.jiraUrl },
              });
              linked++;
            } else {
              // No confident match â€” create new Jira issue
              const result = await createJiraIssue({
                title: item.text,
                description: `From meeting: ${meetingTitle}\nOwner: ${item.owner || 'Unassigned'}`,
                priority: item.priority || 'medium',
                dueDate: item.dueDate,
                projectKey,
              }, provenance);
              await updateTask(task._id, {
                source: { type: 'jira', id: result.key, url: result.url },
              });
              created++;
            }
          }

          const total = created + linked;
          log(
            'info',
            'pipeline:jira-auto-push',
            `created ${created}, linked ${linked}${gated ? `, ${gated} awaiting approval` : ''} of ${total + gated} tasks to ${projectKey}`,
          );
          mainWindow?.webContents.send('jira:auto-synced', { created, linked, gated, total });

          // Per-meeting SoR trace notification. Reads the audit log (not the
          // loop counters) so failure counts reflect the truth on disk.
          try {
            const writes = await sorListByMeeting(meetingId);
            const successCount = writes.filter(w => w.result === 'success').length;
            const failedCount = writes.filter(w => w.result === 'failed').length;
            if ((successCount + failedCount) > 0 && Notification.isSupported()) {
              const body = failedCount > 0
                ? `${successCount} pushed, ${failedCount} failed`
                : `${successCount} update${successCount === 1 ? '' : 's'} pushed to Jira.`;
              const n = new Notification({
                title: `Meeting ${meetingTitle}`,
                body,
                actions: [{ type: 'button', text: 'See details' }],
              });
              const openDetails = () => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                  mainWindow.show();
                  mainWindow.focus();
                  mainWindow.webContents.send('meeting:open-details', {
                    meetingId,
                    focusTab: 'sorWrites',
                  });
                }
              };
              n.on('action', openDetails);
              n.on('click', openDetails);
              n.show();
            }
          } catch (notifyErr: any) {
            log('error', 'pipeline:sor-notification-failed', notifyErr.message);
          }
        } catch (jiraErr: any) {
          log('error', 'pipeline:jira-auto-push-failed', jiraErr.message);
        }
      }
    } catch (insightErr: any) {
      log('error', 'pipeline:insights-failed', insightErr.message);
      await updateMeetingStatus(meetingId, 'error');
      mainWindow?.webContents.send('meeting:new', await getMeeting(meetingId));
      mainWindow?.webContents.send('pipeline:error', {
        meetingId,
        error: insightErr.message,
        stage: 'insights'
      });
    }

    // Auto-enroll voices from stereo recordings
    if (stereo && attendees && attendees.length > 0) {
      try {
        await autoEnrollVoices(audioPath, attendees);
      } catch (enrollErr: any) {
        log('error', 'pipeline:voice-enroll-failed', enrollErr.message);
      }
    }

    // Post-meeting task reprioritization
    try {
      const allTasks = await getTasks();
      const allMeetings = await getMeetings();
      const allPeople = await getPeople();
      const scored = scoreTasks(allTasks, allMeetings, allPeople);
      mainWindow?.webContents.send('tasks:reprioritized', scored);
      log('info', 'pipeline:reprioritized', `scored ${scored.length} tasks`);
    } catch (scoreErr: any) {
      log('error', 'pipeline:reprioritize-failed', scoreErr.message);
    }

    // Task completion inference â€” flag tasks the transcript strongly implies are done.
    // Never auto-completes; user confirms via the 'Done?' pill in the Tasks view.
    try {
      const openTasks = await getTasks();
      const candidates = openTasks
        .filter((t: any) => t.status !== 'done' && t.status !== 'completed')
        .map((t: any) => ({ _id: t._id, title: t.title, description: t.description }));
      const flaggedIds = await inferCompletedTaskIds(transcript, candidates);
      for (const id of flaggedIds) {
        await markLikelyDone(id);
      }
      log('info', 'pipeline:likely-done', `flagged=${flaggedIds.length} tasks`);
      if (flaggedIds.length > 0) {
        log('info', 'pipeline:likely-done-ids', flaggedIds.join(','));
        mainWindow?.webContents.send('tasks:likely-done-updated');
      }
    } catch (inferErr: any) {
      log('error', 'pipeline:likely-done-failed', inferErr.message);
    }

    emitSecondary({ jobId: job, title: meetingTitle, state: 'done' });
    mainWindow?.webContents.send('recording:status', { status: 'done' });
    log('info', 'pipeline:done', meetingId);
  } catch (err: any) {
    log('error', 'pipeline:failed', err.message);
    // Mark the meeting as failed so it stays visible in the UI
    try {
      await updateMeetingStatus(meetingId, 'error');
      mainWindow?.webContents.send('meeting:new', await getMeeting(meetingId));
      mainWindow?.webContents.send('pipeline:error', { meetingId, error: err.message, stage: 'transcribe' });
    } catch { /* ignore */ }
    emitSecondary({ jobId: job, title: meetingTitle, state: 'error', message: err.message });
    mainWindow?.webContents.send('recording:status', { status: 'error', message: err.message });
    // The pill may already be recording the next meeting, so a failed background
    // transcription also gets a notification the user can't miss.
    if (Notification.isSupported()) {
      new Notification({ title: 'Transcription failed', body: `${meetingTitle}: ${err.message}` }).show();
    }
    // Keep audio file on failure so user can retry — delete only on success
    return false;
  }
  // Recording preserved on success and failure — user explicitly requested retention.
  return true;
}

function getAudioDuration(filePath: string): number {
  try {
    const stat = fs.statSync(filePath);
    // Read the byte rate from the WAV header — a fixed mono rate (32000)
    // reported stereo recordings at twice their real length.
    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(44);
    fs.readSync(fd, header, 0, 44, 0);
    fs.closeSync(fd);
    const isWav = header.toString('ascii', 0, 4) === 'RIFF';
    const byteRate = isWav ? header.readUInt32LE(28) : 0;
    return Math.round(Math.max(0, stat.size - 44) / (byteRate > 0 ? byteRate : 32000));
  } catch { return 0; }
}

// â”€â”€ IPC handlers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

ipcMain.handle('whisper:setup', async (event, model: string) => {
  try {
    await setupWhisper(model, (message, pct) => {
      event.sender.send('whisper:progress', { message, pct });
    });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('mic:test', async (_e, buffer: Buffer) => {
  const tmpPath = path.join(os.tmpdir(), `inwise-mictest-${Date.now()}.wav`);
  console.log('[mic:test] called, buffer size:', buffer?.length, 'tmp:', tmpPath);
  try {
    fs.writeFileSync(tmpPath, buffer);
    console.log('[mic:test] wav written, starting transcription');
    const transcript = await transcribeAudio(tmpPath);
    console.log('[mic:test] transcript:', transcript);
    return { ok: true, transcript: transcript.trim() || '(no speech detected)' };
  } catch (e: any) {
    console.error('[mic:test] error:', e);
    return { ok: false, error: e.message };
  } finally {
    fs.unlink(tmpPath, () => {});
  }
});

// ── Voice memos (header mic → capture → review → apply) ─────────────────────

ipcMain.handle('voice:transcribe', async (_e, buffer: Buffer, durationSec: number) => {
  const recordingsDir = path.join(app.getPath('userData'), 'recordings');
  if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });
  const audioPath = path.join(recordingsDir, `inwise-memo-${Date.now()}.wav`);
  try {
    fs.writeFileSync(audioPath, buffer);
    const transcript = (await transcribeAudio(audioPath)).trim();
    if (!transcript) {
      fs.unlink(audioPath, () => {});
      return { ok: false, error: 'no_speech' };
    }
    log('info', 'voice:transcribe', `memo transcribed (${durationSec}s, ${transcript.length} chars)`);
    return { ok: true, transcript, audioPath };
  } catch (e: any) {
    fs.unlink(audioPath, () => {});
    log('error', 'voice:transcribe', e.message);
    return { ok: false, error: e.message };
  }
});

const VOICE_MEMO_PRIORITIES = ['low', 'medium', 'high'];

ipcMain.handle('voice:classify', async (_e, transcript: string, ctx: {
  userName?: string;
  peopleNames?: string[];
  meetings?: Array<{ id: string; title: string; when: string }>;
}) => {
  const meetings = (ctx?.meetings || []).slice(0, 20);
  const meetingIds = new Set(meetings.map(m => m.id));
  const now = new Date();
  const contextText = [
    `NOW: ${now.toISOString()} (${now.toLocaleDateString([], { weekday: 'long' })})`,
    ctx?.userName ? `USER: ${ctx.userName}` : null,
    ctx?.peopleNames?.length ? `KNOWN PEOPLE: ${ctx.peopleNames.slice(0, 30).join(', ')}` : null,
    meetings.length
      ? `UPCOMING MEETINGS:\n${meetings.map(m => `- id: ${m.id} | ${m.title} | ${m.when}`).join('\n')}`
      : 'UPCOMING MEETINGS: none',
  ].filter(Boolean).join('\n');

  try {
    const raw = await classifyVoiceMemo(transcript, contextText);
    // Same posture as the cloud sanitizer: clamp enums, drop fabricated ids.
    const items: VoiceMemoItem[] = [];
    for (const item of raw) {
      if (item?.kind === 'task' && item.title) {
        const prio = String((item as any).suggestedPriority || '').toLowerCase();
        items.push({
          kind: 'task',
          title: String(item.title),
          details: item.details ? String(item.details) : '',
          owner: item.owner ? String(item.owner) : null,
          dueDate: item.dueDate && !Number.isNaN(Date.parse(item.dueDate)) ? item.dueDate : null,
          suggestedPriority: (VOICE_MEMO_PRIORITIES.includes(prio) ? prio : 'medium') as 'low' | 'medium' | 'high',
          priorityReason: (item as any).priorityReason ? String((item as any).priorityReason) : null,
        });
      } else if (item?.kind === 'agenda' && item.text) {
        items.push({
          kind: 'agenda',
          text: String(item.text),
          targetMeetingId: item.targetMeetingId && meetingIds.has(String(item.targetMeetingId)) ? String(item.targetMeetingId) : null,
        });
      } else if (item?.kind === 'note' && item.text) {
        items.push({ kind: 'note', text: String(item.text) });
      }
    }
    return { ok: true, items };
  } catch (e: any) {
    const noKey = /api key not configured/i.test(e.message || '');
    log(noKey ? 'info' : 'error', 'voice:classify', e.message);
    return { ok: false, error: noKey ? 'no_api_key' : e.message };
  }
});

ipcMain.handle('voice:applyMemo', async (_e, payload: {
  transcript: string;
  audioPath: string | null;
  durationSec: number;
  items: any[];
}) => {
  try {
    const applied: any[] = [];
    for (const item of payload?.items || []) {
      if (item?.kind === 'task' && item.title) {
        const prio = String(item.priority || '').toLowerCase();
        applied.push({
          kind: 'task',
          title: String(item.title),
          details: item.details ? String(item.details) : '',
          owner: item.owner ? String(item.owner) : null,
          dueDate: item.dueDate && !Number.isNaN(Date.parse(item.dueDate)) ? item.dueDate : null,
          priority: VOICE_MEMO_PRIORITIES.includes(prio) ? prio : 'medium',
          // Ask-band confirm resolved in the review pane (US-007/US-013).
          mergeIntoTaskId: item.mergeIntoTaskId ? String(item.mergeIntoTaskId) : null,
          reopen: !!item.reopen,
          matchConfidence: typeof item.matchConfidence === 'number' ? item.matchConfidence : null,
        });
      } else if (item?.kind === 'agenda' && item.text) {
        // An agenda point with no meeting to land on degrades to a note rather
        // than being dropped — same posture as the cloud apply path.
        if (item.targetMeetingId) {
          applied.push({
            kind: 'agenda',
            text: String(item.text),
            targetMeetingId: String(item.targetMeetingId),
            targetTitle: item.targetTitle ? String(item.targetTitle) : null,
          });
        } else {
          applied.push({ kind: 'note', text: String(item.text) });
        }
      } else if (item?.kind === 'note' && item.text) {
        applied.push({ kind: 'note', text: String(item.text) });
      }
    }
    if (!applied.length) return { ok: false, error: 'nothing_to_apply' };

    const memo = await createVoiceMemo({
      transcript: String(payload.transcript || ''),
      durationSec: Number(payload.durationSec) || 0,
      audioPath: payload.audioPath || null,
      items: applied,
    });
    const memoId = (memo as any)._id;
    for (const item of applied) {
      if (item.kind !== 'task') continue;

      // The review pane already showed any ask-band match and the user chose;
      // `mergeIntoTaskId` is that choice riding back with the item. Anything
      // else goes through the same dedup decision the meeting pipeline uses,
      // so a spoken paraphrase of an open task is never an unconditional
      // insert (US-013).
      if (item.mergeIntoTaskId) {
        const merged = await appendTaskMention(String(item.mergeIntoTaskId), {
          id: randomUUID(),
          sourceType: 'voice_note',
          sourceId: memoId,
          sourceTitle: 'Voice note',
          excerpt: item.title,
          occurredAt: new Date().toISOString(),
          mergedItem: {
            title: item.title,
            description: item.details || '',
            owner: item.owner || null,
            deadline: item.dueDate || null,
          },
        }, { reopen: !!item.reopen });
        if (merged) {
          await logMatchDecision({
            decisionType: item.reopen ? 'reopen_merge' : 'confirm_same',
            confidence: typeof item.matchConfidence === 'number' ? item.matchConfidence : null,
            candidateTaskId: String(item.mergeIntoTaskId),
            taskId: String(item.mergeIntoTaskId),
            newItemText: item.title,
            decidedBy: 'user',
            surface: 'oss',
          });
          continue;
        }
        // Candidate vanished between review and apply — fall through and create.
      }

      let decision: any = { kind: 'none' };
      try {
        decision = await decideMention(
          { title: item.title, description: item.details || '' },
          await getAllTasksForDedup(),
          {}, // voice memos have no source meeting — text-only classification
        );
      } catch (e: any) {
        log('error', 'voice:applyMemo:dedup-failed', e?.message || String(e));
      }

      if (decision.kind === 'auto_merge') {
        await appendTaskMention(decision.taskId, {
          id: randomUUID(),
          sourceType: 'voice_note',
          sourceId: memoId,
          sourceTitle: 'Voice note',
          excerpt: item.title,
          occurredAt: new Date().toISOString(),
          mergedItem: {
            title: item.title,
            description: item.details || '',
            owner: item.owner || null,
            deadline: item.dueDate || null,
          },
        });
        await logMatchDecision({
          decisionType: 'auto_merge',
          confidence: decision.confidence,
          retrievalScore: decision.retrievalScore,
          candidateTaskId: decision.taskId,
          taskId: decision.taskId,
          newItemText: item.title,
          decidedBy: 'system',
          surface: 'oss',
        });
        continue;
      }

      const created = await createVoiceMemoTask(memoId, item);
      if (decision.kind === 'new') {
        await logMatchDecision({
          decisionType: 'below_ask_new',
          confidence: decision.confidence,
          retrievalScore: decision.retrievalScore,
          candidateTaskId: decision.candidateTaskId,
          taskId: (created as any)?._id || null,
          newItemText: item.title,
          decidedBy: 'system',
          surface: 'oss',
        });
      }
    }
    log('info', 'voice:applyMemo', `memo ${memoId}: ${applied.length} item(s) applied`);
    mainWindow?.webContents.send('meeting:new', memo);
    return { ok: true, memoId };
  } catch (e: any) {
    log('error', 'voice:applyMemo', e.message);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('shell:openExternal', (_e, url: string) => shell.openExternal(url));

ipcMain.handle('desktop:getSourceId', async () => {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    const id = sources[0]?.id ?? null;
    log('info', 'desktop:getSourceId', id ? `found: ${id}` : 'no sources');
    return id;
  } catch (e: any) {
    log('error', 'desktop:getSourceId', e.message);
    return null;
  }
});
ipcMain.handle('media:permissions', () => getMediaPermissions());
ipcMain.handle('media:requestMicrophone', () => requestMicrophonePermission());
ipcMain.handle('media:openSettings', (_e, kind: 'microphone' | 'screen') => openMediaSettings(kind));
ipcMain.handle('config:get', () => getConfig());
ipcMain.handle('config:set', (_e, updates) => { setConfig(updates); return true; });
ipcMain.handle('window:completeOnboarding', () => {
  // Finishing setup swaps the onboarding tree for the popup shell. Keep the
  // window pinned through that render so a transient focus change cannot make
  // the app appear to vanish at the exact moment the user finishes setup.
  popupPinned = true;
  if (mainWindow && !mainWindow.isDestroyed()) {
    positionPopupWindow(mainWindow);
    mainWindow.show();
    mainWindow.focus();
  }
  setTimeout(() => { popupPinned = false; }, 2500);
  return true;
});

ipcMain.handle('seed:demo', async () => {
  try {
    const existing = await getMeetings();
    if (existing.some((m: any) => m.source === 'demo_seed')) {
      log('info', 'seed:demo', 'Demo data already exists, skipping');
      return { seeded: false, reason: 'already_exists' };
    }

    const now = new Date();
    const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000).toISOString();
    const daysFromNow = (d: number) => new Date(now.getTime() + d * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Create demo people
    const people = [
      { firstName: 'Alex', lastName: 'Chen', email: 'alex.chen@example.com' },
      { firstName: 'Sarah', lastName: 'Kim', email: 'sarah.kim@example.com' },
      { firstName: 'Jordan', lastName: 'Patel', email: 'jordan.patel@example.com' },
      { firstName: 'Maya', lastName: 'Rodriguez', email: 'maya.r@example.com' },
    ];
    for (const p of people) {
      try { await addPerson(p); } catch { /* skip if exists */ }
    }

    // Meeting 1: Sprint Planning
    const m1Id = await createMeeting({ title: 'Sprint Planning â€” Q2 Priorities', date: daysAgo(2), duration: 2700, attendees: ['Alex Chen', 'Sarah Kim', 'Jordan Patel', 'Maya Rodriguez'], source: 'demo_seed' });
    await saveInsights(m1Id, {
      summary: 'Sprint planning for Q2. Dashboard redesign is priority one (ship by end of April). Mobile onboarding parallel track for key client (April 15). API v2 starts mid-May. Staging CI pipeline identified as blocker.',
      actionItems: [
        { text: 'Share dashboard wireframes in Figma', owner: 'Maya Rodriguez', dueDate: daysFromNow(0), priority: 'high' },
        { text: 'Prepare API v2 technical spec with migration path', owner: 'Jordan Patel', dueDate: daysFromNow(3), priority: 'high' },
        { text: 'Escalate staging CI pipeline issues to DevOps', owner: 'Alex Chen', dueDate: daysFromNow(0), priority: 'critical', isCommitment: true },
        { text: 'Complete mobile onboarding designs', owner: 'Maya Rodriguez', dueDate: daysFromNow(5), priority: 'high' },
      ],
      decisions: [
        { text: 'Dashboard redesign is top priority for Q2', rationale: 'Enterprise customer feedback' },
        { text: 'API v2 starts after dashboard ships', rationale: 'Avoid overloading the team' },
      ],
      blockers: [
        { text: 'Staging environment CI pipeline failures â€” losing velocity', severity: 'high' },
      ],
    });
    await updateMeetingStatus(m1Id, 'reviewed');

    // Meeting 2: 1:1 with Alex
    const m2Id = await createMeeting({ title: '1:1 with Alex â€” Engineering Updates', date: daysAgo(1), duration: 1800, attendees: ['Alex Chen'], source: 'demo_seed' });
    await saveInsights(m2Id, {
      summary: 'DevOps found CI memory leak, fix tonight. API v2 may deprecate 3 endpoints â€” need 60-day deprecation policy. Dashboard needs WebSocket for real-time refresh. Jordan to be tech lead on API v2.',
      actionItems: [
        { text: 'Draft API deprecation policy document', owner: 'Alex Chen', dueDate: daysFromNow(4), priority: 'medium', isCommitment: true },
        { text: 'Create WebSocket upgrade ticket for dashboard', owner: 'Alex Chen', dueDate: daysFromNow(0), priority: 'medium' },
        { text: 'Discuss API v2 tech lead role with Jordan', owner: 'Alex Chen', dueDate: daysFromNow(3), priority: 'medium', isCommitment: true },
      ],
      decisions: [
        { text: 'Jordan Patel to be tech lead on API v2', rationale: 'Expressed interest, right expertise' },
        { text: '60-day minimum notice for API deprecations', rationale: 'Give customers migration time' },
      ],
      blockers: [],
    });
    await updateMeetingStatus(m2Id, 'reviewed');

    // Meeting 3: Design Review
    const m3Id = await createMeeting({ title: 'Design Review â€” Dashboard Wireframes', date: daysAgo(0), duration: 2100, attendees: ['Maya Rodriguez', 'Alex Chen', 'Sarah Kim'], source: 'demo_seed' });
    await saveInsights(m3Id, {
      summary: 'Dashboard wireframes approved â€” card-based layout with drag-to-reorder. Focus time metric to be added. Mobile responsive at 768px and 1024px breakpoints. Dev starts Monday.',
      actionItems: [
        { text: 'Add focus time card to dashboard design', owner: 'Maya Rodriguez', dueDate: daysFromNow(2), priority: 'medium' },
        { text: 'Finalize design specs and hand off to engineering', owner: 'Maya Rodriguez', dueDate: daysFromNow(3), priority: 'high', isCommitment: true },
        { text: 'Start dashboard frontend development', owner: 'Alex Chen', dueDate: daysFromNow(4), priority: 'high' },
      ],
      decisions: [
        { text: 'Card-based dashboard with drag-to-reorder', rationale: 'More flexible than tabs' },
        { text: 'Focus time metric added to team health', rationale: 'Customer feedback about meeting overload' },
      ],
      blockers: [],
    });
    await updateMeetingStatus(m3Id, 'reviewed');

    // â”€â”€ More people (extends the cast beyond the core 4) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const extraPeople = [
      { firstName: 'Priya', lastName: 'Sharma', email: 'priya.sharma@example.com' },
      { firstName: 'David', lastName: 'Sobie', email: 'david@customer-co.com' },
      { firstName: 'Anu', lastName: 'Codaty', email: 'anu@designstudio.com' },
      { firstName: 'Benjamin', lastName: 'Wu', email: 'ben.wu@example.com' },
      { firstName: 'Olivia', lastName: 'Brooks', email: 'olivia.b@example.com' },
      { firstName: 'Ravi', lastName: 'Menon', email: 'ravi.menon@example.com' },
      { firstName: 'Leah', lastName: 'Goldberg', email: 'leah.g@example.com' },
      { firstName: 'TomÃ¡s', lastName: 'GarcÃ­a', email: 'tomas.g@example.com' },
      { firstName: 'Harper', lastName: 'Okonkwo', email: 'harper@customer-co.com' },
      { firstName: 'Kai', lastName: 'Nakamura', email: 'kai.n@example.com' },
    ];
    for (const p of extraPeople) {
      try { await addPerson(p); } catch { /* skip if exists */ }
    }

    // â”€â”€ More meetings with insights â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const m4Id = await createMeeting({ title: 'Customer sync â€” Harper Okonkwo (CustomerCo)', date: daysAgo(7), duration: 1800, attendees: ['Harper Okonkwo', 'Olivia Brooks'], source: 'demo_seed' });
    await saveInsights(m4Id, {
      summary: 'Harper outlined CustomerCo requirements for Q3 rollout: SSO, audit log export, role-based permissions. Budget signed off; procurement kicks off next week.',
      actionItems: [
        { text: 'Send SSO integration technical spec to Harper', owner: 'Olivia Brooks', dueDate: daysFromNow(2), priority: 'high', isCommitment: true },
        { text: 'Prepare audit-log export mockup for next sync', owner: 'Maya Rodriguez', dueDate: daysFromNow(5), priority: 'high' },
      ],
      decisions: [{ text: 'CustomerCo Q3 rollout approved', rationale: 'Budget signed; legal review complete' }],
      blockers: [],
    });
    await updateMeetingStatus(m4Id, 'reviewed');

    const m5Id = await createMeeting({ title: 'Weekly Engineering Standup', date: daysAgo(1), duration: 900, attendees: ['Alex Chen', 'Jordan Patel', 'Ravi Menon', 'Leah Goldberg', 'TomÃ¡s GarcÃ­a'], source: 'demo_seed' });
    await saveInsights(m5Id, {
      summary: 'Sprint progressing; 7 of 12 stories in-flight. Ravi unblocked on auth refactor. TomÃ¡s raising concerns about test flakiness in CI â€” 20% failure rate on retries.',
      actionItems: [
        { text: 'Investigate CI test flakiness root cause', owner: 'TomÃ¡s GarcÃ­a', dueDate: daysFromNow(1), priority: 'medium' },
        { text: 'Pair with Leah on WebSocket implementation', owner: 'Ravi Menon', dueDate: daysFromNow(2), priority: 'medium' },
      ],
      decisions: [],
      blockers: [{ text: 'CI flakiness hurting merge velocity', severity: 'medium' }],
    });

    const m6Id = await createMeeting({ title: 'All-hands â€” Q2 kickoff', date: daysAgo(10), duration: 3600, attendees: ['Alex Chen', 'Sarah Kim', 'Maya Rodriguez', 'Priya Sharma', 'Kai Nakamura'], source: 'demo_seed' });
    await saveInsights(m6Id, {
      summary: 'Q1 recap: 3 enterprise deals closed, 18% churn reduction. Q2 focus: ship dashboard, API v2, mobile onboarding. Hiring freeze lifted â€” 2 eng roles, 1 design.',
      actionItems: [
        { text: 'Open 2 senior engineer reqs', owner: 'Alex Chen', dueDate: daysFromNow(3), priority: 'high', isCommitment: true },
        { text: 'Open senior product designer req', owner: 'Maya Rodriguez', dueDate: daysFromNow(3), priority: 'medium' },
      ],
      decisions: [{ text: 'Q2 focus locked: dashboard + API v2 + mobile onboarding', rationale: 'Customer-driven; aligned with board' }],
      blockers: [],
    });
    await updateMeetingStatus(m6Id, 'reviewed');

    const m7Id = await createMeeting({ title: '1:1 with Jordan â€” API v2 architecture', date: daysAgo(5), duration: 1800, attendees: ['Jordan Patel'], source: 'demo_seed' });
    await saveInsights(m7Id, {
      summary: 'Jordan proposing event-sourced read models for API v2 read path. Clear perf benefit; adds complexity. Decision needed by end of week. Jordan to document trade-offs and alternatives.',
      actionItems: [
        { text: 'Write ADR for API v2 read-path approach', owner: 'Jordan Patel', dueDate: daysFromNow(4), priority: 'high' },
      ],
      decisions: [],
      blockers: [],
    });

    const m8Id = await createMeeting({ title: 'Design critique â€” Mobile onboarding v2', date: daysAgo(3), duration: 1800, attendees: ['Maya Rodriguez', 'Anu Codaty', 'Sarah Kim'], source: 'demo_seed' });
    await saveInsights(m8Id, {
      summary: 'Reviewed three onboarding flows. Anu\u0027s Variant B wins on time-to-value; needs accessibility pass. Ship candidate decided; will run small quantitative test next week.',
      actionItems: [
        { text: 'Accessibility audit on onboarding Variant B', owner: 'Anu Codaty', dueDate: daysFromNow(6), priority: 'medium' },
      ],
      decisions: [{ text: 'Onboarding Variant B is the ship candidate', rationale: 'Best time-to-value in user tests' }],
      blockers: [],
    });
    await updateMeetingStatus(m8Id, 'reviewed');

    // Two calendar-only meetings (no insights â€” simulate meetings that weren't recorded or reviewed yet)
    await createMeeting({ title: 'Standup', date: daysAgo(6), duration: 900, attendees: ['Alex Chen', 'Jordan Patel', 'Ravi Menon'], source: 'demo_seed' });
    await createMeeting({ title: 'Board prep â€” Q2 metrics', date: daysAgo(8), duration: 1800, attendees: ['Kai Nakamura', 'Priya Sharma'], source: 'demo_seed' });

    // Approve some tasks to make the board interesting
    const allTasks = await getTasks();
    const demoTasks = allTasks.filter((t: any) => t.source?.type === 'meeting');
    for (let i = 0; i < demoTasks.length; i++) {
      if (i < 3) {
        await updateTask(demoTasks[i]._id, { approval: { status: 'approved' } });
        if (i === 0) await updateTask(demoTasks[i]._id, { status: 'inProgress' });
        if (i === 2) await updateTask(demoTasks[i]._id, { status: 'completed' });
      }
    }

    // â”€â”€ Standalone tasks (ad-hoc, not from meetings) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const standaloneTasks: any[] = [
      { title: 'Book hotel for DevCon Austin', priority: 'medium', status: 'todo', dueDate: daysFromNow(6) },
      { title: 'Reply to Priya about onsite interview loop', priority: 'high', status: 'todo', dueDate: daysFromNow(1) },
      { title: 'Read "Staff Engineer" chapter 3', priority: 'low', status: 'todo', dueDate: daysFromNow(14) },
      { title: 'Update LinkedIn with role change', priority: 'low', status: 'todo' },
      { title: 'Renew passport', priority: 'medium', status: 'todo', dueDate: daysFromNow(45) },
      { title: 'Submit expense report for Q1', priority: 'high', status: 'inProgress', dueDate: daysFromNow(0) },
      { title: 'Schedule annual physical', priority: 'low', status: 'todo' },
      { title: 'Draft engineering ladder v3', priority: 'medium', status: 'inProgress', dueDate: daysFromNow(10) },
    ];
    for (const t of standaloneTasks) {
      await createTask({ ...t, source: { type: 'manual' }, approval: { status: 'approved' } });
    }

    // â”€â”€ Snoozed demo tasks (populate the Snoozed filter with varied reasons) â”€â”€
    const snoozeDemos: Array<{ title: string; reason: string; lastMentionedDaysAgo?: number }> = [
      { title: 'Ensure the house is clean and organized (speak and span)', reason: 'stale-30d', lastMentionedDaysAgo: 45 },
      { title: 'Revisit the Slack bot idea from last offsite', reason: 'stale-30d', lastMentionedDaysAgo: 60 },
      { title: 'Follow up on vendor proposal from Notion', reason: 'manual' },
      { title: 'Try new standing desk setup', reason: 'deferred' },
    ];
    for (const s of snoozeDemos) {
      const t = await createTask({ title: s.title, status: 'todo', priority: 'low', source: { type: 'manual' }, approval: { status: 'approved' } } as any);
      if (s.lastMentionedDaysAgo) {
        try { await updateTask(t._id, { lastMentionedAt: daysAgo(s.lastMentionedDaysAgo) } as any); } catch { /* schema may not accept */ }
      }
      await snoozeTask(t._id, s.reason);
    }

    const totalPeople = people.length + extraPeople.length;
    const totalTasks = demoTasks.length + standaloneTasks.length + snoozeDemos.length;
    const totalMeetings = 10;

    log('info', 'seed:demo', `Seeded ${totalMeetings} meetings, ${totalTasks} tasks, ${totalPeople} people`);
    return { seeded: true, meetings: totalMeetings, tasks: totalTasks, people: totalPeople };
  } catch (e: any) {
    log('error', 'seed:demo', e.message);
    return { seeded: false, error: e.message };
  }
});

ipcMain.handle('seed:clear', async () => {
  try {
    // Get demo meeting IDs first
    const allMeetings = await getMeetings();
    const demoMeetingIds = allMeetings.filter((m: any) => m.source === 'demo_seed').map((m: any) => m._id);

    if (demoMeetingIds.length === 0) return { cleared: false, reason: 'no_demo_data' };

    // Delete tasks sourced from demo meetings
    const allTasks = await getTasks();
    const demoTaskIds = allTasks
      .filter((t: any) => t.source?.type === 'meeting' && demoMeetingIds.includes(t.source.id))
      .map((t: any) => t._id);
    for (const id of demoTaskIds) {
      await deleteTask(id);
    }

    // Delete demo meetings
    for (const id of demoMeetingIds) {
      await deleteMeeting(id);
    }

    // Delete demo people (by example emails)
    const demoEmails = ['alex.chen@example.com', 'sarah.kim@example.com', 'jordan.patel@example.com', 'maya.r@example.com'];
    const allPeople = await getPeople();
    for (const p of allPeople) {
      if (demoEmails.includes((p as any).email)) {
        await archivePerson((p as any)._id);
      }
    }

    log('info', 'seed:clear', `Cleared ${demoMeetingIds.length} meetings, ${demoTaskIds.length} tasks`);
    return { cleared: true, meetings: demoMeetingIds.length, tasks: demoTaskIds.length };
  } catch (e: any) {
    log('error', 'seed:clear', e.message);
    return { cleared: false, error: e.message };
  }
});

ipcMain.handle('calendar:testUrl', (_e, url: string) => calendarWatcher.testUrl(url));
ipcMain.handle('calendar:health', () => calendarWatcher.getHealth());

ipcMain.handle('calendar:list', () => listCalendars());
ipcMain.handle('calendar:add', async (_e, row: Omit<CalendarSubscription, 'id'>) => {
  const created = addCalendar(row);
  log('info', 'calendar:add', `id=${created.id} label="${created.label}" provider=${created.provider}`);
  calendarWatcher.refresh();
  return created;
});
ipcMain.handle('calendar:update', async (_e, id: string, patch: Partial<Omit<CalendarSubscription, 'id'>>) => {
  const updated = updateCalendar(id, patch);
  log('info', 'calendar:update', `id=${id} patch=${JSON.stringify(Object.keys(patch))}`);
  calendarWatcher.refresh();
  return updated;
});
ipcMain.handle('calendar:remove', async (_e, id: string) => {
  removeCalendar(id);
  log('info', 'calendar:remove', `id=${id}`);
  calendarWatcher.refresh();
  return true;
});
ipcMain.handle('config:setSelfEmails', (_e, emails: string[]) => {
  const clean = Array.isArray(emails) ? emails.map((e) => String(e).trim()).filter(Boolean) : [];
  setSelfEmails(clean);
  log('info', 'config:setSelfEmails', `count=${clean.length}`);
  return clean;
});
ipcMain.handle('meeting:conflict:choose', (_e, chosenId: string) => {
  if (!pendingConflict) return { ok: false, reason: 'no-pending-conflict' };
  const { active, incoming } = pendingConflict;
  const winner = chosenId === active.id ? active : chosenId === incoming.id ? incoming : null;
  if (!winner) return { ok: false, reason: 'invalid-id' };
  resolveMeetingConflict(winner, 'user-selected');
  return { ok: true };
});
ipcMain.handle('calendar:getEvents', () => {
  return calendarWatcher.getUpcomingEvents().map(e => ({
    ...e,
    // Send as epoch ms so renderer constructs local Date correctly
    startTime: e.startTime.getTime(),
    endTime: e.endTime.getTime(),
  }));
});

ipcMain.handle('calendar:active-event', () => {
  const now = Date.now();
  const FALLBACK_DURATION_MS = 90 * 60_000;
  const active = calendarWatcher.getUpcomingEvents().find(e => {
    const start = e.startTime.getTime();
    const rawEnd = e.endTime?.getTime();
    const end = rawEnd && rawEnd > start ? rawEnd : start + FALLBACK_DURATION_MS;
    return start <= now && end >= now;
  });
  if (!active) return null;
  return {
    ...active,
    startTime: active.startTime.getTime(),
    endTime: active.endTime.getTime(),
  };
});

// Meetings
ipcMain.handle('db:getMeetings', async () => getMeetings());
ipcMain.handle('db:getMeeting', async (_e, id) => getMeeting(id));
ipcMain.handle('db:deleteMeeting', async (_e, id) => { await deleteMeeting(id); return true; });
ipcMain.handle('db:reviewMeeting', async (_e, id) => { await updateMeetingStatus(id, 'reviewed'); return true; });

ipcMain.handle('db:createMeetingFromTranscript', async (_e, data) => {
  const meeting = await createMeetingFromTranscript(data);
  try {
    const insights = await extractInsights(data.content);
    await saveInsights((meeting as any)._id, insights);
    return { ...(meeting as any), status: 'processed' };
  } catch {
    return meeting;
  }
});

// Attach a transcript to an EXISTING meeting (e.g. a calendar-synced meeting
// that was never recorded) and run insight extraction on it.
ipcMain.handle('db:attachTranscriptToMeeting', async (_e, meetingId: string, content: string) => {
  const existing = await getMeeting(meetingId);
  await updateMeetingTranscript(meetingId, content, existing?.duration || 0);
  try {
    const insights = await extractInsights(content);
    await saveInsights(meetingId, insights);
  } catch (err: any) {
    await updateMeetingStatus(meetingId, 'transcribed');
    log('error', 'attach-transcript:extract-failed', err?.message || String(err));
  }
  return getMeeting(meetingId);
});

// ── Person identity (fuzzy merge triage) ─────────────────────────────────────
ipcMain.handle('people:mergeCandidates', async () => getPersonMergeCandidates());
ipcMain.handle('people:merge', async (_e, keepId: string, dropId: string) => {
  await mergePeople(keepId, dropId);
  return { success: true };
});
ipcMain.handle('people:notSame', async (_e, idA: string, idB: string) => {
  await markNotSamePerson(idA, idB);
  return { success: true };
});

// Tasks
ipcMain.handle('db:getTasks', async () => {
  const tasks = await getTasks();
  // Hydrate old compact projections from the durable execution log so the
  // richer review UI also works for executions recorded before these fields
  // were added. Only tasks with an execution id incur a lookup.
  return Promise.all(tasks.map(async (task: any) => {
    const executionId = task.executionSummary?.executionId;
    if (!executionId) return task;
    const execution = await getActionExecution(executionId);
    return execution
      ? { ...task, executionSummary: buildActionExecutionSummary(execution) }
      : task;
  }));
});
ipcMain.handle('db:createTask', async (_e, data) => createTask(data));
ipcMain.handle('db:updateTask', async (_e, id, updates) => {
  const result = await updateTask(id, updates);

  // Auto-sync to Jira if enabled and task is linked
  try {
    const cfg = getConfig();
    if ((cfg as any).jiraAutoPush && (cfg as any).jiraTokens && result?.source?.type === 'jira' && result?.source?.id) {
      const jiraKey = result.source.id;
      let synced = false;

      const provenance = { linkedTaskId: id, approvalPath: 'auto' as const };

      // Status changed â€” transition in Jira
      if (updates.status) {
        await transitionJiraIssue(jiraKey, updates.status, provenance);
        synced = true;
      }

      // Title or description changed â€” update Jira issue fields
      if (updates.title || updates.description || updates.priority || updates.dueDate) {
        await updateJiraIssue(jiraKey, {
          title: updates.title,
          description: updates.description,
          priority: updates.priority,
          dueDate: updates.dueDate,
        }, provenance);
        synced = true;
      }

      if (synced) {
        log('info', 'jira:auto-sync-task', `synced ${jiraKey} after local update`);
        mainWindow?.webContents.send('jira:auto-synced', { updated: 1 });
      }
    }
  } catch (jiraSyncErr: any) {
    log('error', 'jira:auto-sync-task-failed', jiraSyncErr.message);
  }

  return result;
});
ipcMain.handle('db:deleteTask', async (_e, id) => { await deleteTask(id); return true; });

// Snoozed tasks (US-006)
ipcMain.handle('db:getSnoozedTasks', async () => getSnoozedTasks());
ipcMain.handle('db:snoozeTask', async (_e, id: string, reason: string) => {
  await snoozeTask(id, reason || 'manual');
  return true;
});
ipcMain.handle('db:bringBackTask', async (_e, id: string) => {
  await bringBackTask(id);
  return true;
});
ipcMain.handle('db:bringBackAllTasks', async () => {
  const snoozed = await getSnoozedTasks();
  for (const t of snoozed) await bringBackTask(t._id);
  return { count: snoozed.length };
});

// Likely-done task confirmation (US-007)
ipcMain.handle('db:confirmLikelyDone', async (_e, id: string) => {
  await confirmLikelyDone(id);
  return true;
});
ipcMain.handle('db:rejectLikelyDone', async (_e, id: string) => {
  await rejectLikelyDone(id);
  return true;
});

// ── Task-mention dedup (task-dedup PRD) ─────────────────────────────────────

/**
 * Ask-band confirm for a pending extracted task: 'same' merges it into the
 * candidate, 'reopen' does that and reopens a recently-done candidate, 'new'
 * keeps it standalone. Every outcome is logged locally.
 */
ipcMain.handle('dedup:resolvePending', async (_e, taskId: string, action: 'same' | 'new' | 'reopen') => {
  try {
    const res = await resolvePendingDedup(taskId, action);
    mainWindow?.webContents.send('tasks:mentions-updated');
    return res;
  } catch (e: any) {
    log('error', 'dedup:resolvePending', e?.message || String(e));
    return { ok: false, error: e?.message };
  }
});

/**
 * Live match lookup for the voice-memo review pane — the classifier result
 * rides back to the renderer with the extracted item so the confirm can render
 * inline instead of persisting a pending-match record.
 */
ipcMain.handle('dedup:matchVoiceItems', async (_e, items: Array<{ id: number; title: string; details?: string }>) => {
  try {
    const tasks = await getAllTasksForDedup();
    const model = providerModelLabel();
    const out: any[] = [];
    for (const item of items || []) {
      if (!item?.title) continue;
      const candidates = retrieveCandidates({ title: item.title, description: item.details || '' }, tasks, {});
      if (candidates.length === 0) continue;
      let results;
      try {
        results = await classifyCandidates({ title: item.title, description: item.details || '' }, candidates);
      } catch {
        continue; // degrade silently — apply-time dedup still runs
      }
      const best = results
        .filter(r => r.verdict === 'same_task')
        .sort((a, b) => b.confidence - a.confidence)[0];
      if (!best) continue;
      const cand = candidates[best.index];
      // Only the ask band needs the user; auto-merge and below-ask are decided
      // at apply time without a prompt.
      const askable = cand.wasDone
        ? best.confidence >= ASK_THRESHOLD
        : best.confidence >= ASK_THRESHOLD && best.confidence < AUTO_MERGE_THRESHOLD;
      if (!askable) continue;
      out.push({
        itemId: item.id,
        candidateTaskId: cand.taskId,
        candidateTitle: cand.title,
        wasDone: cand.wasDone,
        confidence: best.confidence,
        retrievalScore: cand.retrievalScore,
        model,
      });
    }
    return { ok: true, matches: out };
  } catch (e: any) {
    log('error', 'dedup:matchVoiceItems', e?.message || String(e));
    return { ok: false, matches: [] };
  }
});

/** Mention thread for task detail — empty for single-mention tasks (US-009). */
ipcMain.handle('dedup:getMentionThread', async (_e, taskId: string) => {
  const tasks = await getAllTasksForDedup();
  const task = tasks.find((t: any) => t._id === taskId);
  return task ? buildMentionThread(task) : [];
});

ipcMain.handle('dedup:mergeTasks', async (_e, survivorId: string, loserId: string) => {
  const res = await mergeTasksManual(survivorId, loserId);
  mainWindow?.webContents.send('tasks:mentions-updated');
  return res ? { ok: true } : { ok: false };
});

ipcMain.handle('dedup:undoSplit', async (_e, taskId: string, mentionId: string) => {
  const res = await undoSplitMention(taskId, mentionId);
  mainWindow?.webContents.send('tasks:mentions-updated');
  return res ? { ok: true, taskId: (res as any)._id } : { ok: false };
});

ipcMain.handle('dedup:bumpPriority', async (_e, taskId: string) => bumpTaskPriority(taskId));
ipcMain.handle('dedup:dismissNudge', async (_e, taskId: string) => { await dismissTaskNudge(taskId); return true; });
ipcMain.handle('dedup:listDecisions', async (_e, limit?: number) => listMatchDecisions(limit));
ipcMain.handle('dedup:decisionStats', async () => getMatchDecisionStats());

// People
ipcMain.handle('db:getPeople', async (_e, search) => getPeople(search));
ipcMain.handle('db:getArchivedPeople', async () => getArchivedPeople());
ipcMain.handle('db:getPerson', async (_e, id) => getPerson(id));
ipcMain.handle('db:addPerson', async (_e, data) => addPerson(data));
ipcMain.handle('db:addTrackedPeople', async (_e, names) => addTrackedPeople(names));
ipcMain.handle('db:archivePerson', async (_e, id) => { await archivePerson(id); return true; });
ipcMain.handle('db:unarchivePerson', async (_e, id) => { await unarchivePerson(id); return true; });
ipcMain.handle('db:getSuggestedPeople', async () => getSuggestedPeople());

// AI features
ipcMain.handle('ai:generatePersonInsights', async (_e, personId: string) => {
  const person = await getPerson(personId);
  if (!person) return { bio: null, relationshipInsights: [] };
  const config = getConfig();
  if (!config.apiKey) return { bio: null, relationshipInsights: [] };

  // Build rich context from actual meeting data
  const comms = person.communications || [];
  if (comms.length === 0) return { bio: null, relationshipInsights: [] };

  const meetingContext = comms.slice(0, 5).map((c: any) => {
    let ctx = `- "${c.title}" (${new Date(c.date).toLocaleDateString()})`;
    if (c.summary) ctx += `\n  Summary: ${c.summary}`;
    if (c.keyDecisions?.length) ctx += `\n  Decisions: ${c.keyDecisions.join('; ')}`;
    if (c.actionItems?.length) ctx += `\n  Action items: ${c.actionItems.map((a: any) => a.text).join('; ')}`;
    return ctx;
  }).join('\n');

  const pendingItems = (person.pendingActionItems || []).slice(0, 5);
  const pendingContext = pendingItems.length > 0
    ? `\nOpen action items: ${pendingItems.map((a: any) => a.text).join('; ')}`
    : '';

  const prompt = `Person: ${person.name}${person.role ? `, ${person.role}` : ''}${person.company ? ` at ${person.company}` : ''}.
Total meetings together: ${comms.length}.

Recent meeting details:
${meetingContext}
${pendingContext}

Based on the actual meeting content above, generate:
1. A 2-sentence professional bio summarizing this person's role and your working relationship
2. 3 specific relationship insights based on what was discussed (not generic)

Return JSON: {"bio":"...","relationshipInsights":["...","...","..."]}
Return only valid JSON, no markdown fences.`;

  try {
    const config2 = getConfig();
    let result: any;

    if (config2.apiProvider === 'anthropic') {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic.default({ apiKey: config2.apiKey });
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
      });
      const raw = response.content[0].text;
      result = JSON.parse(raw.replace(/```json/g, '').replace(/```/g, '').trim());
    } else {
      const OpenAI = require('openai');
      const client = new OpenAI.default({ apiKey: config2.apiKey });
      const response = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 512,
      });
      const raw = response.choices[0].message.content;
      result = JSON.parse(raw.replace(/```json/g, '').replace(/```/g, '').trim());
    }

    const bio = result.bio || null;
    const relationshipInsights = result.relationshipInsights || [];
    if (bio) await updatePersonProfile(personId, { bio, relationshipInsights });
    return { bio, relationshipInsights };
  } catch (e: any) {
    log('error', 'ai:generatePersonInsights', e.message);
    return { bio: null, relationshipInsights: [] };
  }
});

ipcMain.handle('ai:generateAgenda', async (_e, personId: string) => {
  try {
    const context = await getPersonAgendaContext(personId);
    if (!context) return { agenda: [] };
    const agenda = await generateAgenda(context);
    return { agenda };
  } catch {
    return { agenda: [] };
  }
});

ipcMain.handle('ai:generateMeetingAgenda', async (_e, title: string, attendees: string[]) => {
  try {
    const context = await getMeetingAgendaContext(title, attendees);
    const agenda = await generateAgenda(context);
    return { agenda };
  } catch {
    return { agenda: [] };
  }
});

ipcMain.handle('ai:searchMeetings', async (_e, query: string) => {
  try {
    const meetings = await getMeetings();
    const answer = await searchMeetings(query, meetings);
    return { ok: true, answer };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('ai:suggestTaskFields', async (_e, data: { title: string; modalType: string; context?: { teamId?: string; task?: any } }) => {
  try {
    const lines: string[] = [];
    let hasData = false;

    // Gather recent meetings (last 10)
    const meetings = await getMeetings();
    const recentMeetings = meetings.slice(0, 10);
    if (recentMeetings.length > 0) {
      hasData = true;
      lines.push('## Recent meetings');
      for (const m of recentMeetings) {
        const date = new Date(m.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        lines.push(`- "${m.title}" (${date})`);
        if (m.insights?.summary) lines.push(`  Summary: ${m.insights.summary}`);
        if (m.insights?.actionItems?.length) {
          lines.push(`  Action items: ${m.insights.actionItems.map((a: any) => `${a.text}${a.owner ? ` (${a.owner})` : ''}`).join(' | ')}`);
        }
      }
    }

    // Gather existing tasks
    const tasks = await getTasks();
    if (tasks.length > 0) {
      hasData = true;
      lines.push('\n## Existing tasks');
      for (const t of tasks.slice(0, 15)) {
        lines.push(`- "${t.title}" [${t.priority}, ${t.status}]${t.dueDate ? ` due ${t.dueDate}` : ''}`);
      }
    }

    // Gather people
    const people = await getPeople();
    if (people.length > 0) {
      hasData = true;
      lines.push('\n## Known people');
      for (const p of people.slice(0, 10)) {
        lines.push(`- ${p.name}${p.role ? ` (${p.role})` : ''}${p.meetingCount ? ` â€” ${p.meetingCount} meetings` : ''}`);
      }
    }

    // Include existing task context if editing
    if (data.modalType === 'editTask' && data.context?.task) {
      const t = data.context.task;
      lines.push('\n## Current task being edited');
      lines.push(`Title: ${t.title}`);
      if (t.description) lines.push(`Description: ${t.description}`);
      if (t.priority) lines.push(`Current priority: ${t.priority}`);
      if (t.status) lines.push(`Current status: ${t.status}`);
      if (t.dueDate) lines.push(`Current due date: ${t.dueDate}`);
    }

    const contextText = lines.length > 0 ? lines.join('\n') : 'No context available â€” suggest reasonable defaults.';

    return await suggestTaskFields(data.title, contextText, hasData);
  } catch (e: any) {
    log('error', 'ai:suggestTaskFields', e.message);
    return {
      suggestions: {
        priority: { value: 'medium', confidence: 0.3, source: 'default (error)' },
        complexity: { value: 'M', confidence: 0.3, source: 'default (error)' },
        dueDate: { value: null, confidence: 0, source: 'no data' },
        assignee: { value: null, confidence: 0, source: 'no data' },
      },
      meta: { hasData: false },
    };
  }
});

// Briefing + Task Scoring
ipcMain.handle('briefing:get', async () => {
  try {
    const config = getConfig();
    const name = config.userName?.trim() || '';

    // Score all tasks
    const tasks = await getTasks();
    const meetings = await getMeetings();
    const people = await getPeople();
    const scored = scoreTasks(tasks, meetings, people);

    // Top 3 non-completed tasks
    const topTasks = scored
      .filter(s => {
        const task = tasks.find((t: any) => t._id === s._id);
        return task && task.status !== 'completed';
      })
      .slice(0, 3)
      .map(s => {
        const task = tasks.find((t: any) => t._id === s._id);
        return { ...task, priorityScore: s.score, priorityReasoning: s.reasoning };
      });

    // Overdue commitments
    const overdueCommitments = await getOverdueCommitments();

    return {
      greeting: name ? `Hi, ${name}` : 'Hi',
      topTasks,
      overdueCommitments: overdueCommitments.slice(0, 5),
      totalTasks: tasks.filter((t: any) => t.status !== 'completed').length,
    };
  } catch (e: any) {
    log('error', 'briefing:get', e.message);
    return { greeting: 'Hi', topTasks: [], overdueCommitments: [], totalTasks: 0 };
  }
});

ipcMain.handle('tasks:scored', async () => {
  try {
    const tasks = await getTasks();
    const meetings = await getMeetings();
    const people = await getPeople();
    const scored = scoreTasks(tasks, meetings, people);

    const getSuggestedPriority = (score: number) => {
      if (score >= 75) return 'critical';
      if (score >= 50) return 'high';
      if (score >= 25) return 'medium';
      return 'low';
    };

    const taskMap = new Map(tasks.map((t: any) => [t._id, t]));
    const scoredTasks = scored.map(s => {
      const task = taskMap.get(s._id) || {} as any;
      return {
        ...s,
        title: task.title || '',
        status: task.status || 'todo',
        priority: task.priority || 'medium',
        suggestedPriority: getSuggestedPriority(s.score),
        urgency: getSuggestedPriority(s.score)
      };
    });

    const priorityChanges = scoredTasks.filter(t => t.suggestedPriority !== t.priority);
    return { scoredTasks, priorityChanges };
  } catch (e: any) {
    log('error', 'tasks:scored', e.message);
    return { scoredTasks: [], priorityChanges: [] };
  }
});

// Voice Prints
ipcMain.handle('voiceprint:save', async (_e, data: { name: string; audioClip: Buffer; isUser: boolean }) => {
  try {
    // Compute MFCC embedding from the audio clip
    let embedding: number[] | undefined;
    try {
      const samples = wavBufferToSamples(Buffer.from(data.audioClip));
      const emb = computeVoiceEmbedding(samples, 16000);
      embedding = Array.from(emb);
      log('info', 'voiceprint:embedding', `computed ${embedding.length}-dim embedding for "${data.name}"`);
    } catch (embErr: any) {
      log('error', 'voiceprint:embedding-failed', embErr.message);
    }

    const id = await saveVoicePrint({ ...data, embedding });
    // If this is the user's voice, also save their name to config
    if (data.isUser && data.name) {
      setConfig({ userName: data.name });
    }
    return { ok: true, id };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('voiceprint:list', async () => getVoicePrints());

ipcMain.handle('voiceprint:delete', async (_e, id: string) => {
  await deleteVoicePrint(id);
  return true;
});

ipcMain.handle('voiceprint:get-audio', async (_e, id: string) => {
  const vp = await getVoicePrint(id);
  if (!vp || !vp.audioClip) return null;
  // NeDB may store audioClip as Buffer, Uint8Array, or plain object with numeric keys
  // Normalize to Uint8Array for IPC transfer
  let clip: Uint8Array;
  if (Buffer.isBuffer(vp.audioClip)) {
    clip = new Uint8Array(vp.audioClip);
  } else if (vp.audioClip instanceof Uint8Array) {
    clip = vp.audioClip;
  } else if (vp.audioClip.type === 'Buffer' && Array.isArray(vp.audioClip.data)) {
    // NeDB JSON serialization: {type: "Buffer", data: [bytes...]}
    clip = new Uint8Array(vp.audioClip.data);
  } else {
    // Last resort: treat as array-like
    clip = new Uint8Array(Object.values(vp.audioClip) as number[]);
  }
  return { audioClip: clip, name: vp.name };
});

ipcMain.handle('voiceprint:rename', async (_e, id: string, name: string) => {
  await renameVoicePrint(id, name);
  return { success: true };
});

// ── Popup window controls ────────────────────────────────────────────────────
ipcMain.handle('popup:pin', (_e, pinned: boolean) => {
  popupPinned = !!pinned;
  log('info', 'popup:pin', `pinned=${popupPinned}`);
});

ipcMain.handle('window:hide', () => {
  mainWindow?.hide();
});

ipcMain.handle('app:quit', () => {
  app.quit();
});

ipcMain.handle('app:version', () => app.getVersion());

const UPDATE_REPO = 'Wise-Ai-Org/inwise-opensource';

ipcMain.handle('app:check-for-updates', async () => {
  const current = app.getVersion();
  try {
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return { current, error: `GitHub returned ${res.status}` };
    const json = await res.json() as { tag_name?: string; html_url?: string };
    const latest = (json.tag_name || '').replace(/^v/i, '');
    if (!latest) return { current, error: 'No release tag found' };
    return {
      current,
      latest,
      upToDate: latest === current,
      url: json.html_url || `https://github.com/${UPDATE_REPO}/releases/latest`,
    };
  } catch (err: any) {
    return { current, error: err?.message || 'Could not reach GitHub' };
  }
});

ipcMain.handle('review-window:open', (_e, meetingId: string, initialTab?: string) => {
  createReviewWindow(meetingId, initialTab);
});

ipcMain.handle('voiceprint:get-user', async () => {
  const vp = await getUserVoicePrint();
  if (!vp) return null;
  return { _id: vp._id, name: vp.name, isUser: true, createdAt: vp.createdAt, hasAudio: !!vp.audioClip };
});

// Jira
ipcMain.handle('jira:connect', async () => connectJira());
ipcMain.handle('jira:disconnect', () => { disconnectJira(); return true; });
ipcMain.handle('jira:status', () => {
  return { connected: isJiraConnected(), info: getJiraInfo() };
});
ipcMain.handle('jira:getProjects', async () => {
  try { return { ok: true, projects: await getJiraProjects() }; }
  catch (e: any) { return { ok: false, error: e.message }; }
});
ipcMain.handle('jira:getStories', async (_e, projectKey?: string) => {
  try { return { ok: true, stories: await getJiraStories(projectKey) }; }
  catch (e: any) { return { ok: false, error: e.message }; }
});
ipcMain.handle('jira:createIssue', async (_e, task: any) => {
  try {
    const result = await createJiraIssue(task);
    // Update the task in DB with jira source info
    if (task._id) {
      await updateTask(task._id, {
        'source': { type: 'jira', id: result.key, url: result.url },
      });
    }
    return { ok: true, ...result };
  } catch (e: any) { return { ok: false, error: e.message }; }
});
ipcMain.handle('jira:updateIssue', async (_e, issueKey: string, updates: any) => {
  try { await updateJiraIssue(issueKey, updates); return { ok: true }; }
  catch (e: any) { return { ok: false, error: e.message }; }
});
ipcMain.handle('jira:transition', async (_e, issueKey: string, status: string) => {
  try { await transitionJiraIssue(issueKey, status); return { ok: true }; }
  catch (e: any) { return { ok: false, error: e.message }; }
});
ipcMain.handle('jira:addComment', async (_e, issueKey: string, comment: string, meetingTitle?: string) => {
  try { await addJiraComment(issueKey, comment, meetingTitle); return { ok: true }; }
  catch (e: any) { return { ok: false, error: e.message }; }
});
ipcMain.handle('jira:linkTask', async (_e, taskId: string, jiraKey: string, jiraUrl: string) => {
  try {
    await updateTask(taskId, {
      source: { type: 'jira', id: jiraKey, url: jiraUrl },
    });
    return { ok: true };
  } catch (e: any) { return { ok: false, error: e.message }; }
});
ipcMain.handle('jira:matchTasks', async (_e, items: any[], projectKey?: string) => {
  try {
    const stories = await getJiraStories(projectKey);
    const localMatches = matchAllItems(items, stories);

    // Enhance with LLM semantic matching
    const llmMatches = await semanticMatch(items, stories);
    for (let i = 0; i < localMatches.length; i++) {
      const llmKey = llmMatches[String(i + 1)];
      if (llmKey && !localMatches[i].autoApproved) {
        const story = stories.find(s => s.jiraKey === llmKey);
        if (story) {
          // Boost the LLM-matched candidate or add it
          const existing = localMatches[i].candidates.find(c => c.jiraKey === llmKey);
          if (existing) {
            existing.similarity = Math.max(existing.similarity, 0.80);
          } else {
            localMatches[i].candidates.unshift({
              jiraKey: story.jiraKey,
              title: story.title,
              similarity: 0.80,
              matchFactors: { keyMention: 0, keywords: 0, title: 0 },
              jiraUrl: story.jiraUrl,
            });
          }
          localMatches[i].bestMatch = localMatches[i].candidates[0];
        }
      }
    }

    return { ok: true, matches: localMatches, stories };
  } catch (e: any) { return { ok: false, error: e.message }; }
});

// Zoom
ipcMain.handle('zoom:saveCredentials', async (_e, clientId: string, clientSecret: string) => {
  try { await saveZoomCredentials(clientId, clientSecret); return { ok: true }; }
  catch (e: any) { return { ok: false, error: e.message }; }
});
ipcMain.handle('zoom:connect', async () => {
  try { return await connectZoom(); }
  catch (e: any) { return { ok: false, error: e.message }; }
});
ipcMain.handle('zoom:disconnect', async () => {
  try { await disconnectZoom(); return { ok: true }; }
  catch (e: any) { return { ok: false, error: e.message }; }
});
ipcMain.handle('zoom:status', async () => {
  try { return await getZoomStatus(); }
  catch (e: any) { return { connected: false }; }
});
ipcMain.handle('zoom:test', async () => {
  try { return await testZoomConnection(); }
  catch (e: any) { return { ok: false, error: e.message }; }
});
ipcMain.handle('zoom:redirectUri', () => ZOOM_REDIRECT_URI_DISPLAY);
ipcMain.handle('zoom:listRecordings', async () => {
  try {
    const status = await getZoomStatus();
    if (!status.connected) {
      return { ok: false, error: 'Not connected to Zoom. Connect in Settings → Zoom Integration first.' };
    }
    const recordings = await listZoomRecordings();
    return { ok: true, recordings };
  } catch (e: any) { return { ok: false, error: e.message }; }
});
ipcMain.handle('zoom:fetchTranscript', async (_e, recording: { meetingId: string; uuid: string; title: string; startedAt: string }) => {
  try {
    const transcriptResult = await getTranscriptDownloadUrl(recording.uuid);
    if (!transcriptResult.found) {
      return { ok: false, error: transcriptResult.reason };
    }
    const nt = await downloadAndParseVtt(
      transcriptResult.downloadUrl,
      transcriptResult.accessToken,
      recording.meetingId,
      recording.title,
      recording.startedAt,
    );
    nt.externalId = recording.uuid;
    nt.sourceMetadata = {
      zoomMeetingId: recording.meetingId,
      zoomUuid: recording.uuid,
    };
    const meetingId = await ingestNormalizedTranscript(nt);
    return { ok: true, meetingId };
  } catch (e: any) { return { ok: false, error: e.message }; }
});

// Microsoft Teams native transcripts
ipcMain.handle('teams:saveCredentials', async (_e, clientId: string, tenant?: string) => {
  try { await saveTeamsCredentials(clientId, tenant); return { ok: true }; }
  catch (e: any) { return { ok: false, error: e.message }; }
});
ipcMain.handle('teams:connect', async () => {
  try { return await connectTeams(); }
  catch (e: any) { return { ok: false, error: e.message }; }
});
ipcMain.handle('teams:disconnect', async () => {
  try { await disconnectTeams(); return { ok: true }; }
  catch (e: any) { return { ok: false, error: e.message }; }
});
ipcMain.handle('teams:status', async () => {
  try { return await getTeamsStatus(); }
  catch { return { connected: false }; }
});
ipcMain.handle('teams:test', async () => {
  try { return await testTeamsConnection(); }
  catch (e: any) { return { ok: false, error: e.message }; }
});
ipcMain.handle('teams:redirectUri', () => TEAMS_REDIRECT_URI_DISPLAY);
ipcMain.handle('teams:listMeetings', async () => {
  try {
    if (!(await getTeamsStatus()).connected) {
      return { ok: false, error: 'Not connected to Microsoft Teams. Connect in Settings first.' };
    }
    return { ok: true, meetings: await listTeamsMeetings() };
  } catch (e: any) { return { ok: false, error: e.message }; }
});
ipcMain.handle('teams:fetchTranscript', async (_e, meeting) => {
  try {
    const artifact = await fetchTeamsTranscriptArtifact(meeting);
    const normalized = parseTeamsVtt(artifact);
    if (normalized.segments.length === 0) {
      return { ok: false, error: 'Microsoft returned an empty or unsupported Teams transcript.' };
    }
    const meetingId = await ingestNormalizedTranscript(normalized, { source: 'teams_transcript' });
    return { ok: true, meetingId, speakerAttributed: artifact.speakerAttributed };
  } catch (e: any) { return { ok: false, error: e.message }; }
});

// Google Meet native transcripts
ipcMain.handle('meet:saveCredentials', async (_e, clientId: string, clientSecret: string) => {
  try { await saveMeetCredentials(clientId, clientSecret); return { ok: true }; }
  catch (e: any) { return { ok: false, error: e.message }; }
});
ipcMain.handle('meet:connect', async () => {
  try { return await connectMeet(); }
  catch (e: any) { return { ok: false, error: e.message }; }
});
ipcMain.handle('meet:disconnect', async () => {
  try { await disconnectMeet(); return { ok: true }; }
  catch (e: any) { return { ok: false, error: e.message }; }
});
ipcMain.handle('meet:status', async () => {
  try { return await getMeetStatus(); }
  catch { return { connected: false }; }
});
ipcMain.handle('meet:test', async () => {
  try { return await testMeetConnection(); }
  catch (e: any) { return { ok: false, error: e.message }; }
});
ipcMain.handle('meet:redirectUri', () => MEET_REDIRECT_URI_DISPLAY);
ipcMain.handle('meet:listMeetings', async () => {
  try {
    if (!(await getMeetStatus()).connected) {
      return { ok: false, error: 'Not connected to Google Meet. Connect in Settings first.' };
    }
    return { ok: true, meetings: await listMeetConferenceRecords() };
  } catch (e: any) { return { ok: false, error: e.message }; }
});
ipcMain.handle('meet:fetchTranscript', async (_e, conference) => {
  try {
    const normalized = await fetchMeetTranscript(conference);
    const meetingId = await ingestNormalizedTranscript(normalized, { source: 'meet_transcript' });
    return { ok: true, meetingId };
  } catch (e: any) { return { ok: false, error: e.message }; }
});

// SoR audit log (US-001)
ipcMain.handle('sor:listRecent', async (_e, limit?: number, sinceMs?: number) => {
  return sorListRecent(limit ?? 50, sinceMs);
});
ipcMain.handle('sor:listByMeeting', async (_e, meetingId: string) => {
  return sorListByMeeting(meetingId);
});
ipcMain.handle('sor:listByTaskId', async (_e, taskId: string) => {
  return sorListByTaskId(taskId);
});
ipcMain.handle('sor:listByTargetRecord', async (_e, system: 'jira', recordId: string) => {
  return sorListByTargetRecord(system, recordId);
});
ipcMain.handle('sor:aggregateByIntegration', async (_e, sinceMs?: number) => {
  return sorAggregateByIntegration(sinceMs);
});
ipcMain.handle('sor:retry', async (_e, id: string) => {
  const entry = await sorGetWriteEntry(id);
  if (!entry) return { ok: false, error: 'Entry not found' };
  if (entry.targetSystem === 'jira') return retryJiraWrite(id);
  return { ok: false, error: `Retry not supported for ${entry.targetSystem}` };
});
ipcMain.handle('sor:listFailed', async (_e, system: 'jira', sinceMs: number) => {
  return sorListFailedSince(system, sinceMs);
});
ipcMain.handle('sor:retryFailed', async (_e, system: 'jira', sinceMs: number) => {
  const failed = await sorListFailedSince(system, sinceMs);
  let succeeded = 0;
  let stillFailed = 0;
  for (const entry of failed) {
    try {
      const result = system === 'jira' ? await retryJiraWrite(entry._id) : { ok: false as const };
      if (result.ok) succeeded += 1;
      else stillFailed += 1;
    } catch {
      stillFailed += 1;
    }
  }
  return { ok: true, attempted: failed.length, succeeded, failed: stillFailed };
});

// â”€â”€ Pending approvals (US-006) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

ipcMain.handle('sor:listPendingApprovals', async () => {
  const pending = await listPending();
  const rows: Array<{ writeEntry: any; pending: any }> = [];
  for (const p of pending) {
    const writeEntry = await sorGetWriteEntry(p._id);
    // Only surface entries where both collections agree. A missing writeEntry
    // would mean the pending queue is stale â€” skip instead of crashing.
    if (writeEntry && writeEntry.result === 'pending-approval') {
      rows.push({ writeEntry, pending: p });
    }
  }
  return rows;
});

interface ApprovalOverrides {
  // create-op override fields â€” only applied when pending.pushParams.operation === 'create'
  title?: string;
  description?: string;
  priority?: string;
  dueDate?: string;
  // comment-op override
  comment?: string;
  // update-op override (rare from the auto-push path but supported for completeness)
  updates?: { title?: string; description?: string; priority?: string; dueDate?: string };
}

ipcMain.handle('sor:approve', async (
  _e,
  id: string,
  overrides?: ApprovalOverrides,
): Promise<{ ok: boolean; error?: string }> => {
  const pending = await getPending(id);
  if (!pending) return { ok: false, error: 'No pending approval for that id' };
  const writeEntry = await sorGetWriteEntry(id);
  if (!writeEntry) return { ok: false, error: 'Audit entry missing' };

  // Apply overrides to pushParams and update the audit entry's display payload
  // so the receipts UI reflects what was actually pushed.
  let pushParams = pending.pushParams;
  let fieldDiffsUpdate: Array<{ field: string; before: any; after: any }> | undefined;
  let commentBodyUpdate: string | null | undefined;

  if (overrides) {
    if (pushParams.operation === 'create') {
      const merged = {
        ...pushParams.args,
        ...(overrides.title !== undefined ? { title: overrides.title } : {}),
        ...(overrides.description !== undefined ? { description: overrides.description } : {}),
        ...(overrides.priority !== undefined ? { priority: overrides.priority } : {}),
        ...(overrides.dueDate !== undefined ? { dueDate: overrides.dueDate } : {}),
      };
      pushParams = { operation: 'create', args: merged };
      fieldDiffsUpdate = sorComputeCreateDiffs(merged);
    } else if (pushParams.operation === 'comment' && overrides.comment !== undefined) {
      pushParams = {
        operation: 'comment',
        args: { ...pushParams.args, comment: overrides.comment },
      };
      const prefix = pending.meetingTitle
        ? `[Inwise] From "${pending.meetingTitle}":\n\n`
        : '[Inwise]\n\n';
      commentBodyUpdate = prefix + overrides.comment;
    } else if (pushParams.operation === 'update' && overrides.updates) {
      pushParams = {
        operation: 'update',
        args: { ...pushParams.args, updates: { ...pushParams.args.updates, ...overrides.updates } },
      };
    }
  }

  await sorApplyApprovalEdit(id, {
    fieldDiffs: fieldDiffsUpdate,
    commentBody: commentBodyUpdate,
    pushParams,
    approvalPath: 'user',
    result: 'pending',
  });

  // Dispatch the push. approveJiraWrite owns markCompleted, so we don't need
  // to re-stamp the entry on success/failure â€” the audit log stays accurate.
  const res = await approveJiraWrite(id, pushParams);

  // Remove the pending-approvals row regardless of outcome â€” the sor-writes
  // entry is now either 'success' (receipt feed) or 'failed' (retry button
  // via sor:retry uses the same stored pushParams). Keeping a stale pending
  // row would hide it from the pending-approvals surface anyway (filtered by
  // writeEntry.result), so drop it unconditionally.
  await removePending(id);

  if (res.ok) {
    // Patch the linked local task's source field now that Jira knows about it.
    if (pending.linkedTaskId && res.key) {
      try {
        await updateTask(pending.linkedTaskId, {
          source: { type: 'jira', id: res.key, url: res.url ?? undefined },
        });
      } catch (err: any) {
        // Task may have been deleted between gating and approval â€” log but
        // don't fail the approval, the Jira write itself succeeded.
        log('warn', 'sor:approve-task-patch-failed', err.message);
      }
    }
    return { ok: true };
  }

  return { ok: false, error: res.error };
});

ipcMain.handle('sor:reject', async (_e, id: string): Promise<{ ok: boolean; error?: string }> => {
  const pending = await getPending(id);
  if (!pending) return { ok: false, error: 'No pending approval for that id' };
  await sorMarkCompleted(id, 'failed', 'User rejected');
  await removePending(id);
  return { ok: true };
});

// Recording
// People the user tagged on the pre-record sheet for an ad-hoc recording (no
// calendar event). Consumed by flushPendingAudio so the created meeting carries
// them as attendees — which routes insights to their person pages and feeds the
// voice-enrollment cascade.
let adHocAttendees: string[] = [];

ipcMain.handle('recording:start', (_e, title: string, calendarEventId?: string, attendees?: string[]) => {
  adHocAttendees = Array.isArray(attendees) ? attendees.filter(Boolean) : [];
  createOverlayWindow(title, calendarEventId);
  updateTrayMenu(mainWindow!, true);
  isRecordingActive = true;
  lastMicFailureNotifiedAt = 0;
  lastSysAudioFailureNotifiedAt = 0;
  lastRecordingSilenceNotifiedAt = 0;
  mainWindow?.webContents.send('recording:status', { status: 'recording', title });
  return true;
});

ipcMain.handle('recording:stop', async () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('recording:stop-request');
  }
  return true;
});

ipcMain.handle('recording:state', () => ({ active: isRecordingActive }));

// ── Recorder pill ──────────────────────────────────────────────────────────

// Renderer drives window width (hover expand/collapse); position stays anchored.
ipcMain.on('pill:resize', (e, { width, height }: { width: number; height?: number }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  const bounds = win.getBounds();
  win.setBounds({
    x,
    y,
    width: Math.max(120, Math.round(width) || bounds.width),
    height: Math.max(48, Math.round(height ?? bounds.height)),
  });
});

// User clicked the pill during preflight/countdown — abort before recording starts.
ipcMain.on('pill:cancelled', () => {
  isRecordingActive = false;
  lastRecordingSilenceNotifiedAt = 0;
  updateTrayMenu(mainWindow!, false);
  // Re-arm calendar-free VAD in the main window (it waits for a terminal status).
  mainWindow?.webContents.send('recording:status', { status: 'done' });
  maybeCloseOverlay(150);
});

// Right-click menu: the pill's attribution ("whose widget is this") and the
// fix-it-here surface — switch devices without opening the main app.
// Menu icons: green dot = device checked out working, red = not. 16px PNGs,
// generated offline (native menus can't render colored text).
const DOT_GREEN = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAVElEQVR42mNQOhrHQAlmoJUBCkpH4xKA7AYorUCKASBN/7HgBmIMwKUZpyHozv5PBFbAZUACkQYk4DKggUgDGmjmAorDgOJYoEo6oEpKHByZiWgMANUlk8sF9YQFAAAAAElFTkSuQmCC');
const DOT_RED = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAVElEQVR42mN47+LCQAlmoJUBCu9dXBKA7AYorUCKASBN/7HgBmIMwKUZpyHozv5PBFbAZUACkQYk4DKggUgDGmjmAorDgOJYoEo6oEpKHByZiWgMAGsuxcvReI2kAAAAAElFTkSuQmCC');

ipcMain.on('pill:context-menu', (e, payload: {
  mics: { id: string; label: string }[];
  speakers: { id: string; label: string }[];
  micOk?: boolean;
  spkOk?: boolean;
  recording: boolean;
  title?: string;
}) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const cfg = getConfig();
  const currentMic = cfg.micDeviceId || 'default';
  const currentSpeaker = cfg.speakerDeviceId || 'default';
  const statusDot = (ok?: boolean) => (ok === undefined ? undefined : ok ? DOT_GREEN : DOT_RED);

  const deviceItems = (
    devices: { id: string; label: string }[],
    current: string,
    onPick: (id: string) => void,
  ): Electron.MenuItemConstructorOptions[] => {
    if (!devices.length) return [{ label: 'No devices found', enabled: false }];
    return devices.map(d => ({
      label: d.label,
      type: 'radio' as const,
      checked: d.id === current || (current === 'default' && d.id === 'default'),
      click: () => onPick(d.id),
    }));
  };

  const template: Electron.MenuItemConstructorOptions[] = [
    { label: 'Inwise · saved on-device', enabled: false },
    ...(payload.title ? [{ label: payload.title.length > 28 ? payload.title.slice(0, 27) + '…' : payload.title, enabled: false }] : []),
    { type: 'separator' },
    {
      label: 'Open Inwise',
      click: () => { mainWindow?.show(); mainWindow?.focus(); },
    },
    {
      label: 'Microphone',
      icon: statusDot(payload.micOk),
      submenu: deviceItems(payload.mics || [], currentMic, (id) => {
        setConfig({ micDeviceId: id });
        // Live swap if a recording is in flight; otherwise the next one picks it up.
        win?.webContents.send('pill:switch-mic', id);
      }),
    },
    {
      label: 'Speaker',
      icon: statusDot(payload.spkOk),
      submenu: deviceItems(payload.speakers || [], currentSpeaker, (id) => {
        setConfig({ speakerDeviceId: id });
      }),
    },
    { type: 'separator' },
    {
      label: 'Settings',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
        mainWindow?.webContents.send('app:navigate', 'settings');
      },
    },
    ...(payload.recording ? [
      { type: 'separator' as const },
      {
        label: 'Stop recording',
        click: () => { win?.webContents.send('recording:stop-request'); },
      },
    ] : []),
  ];

  Menu.buildFromTemplate(template).popup({ window: win ?? undefined });
});

// "Saved — open Inwise" click on the pill after a transcription lands.
ipcMain.on('pill:open-inwise', () => {
  mainWindow?.show();
  mainWindow?.focus();
});

ipcMain.on('audio:health', (_e, payload: AudioHealth) => {
  if (!payload || typeof payload.micOk !== 'boolean' || typeof payload.systemAudioOk !== 'boolean') return;
  const prev = latestAudioHealth;
  const next: AudioHealth = { micOk: payload.micOk, systemAudioOk: payload.systemAudioOk, message: payload.message };
  latestAudioHealth = next;
  mainWindow?.webContents.send('audio:health', next);

  if (!isRecordingActive || !Notification.isSupported()) return;
  const now = Date.now();
  if (prev?.micOk === true && next.micOk === false && now - lastMicFailureNotifiedAt > AUDIO_HEALTH_NOTIFY_DEBOUNCE_MS) {
    lastMicFailureNotifiedAt = now;
    new Notification({
      title: 'Microphone lost',
      body: next.message || 'Microphone unavailable â€” the rest of this meeting will not be transcribed.',
    }).show();
  }
  if (prev?.systemAudioOk === true && next.systemAudioOk === false && now - lastSysAudioFailureNotifiedAt > AUDIO_HEALTH_NOTIFY_DEBOUNCE_MS) {
    lastSysAudioFailureNotifiedAt = now;
    new Notification({
      title: 'System audio lost',
      body: next.message || 'System audio lost â€” only your mic will be transcribed for the rest of this meeting.',
    }).show();
  }
});

ipcMain.on('recording:silence-check-in', (event, payload: { title?: string; silenceMs?: number }) => {
  if (!isRecordingActive || !Notification.isSupported()) return;
  if (!overlayWindow || overlayWindow.isDestroyed() || event.sender.id !== overlayWindow.webContents.id) return;

  const now = Date.now();
  if (now - lastRecordingSilenceNotifiedAt < RECORDING_SILENCE_NOTIFY_DEBOUNCE_MS) return;
  lastRecordingSilenceNotifiedAt = now;

  const rawTitle = typeof payload?.title === 'string' ? payload.title.trim() : '';
  const recordingTitle = rawTitle.slice(0, 120) || 'This recording';
  const notification = new Notification({
    title: 'Are you still there?',
    body: `"${recordingTitle}" has been quiet for five minutes. Inwise is still recording.`,
    actions: [
      { type: 'button', text: 'Keep recording' },
      { type: 'button', text: 'Stop & save' },
    ],
  });

  const showRecorder = () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    overlayWindow.show();
    overlayWindow.focus();
  };
  notification.on('action', (_event, index) => {
    if (index === 1 && overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('recording:stop-request');
      return;
    }
    showRecorder();
  });
  notification.on('click', showRecorder);
  notification.show();
  log('info', 'recording:silence-check-in', `notified for "${recordingTitle}"`);
});

ipcMain.handle('audio:health:get', () => latestAudioHealth);

ipcMain.handle('welcomeBack:compute', async () => {
  let openAtLogin = false;
  try {
    openAtLogin = app.getLoginItemSettings().openAtLogin;
  } catch {
    openAtLogin = false;
  }
  const tasks = await getTasks({ includeSnoozed: true });
  const meetings = await getMeetings();
  return computeWelcomeBack({
    now: new Date(),
    daysSinceLastOpen: getDaysSinceLastOpen(),
    lastOpenedAtSnapshot: getLastOpenedAtSnapshot(),
    welcomeBackLastSeenAt: getWelcomeBackLastSeenAt(),
    openAtLogin,
    lastSweepResult: getLastSweepResult(),
    tasks,
    meetings,
    upcomingEvents: calendarWatcher.getUpcomingEvents(),
  });
});

ipcMain.handle('welcomeBack:dismiss', () => {
  markWelcomeBackSeen();
  return true;
});

ipcMain.handle('welcomeBack:liveMeeting', () => {
  return findLiveMeetingForBanner({
    events: calendarWatcher.getUpcomingEvents(),
    now: new Date(),
    isRecordingActive,
    overlayWindowOpen: !!(overlayWindow && !overlayWindow.isDestroyed()),
  });
});

ipcMain.handle('app:setLoginItemOpenAtLogin', (_e, enabled: boolean) => {
  try {
    app.setLoginItemSettings(createLoginItemRegistration(process.platform, !!enabled));
    markAutostartConfigured();
    log('info', 'login-item', `openAtLogin=${!!enabled}`);
    return { ok: true };
  } catch (err) {
    log('error', 'login-item', `setLoginItemSettings failed: ${String(err)}`);
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('app:getLoginItemSettings', () => {
  try {
    return { openAtLogin: app.getLoginItemSettings().openAtLogin };
  } catch {
    return { openAtLogin: false };
  }
});

// ── Daily plan IPC ───────────────────────────────────────────────────────────

ipcMain.handle('dailyPlan:get', async () => {
  const config = getConfig();
  const now = new Date();
  try {
    const events = selectTodaysMeetings(calendarWatcher.getUpcomingEvents(), now);
    const [tasks, meetings, people] = await Promise.all([getTasks(), getMeetings(), getPeople()]);

    // Agendas are only drafted when local history gives the model something
    // real to draw on (shared attendee or recurring title) — max 3 AI calls.
    const agendaTargets = config.apiKey
      ? events.filter((ev) => ev.attendees.length > 0 && hasAgendaHistory(meetings, ev)).slice(0, 3)
      : [];
    const agendaById = new Map<string, string[]>();
    await Promise.all(agendaTargets.map(async (ev) => {
      try {
        const context = await getMeetingAgendaContext(ev.title, ev.attendees);
        agendaById.set(ev.id, await generateAgenda(context));
      } catch {
        agendaById.set(ev.id, []);
      }
    }));

    const scored = scoreTasks(tasks, meetings, people);
    const taskMap = new Map(tasks.map((t: any) => [t._id, t]));
    const topTasks = scored
      .filter((s) => {
        const t: any = taskMap.get(s._id);
        return t && t.status !== 'completed';
      })
      .slice(0, 5)
      .map((s) => {
        const t: any = taskMap.get(s._id);
        return {
          id: s._id,
          title: t.title,
          priority: t.priority || 'medium',
          dueDate: t.dueDate || null,
          reasoning: s.reasoning,
        };
      });

    return {
      greeting: buildGreeting(now, config.userName?.trim() || ''),
      meetings: events.map((ev) => ({
        id: ev.id,
        title: ev.title,
        startTime: ev.startTime.getTime(),
        endTime: ev.endTime.getTime(),
        attendees: ev.attendees,
        agenda: (agendaById.get(ev.id) || []).slice(0, 4),
      })),
      tasks: topTasks,
      hasApiKey: !!config.apiKey,
    };
  } catch (e: any) {
    log('error', 'dailyPlan:get', e.message);
    return {
      greeting: buildGreeting(now, config.userName?.trim() || ''),
      meetings: [],
      tasks: [],
      hasApiKey: !!config.apiKey,
    };
  }
});

ipcMain.on('dailyPlan:dismiss', () => {
  if (dailyPlanWindow && !dailyPlanWindow.isDestroyed()) dailyPlanWindow.close();
});

ipcMain.on('dailyPlan:open-inwise', () => {
  mainWindow?.show();
  mainWindow?.focus();
  if (dailyPlanWindow && !dailyPlanWindow.isDestroyed()) dailyPlanWindow.close();
});

ipcMain.on('renderer:unhandled-rejection', (_e, payload: { name?: string; message?: string; stack?: string; source?: string }) => {
  const name = payload?.name || 'UnhandledRejection';
  const message = payload?.message || '(no message)';
  const source = payload?.source ? ` source=${payload.source}` : '';
  log('error', 'renderer:unhandled-rejection', `${name}: ${message}${source}`);
});

// Segments of the same meeting can arrive in quick succession (duplicate badge
// windows, VAD splits). Hold buffers briefly and stitch them into one WAV so a
// single meeting is processed once instead of as fragments.
const AUDIO_COALESCE_MS = 10_000;
const pendingAudio = new Map<string, { buffers: Buffer[]; title: string; calendarEventId?: string; stereo?: boolean; timer: NodeJS.Timeout }>();

ipcMain.on('recording:audio-data', (_e, { buffer, title, calendarEventId, stereo }: { buffer: Buffer; title: string; calendarEventId?: string; stereo?: boolean }) => {
  log('info', 'audio-data:received', `title="${title}" size=${buffer?.length ?? 0} stereo=${!!stereo}`);
  isRecordingActive = false;
  lastRecordingSilenceNotifiedAt = 0;
  mainWindow?.webContents.send('recording:status', { status: 'processing', title });
  const key = `${title}|${stereo ? 1 : 0}`;
  const entry = pendingAudio.get(key);
  if (entry) {
    entry.buffers.push(Buffer.from(buffer));
    if (calendarEventId && !entry.calendarEventId) entry.calendarEventId = calendarEventId;
    entry.timer.refresh();
    log('info', 'audio-data:coalesced', `title="${title}" segments=${entry.buffers.length}`);
    return;
  }
  const timer = setTimeout(() => { void flushPendingAudio(key); }, AUDIO_COALESCE_MS);
  pendingAudio.set(key, { buffers: [Buffer.from(buffer)], title, calendarEventId, stereo, timer });
});

// Transcriptions run strictly one at a time: whisper is CPU-heavy and two
// concurrent runs mid-meeting would chew into the call itself.
let pipelineChain: Promise<unknown> = Promise.resolve();

async function flushPendingAudio(key: string): Promise<void> {
  const entry = pendingAudio.get(key);
  if (!entry) return;
  pendingAudio.delete(key);
  try {
    const recordingsDir = path.join(app.getPath('userData'), 'recordings');
    if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });
    const wav = stitchWavBuffers(entry.buffers);
    if (entry.buffers.length > 1) {
      log('info', 'audio-data:stitched', `title="${entry.title}" segments=${entry.buffers.length} size=${wav.length}`);
    }
    const tmpPath = path.join(recordingsDir, `inwise-rec-${Date.now()}.wav`);
    fs.writeFileSync(tmpPath, wav);
    updateTrayMenu(mainWindow!, false);
    // Attendees: calendar event first; for ad-hoc recordings, the people the
    // user tagged on the pre-record sheet. Merged so a linked event plus extra
    // tagged people keeps both.
    const calendarAttendees = entry.calendarEventId
      ? calendarWatcher.getUpcomingEvents().find((e: any) => e.id === entry.calendarEventId)?.attendees || []
      : [];
    const attendees = [...new Set([...calendarAttendees, ...adHocAttendees])];
    adHocAttendees = [];

    const jobId = path.basename(tmpPath);
    activePipelineJobs++;
    emitSecondary({ jobId, title: entry.title, state: 'transcribing' });
    pipelineChain = pipelineChain
      .then(() => runRecordingPipeline(tmpPath, entry.title, entry.calendarEventId, entry.stereo, attendees, jobId))
      .then((ok) => {
        activePipelineJobs--;
        // Failed jobs hold the pill longer so the red state is actually seen;
        // successes hold long enough to read the "open Inwise" invite.
        maybeCloseOverlay(ok === false ? 8000 : 6500);
      })
      .catch((e: any) => {
        activePipelineJobs--;
        log('error', 'audio-data:pipeline-failed', e?.message || String(e));
        emitSecondary({ jobId, title: entry.title, state: 'error', message: e?.message || 'Pipeline failed' });
        maybeCloseOverlay(8000);
      });
    await pipelineChain;
  } catch (e: any) {
    log('error', 'audio-data:failed', e.message);
  }
}

// â”€â”€ Calendar watcher â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

calendarWatcher.on('events-updated', async (events: any[]) => {
  mainWindow?.webContents.send('calendar:events', events.map(e => ({
    ...e,
    startTime: e.startTime instanceof Date ? e.startTime.getTime() : e.startTime,
    endTime: e.endTime instanceof Date ? e.endTime.getTime() : e.endTime,
  })));

  // Persist past calendar events to meetingsDb so they appear in suggested people, etc.
  try {
    const { created, updated } = await syncCalendarEventsToDb(events);
    if (created > 0 || updated > 0) {
      log('info', 'calendar-sync', `Synced calendar â†’ meetingsDb: ${created} created, ${updated} updated`);
    }
  } catch (e: any) {
    log('error', 'calendar-sync', `Failed to sync calendar events to DB: ${e.message}`);
  }
});

calendarWatcher.on('meeting-starting', (event: MeetingEvent) => {
  const now = Date.now();

  // Same event announced again while its recording is already live (re-poll,
  // duplicate calendar entry) — one recorder per event, ignore the repeat.
  if (isRecordingActive && lastMeetingStarting && lastMeetingStarting.event.id === event.id) {
    log('info', 'calendar-watcher:meeting-starting', `already recording "${event.title}" — ignoring duplicate start`);
    return;
  }

  const hasRecentStart =
    !!lastMeetingStarting &&
    lastMeetingStarting.event.id !== event.id &&
    now - lastMeetingStarting.at <= MEETING_CONFLICT_WINDOW_MS;
  const isConflict = (isRecordingActive || hasRecentStart) && !!lastMeetingStarting && lastMeetingStarting.event.id !== event.id;

  if (isConflict && pendingConflict) {
    // A third meeting-starting arrived while we're still awaiting a decision.
    // We only support binary modal resolution â€” log and drop, but do still
    // leave the event in the upcoming list for the user to record manually.
    log('warn', 'calendar-watcher:conflict', `extra meeting ignored while conflict pending: "${event.title}"`);
    return;
  }

  if (isConflict) {
    handleMeetingConflict(lastMeetingStarting!.event, event);
    lastMeetingStarting = { event, at: now };
    return;
  }

  startMeetingRecording(event);
  lastMeetingStarting = { event, at: now };
});

function startMeetingRecording(event: MeetingEvent): void {
  createOverlayWindow(event.title, event.id);
  updateTrayMenu(mainWindow!, true);
  isRecordingActive = true;
  lastMicFailureNotifiedAt = 0;
  lastSysAudioFailureNotifiedAt = 0;
  lastRecordingSilenceNotifiedAt = 0;
  mainWindow?.webContents.send('recording:status', { status: 'recording', title: event.title });
  mainWindow?.webContents.send('badge:show', event.title);
}

function serializeMeetingEvent(event: MeetingEvent) {
  return {
    id: event.id,
    title: event.title,
    startTime: event.startTime instanceof Date ? event.startTime.getTime() : event.startTime,
    endTime: event.endTime instanceof Date ? event.endTime.getTime() : event.endTime,
    attendees: event.attendees ?? [],
    meetingLink: event.meetingLink,
    sourceCalendarId: event.sourceCalendarId,
  };
}

function pickConflictWinner(a: MeetingEvent, b: MeetingEvent): MeetingEvent {
  const scoreA = (a.attendees ?? []).filter((at) => isSelf(at)).length;
  const scoreB = (b.attendees ?? []).filter((at) => isSelf(at)).length;
  if (scoreA !== scoreB) return scoreA > scoreB ? a : b;
  const tA = a.startTime instanceof Date ? a.startTime.getTime() : Number(a.startTime);
  const tB = b.startTime instanceof Date ? b.startTime.getTime() : Number(b.startTime);
  if (tA !== tB) return tA < tB ? a : b;
  return a;
}

function handleMeetingConflict(active: MeetingEvent, incoming: MeetingEvent): void {
  log('info', 'calendar-watcher:conflict', `detected active="${active.title}" incoming="${incoming.title}"`);
  const payload = {
    active: serializeMeetingEvent(active),
    incoming: serializeMeetingEvent(incoming),
    autoSelectMs: MEETING_CONFLICT_AUTO_SELECT_MS,
  };

  const canShowModal =
    !!mainWindow &&
    !mainWindow.isDestroyed() &&
    mainWindow.isVisible() &&
    !mainWindow.isMinimized();

  if (canShowModal) {
    mainWindow!.webContents.send('meeting:conflict', payload);
  } else {
    // Still queue the modal for when the user opens the windowâ€¦
    mainWindow?.webContents.send('meeting:conflict', payload);
    // â€¦and surface a native notification so they know to decide.
    if (Notification.isSupported()) {
      const n = new Notification({
        title: 'Meeting conflict',
        body: `"${active.title}" vs "${incoming.title}" â€” picking one automatically in ${MEETING_CONFLICT_AUTO_SELECT_MS / 1000}s.`,
        actions: [
          { type: 'button', text: `Record "${active.title}"` },
          { type: 'button', text: `Record "${incoming.title}"` },
        ],
      });
      n.on('action', (_e, index) => {
        const winner = index === 1 ? incoming : active;
        resolveMeetingConflict(winner, 'user-selected');
      });
      n.on('click', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
        }
      });
      n.show();
    }
  }

  const timer = setTimeout(() => {
    const winner = pickConflictWinner(active, incoming);
    resolveMeetingConflict(winner, 'auto-selected');
  }, MEETING_CONFLICT_AUTO_SELECT_MS);

  pendingConflict = { active, incoming, timer };
}

function resolveMeetingConflict(winner: MeetingEvent, reason: 'auto-selected' | 'user-selected'): void {
  if (!pendingConflict) return;
  const { active, incoming, timer } = pendingConflict;
  clearTimeout(timer);
  pendingConflict = null;

  const passedOver = winner.id === active.id ? incoming : active;
  log('info', 'calendar-watcher:conflict', `recording="${winner.title}" passed-over="${passedOver.title}" reason=${reason}`);
  mainWindow?.webContents.send('meeting:conflict:resolved', { chosenId: winner.id, reason });

  if (winner.id !== active.id) {
    startMeetingRecording(winner);
  }
}

calendarWatcher.on('meeting-reminder', (event: any) => {
  // System notification
  if (Notification.isSupported()) {
    new Notification({
      title: 'Meeting starting soon',
      body: `${event.title} â€” don't forget to record`,
    }).show();
  }
  // Badge overlay with reminder mode (no auto-record)
  createReminderBadge(event.title);
  // Also notify the main window for a toast
  mainWindow?.webContents.send('meeting:reminder', event.title);
});

// â”€â”€ App lifecycle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// â”€â”€ Daily Jira pull â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runDailyJiraPull(): Promise<void> {
  const cfg = getConfig();
  if (!(cfg as any).jiraAutoPush || !(cfg as any).jiraTokens) return;

  const lastSync = (cfg as any).lastJiraSyncAt || 0;
  const oneDayMs = 24 * 60 * 60 * 1000;
  if (Date.now() - lastSync < oneDayMs) return;

  try {
    const projectKey = (cfg as any).jiraDefaultProject || undefined;
    const stories = await getJiraStories(projectKey, 7); // last 7 days
    const localTasks = await getTasks();

    let pulled = 0;
    for (const story of stories) {
      const existing = localTasks.find((t: any) => t.source?.type === 'jira' && t.source?.id === story.jiraKey);

      if (existing) {
        // Update local task if Jira is newer
        const jiraUpdated = new Date(story.updatedAt).getTime();
        const localUpdated = new Date(existing.updatedAt || existing.createdAt).getTime();
        if (jiraUpdated > localUpdated) {
          const statusMap: Record<string, string> = {
            'Done': 'completed', 'Complete': 'completed', 'Closed': 'completed', 'Resolved': 'completed',
            'In Progress': 'inProgress', 'In Development': 'inProgress',
            'To Do': 'todo', 'Open': 'todo', 'Backlog': 'todo',
          };
          const mappedStatus = statusMap[story.status] || undefined;
          const updates: Record<string, any> = {};
          if (story.title && story.title !== existing.title) updates.title = story.title;
          if (mappedStatus && mappedStatus !== existing.status) updates.status = mappedStatus;
          if (Object.keys(updates).length > 0) {
            updates.updatedAt = new Date().toISOString();
            await updateTask(existing._id, updates);
            pulled++;
          }
        }
      } else {
        // Create new local task from Jira issue
        const statusMap: Record<string, string> = {
          'Done': 'completed', 'Complete': 'completed', 'Closed': 'completed', 'Resolved': 'completed',
          'In Progress': 'inProgress', 'In Development': 'inProgress',
          'To Do': 'todo', 'Open': 'todo', 'Backlog': 'todo',
        };
        const task = await createTask({
          title: story.title,
          description: story.description || '',
          priority: story.priority ? (({ Highest: 'critical', High: 'high', Medium: 'medium', Low: 'low', Lowest: 'low' } as Record<string, string>)[story.priority] || 'medium') : 'medium',
          status: statusMap[story.status] || 'todo',
        });
        await updateTask(task._id, {
          source: { type: 'jira', id: story.jiraKey, url: story.jiraUrl },
        });
        pulled++;
      }
    }

    setConfig({ lastJiraSyncAt: Date.now() } as any);
    if (pulled > 0) {
      log('info', 'jira:daily-pull', `pulled ${pulled} updates from Jira`);
      mainWindow?.webContents.send('jira:auto-synced', { pulled });
    }
  } catch (err: any) {
    log('error', 'jira:daily-pull-failed', err.message);
  }
}

// Serve the renderer over a privileged app:// scheme. Calendar-free recording's
// Silero VAD loads its ONNX model via fetch() and onnxruntime-web loads its wasm
// via dynamic ESM import() of .mjs glue — Chromium blocks both over file://.
// registerSchemesAsPrivileged must run before app 'ready'.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const APP_MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.map': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
};

// Only one app instance may run — a second instance means a second calendar
// watcher and a second recorder badge for the same event, which fragments
// recordings. The duplicate exits immediately and focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}
app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (!mainWindow.isVisible()) mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  installApplicationMenu(() => {
    mainWindow?.show();
    mainWindow?.focus();
    mainWindow?.webContents.send('app:navigate', 'settings');
  });
  const RENDERER_DIR = path.join(__dirname, '../../dist/renderer');
  installSessionPermissionHandlers(session.defaultSession, RENDERER_DIR);
  installDisplayMediaHandler(session.defaultSession, RENDERER_DIR, async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 },
    });
    return sources[0] ?? null;
  });
  protocol.handle('app', async (request) => {
    const { pathname } = new URL(request.url);
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
    const filePath = path.join(RENDERER_DIR, rel);
    if (!filePath.startsWith(RENDERER_DIR)) return new Response('Forbidden', { status: 403 });
    try {
      const data = await fs.promises.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      return new Response(data, { headers: { 'Content-Type': APP_MIME[ext] || 'application/octet-stream' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
  initDatabase();
  void dedupePeopleByName().then(n => {
    if (n > 0) log('info', 'people:dedupe', `merged ${n} duplicate person record(s)`);
  }).catch(() => { /* repair pass is best-effort */ });
  void dedupeCalendarSyncMeetings().then(n => {
    if (n > 0) log('info', 'meetings:dedupe', `removed ${n} duplicate calendar-sync meeting row(s)`);
  }).catch(() => { /* repair pass is best-effort */ });
  initSorWriteLog();
  initPendingApprovals();
  initActionExecutionLog();
  onWriteCompleted((entry) => {
    mainWindow?.webContents.send('sor:write-completed', entry);
  });
  const migration = migrateLegacyCalendars();
  if (migration.migrated) {
    log('info', 'config:migrate-calendars', `Seeded calendars[] from legacy fields â€” added=${migration.added}`);
  }
  createMainWindow();
  createTray(mainWindow!, togglePopupWindow, () => tryShowDailyPlan(true));
  calendarWatcher.start();

  // Autostart (first run defaults to on) + once-a-day plan ~10 min after the
  // machine opens. 'unlock-screen'/'resume' re-arm the timer; the gate keeps
  // it at most once per day.
  applyAutostartDefault();
  scheduleDailyPlan(DAILY_PLAN_DELAY_MS);
  // On wake/unlock, re-poll the calendar immediately so a meeting already in
  // progress triggers the recorder within seconds instead of waiting out the
  // 5-minute poll interval.
  powerMonitor.on('unlock-screen', () => {
    scheduleDailyPlan(DAILY_PLAN_DELAY_MS);
    void calendarWatcher.refresh();
  });
  powerMonitor.on('resume', () => {
    scheduleDailyPlan(DAILY_PLAN_DELAY_MS);
    void calendarWatcher.refresh();
  });

  // Register Slack pipeline: normalize thread → create meeting → extract insights → save
  registerSlackPipeline(async (channelId, channelName, messages) => {
    const normalized = await normalizeSlackThread(messages, {
      channelId,
      channelName,
      permalink: `slack://channel?id=${channelId}`,
    });
    if (!normalized) return;

    // Extract first so a transient LLM failure cannot create a partial meeting
    // that is then mistaken for a successfully consumed Slack batch.
    const insights = await extractInsights(normalized.transcript);
    const meetingId = await createMeeting({
      title: normalized.title,
      date: normalized.date,
      attendees: normalized.attendees,
      source: 'slack_thread',
    });
    await updateMeetingTranscript(meetingId, normalized.transcript, 0);
    await saveInsights(meetingId, insights);
    mainWindow?.webContents.send('meeting:new', await getMeeting(meetingId));
    log('info', 'slack:pipeline', `Insights saved for thread in #${channelName} (meeting ${meetingId})`);
  });

  // Start Slack poller (delayed 10 s to let the main window settle)
  setTimeout(() => startSlackPoller(), 10_000);

  // Local MCP server ("Connect to AI") — loopback-only. Action writeback has
  // its own default-off preference and requires an approval record per run.
  // The watcher's event cache is handed over as a getter so mcp-server.ts stays
  // free of Electron/network imports; with no calendar connected it returns [].
  setUpcomingEventsProvider(() => calendarWatcher.getUpcomingEvents());
  const mcpPrefs = getMcpPrefs();
  if (mcpPrefs.enabled) {
    startMcpServer(mcpPrefs.port).then((r) => {
      if (!r.ok) log('error', 'mcp:startup', r.error || 'Failed to start local MCP server');
    });
  }

  // One-time scan for SoR writes stuck in 'pending' / 'pending-approval' / 'retrying'
  // for more than 24 hours â€” these indicate an interrupted/crashed prior session.
  setTimeout(async () => {
    try {
      const stuck = await sorListStuckEntries(24 * 60 * 60 * 1000);
      if (stuck.length > 0) {
        log('info', 'sor:stuck-entries', `${stuck.length} interrupted writes found`);
        if (Notification.isSupported()) {
          new Notification({
            title: 'Jira sync interrupted',
            body: `${stuck.length} Jira ${stuck.length === 1 ? 'write was' : 'writes were'} interrupted. Open Settings â†’ Integrations to retry.`,
          }).show();
        }
      }
    } catch (err: any) {
      log('error', 'sor:stuck-scan-failed', err.message);
    }
  }, 15_000);

  // Staleness sweep â€” fire-and-forget after calendar sync starts so the welcome-back
  // compute IPC (US-004) can read lastSweepResult. Delayed to let first calendar sync
  // settle but NOT awaited so whenReady() stays non-blocking.
  setTimeout(() => {
    sweepStaleTasks().catch((err) => log('error', 'staleness-sweep', String(err)));
  }, 5_000);

  // Daily Jira pull â€” run on startup (after a short delay) and every 6 hours
  setTimeout(() => runDailyJiraPull(), 10_000);
  setInterval(() => runDailyJiraPull(), 6 * 60 * 60 * 1000);

  globalShortcut.register('CommandOrControl+Shift+T', () => {
    createOverlayWindow('Test Meeting');
  });
  if (!globalShortcut.register(VOICE_CAPTURE_SHORTCUT, openVoiceCapture)) {
    log('warn', 'shortcut:voice-capture', `Could not register ${VOICE_CAPTURE_SHORTCUT}`);
  }
});

app.on('window-all-closed', () => {
  // keep running in tray
});

app.on('activate', () => {
  mainWindow?.show();
});

// ── Slack IPC handlers ─────────────────────────────────────────────────────

ipcMain.handle('slack:connect', async (_e, token: string) => {
  const result = await validateToken(token);
  if (result.ok) {
    setConfig({ slackUserToken: token, slackBotToken: '' } as any);
    void runSlackPollNow().catch((error) => log('error', 'slack:poller', `Post-connect poll failed: ${error.message}`));
  }
  return result;
});

ipcMain.handle('slack:connectOAuth', async () => {
  try {
    const connection = await connectSlackWithOAuth();
    setConfig({ slackUserToken: connection.token, slackBotToken: '' } as any);
    void runSlackPollNow().catch((error) => log('error', 'slack:poller', `Post-connect poll failed: ${error.message}`));
    return {
      ok: true,
      teamName: connection.teamName,
      userName: connection.userName,
      tokenType: connection.tokenType,
    };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('slack:disconnect', () => {
  setConfig({ slackUserToken: '', slackBotToken: '' } as any);
  return true;
});

ipcMain.handle('slack:status', () => {
  return getSlackConnectionInfo();
});

ipcMain.handle('slack:listChannels', async () => {
  try { return { ok: true, channels: await slackListChannels() }; }
  catch (e: any) { return { ok: false, error: e.message }; }
});

ipcMain.handle('slack:listWriteChannels', async () => {
  try {
    const allowed = new Set(((getConfig() as any).slackWriteChannels ?? []) as string[]);
    const channels = (await slackListChannels()).filter((channel) => allowed.has(channel.id));
    return { ok: true, channels };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('slack:postWiserNote', async (_e, channelId: string, note: string) => {
  try {
    if (typeof channelId !== 'string' || typeof note !== 'string') {
      return { ok: false, error: 'Invalid Slack note request' };
    }
    await postWiserNote(channelId, note);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
});

// ── Local MCP server IPC handlers ──────────────────────────────────────────

ipcMain.handle('mcp:status', () => getMcpStatus());

ipcMain.handle('mcp:setEnabled', async (_e, enabled: boolean) => {
  setConfig({ mcpEnabled: !!enabled });
  if (enabled) {
    return startMcpServer(getMcpPrefs().port);
  }
  await stopMcpServer();
  return { ok: true, port: null };
});

ipcMain.handle('mcp:setPort', async (_e, port: number) => {
  const p = Math.floor(Number(port));
  if (!Number.isInteger(p) || p < 1024 || p > 65535) {
    return { ok: false, port: null, error: 'Port must be a number between 1024 and 65535.' };
  }
  setConfig({ mcpPort: p });
  if (getMcpPrefs().enabled) {
    return startMcpServer(p);
  }
  return { ok: true, port: p };
});

ipcMain.handle('mcp:setWritebackEnabled', (_e, enabled: boolean) => {
  setConfig({ mcpWritebackEnabled: !!enabled });
  return { ok: true, enabled: getMcpPrefs().writebackEnabled };
});

app.on('before-quit', () => {
  calendarWatcher.stop();
  stopSlackPoller();
  void stopMcpServer();
  destroyTray();
  globalShortcut.unregisterAll();
  mainWindow?.removeAllListeners('close');
});
