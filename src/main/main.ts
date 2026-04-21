import { app, BrowserWindow, ipcMain, globalShortcut, Menu, shell, Notification, desktopCapturer } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

import { getConfig, setConfig, migrateLegacyCalendars, listCalendars, addCalendar, updateCalendar, removeCalendar, CalendarSubscription } from './config';
import { isSelf } from './self-identity';
import { log } from './logger';
import { CalendarWatcher } from './calendar-watcher';
import { transcribeAudio, setupWhisper } from './transcriber';
import { extractInsights, searchMeetings, detectContradictions, generateAgenda, suggestTaskFields } from './extractor';
import {
  initDatabase,
  createMeeting, updateMeetingTranscript, saveInsights, updateMeetingStatus,
  getMeetings, getMeeting, deleteMeeting, getAllPastDecisions, getOverdueCommitments,
  createMeetingFromTranscript,
  getTasks, createTask, updateTask, deleteTask,
  getPeople, getArchivedPeople, getPerson, addPerson, addTrackedPeople,
  archivePerson, unarchivePerson, getSuggestedPeople, updatePersonProfile,
  getPersonAgendaContext, getMeetingAgendaContext,
  saveVoicePrint, getVoicePrints, getVoicePrint, deleteVoicePrint,
  getUserVoicePrint, getVoicePrintByName, getVoicePrintsWithEmbeddings,
  syncCalendarEventsToDb,
} from './database';
import { extractChannel, trimWav, wavBufferToSamples } from './audio-utils';
import {
  connectJira, disconnectJira, isJiraConnected, getJiraInfo,
  getJiraProjects, getJiraStories, createJiraIssue, updateJiraIssue,
  transitionJiraIssue, addJiraComment,
} from './jira-client';
import { matchAllItems, semanticMatch } from './jira-matcher';
import { scoreTasks } from './task-scorer';
import { computeVoiceEmbedding, identifySpeaker, SPEAKER_MATCH_THRESHOLD } from './mfcc';
import { createTray, updateTrayMenu, destroyTray } from './tray';

Menu.setApplicationMenu(null);

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
const calendarWatcher = new CalendarWatcher();
let activeRecording: { mediaRecorder?: any; chunks: Buffer[]; tmpPath?: string } | null = null;

type AudioHealth = { micOk: boolean; systemAudioOk: boolean; message?: string };
let latestAudioHealth: AudioHealth | null = null;
let isRecordingActive = false;
const AUDIO_HEALTH_NOTIFY_DEBOUNCE_MS = 60 * 1000;
let lastMicFailureNotifiedAt = 0;
let lastSysAudioFailureNotifiedAt = 0;

// ── Windows ───────────────────────────────────────────────────────────────────

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
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

  mainWindow.loadFile(path.join(__dirname, '../../dist/renderer/index.html'));
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  mainWindow.on('close', (e) => {
    e.preventDefault();
    mainWindow?.hide();
  });
}

function createOverlayWindow(title: string, calendarEventId?: string): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('recording:start', title, calendarEventId);
    return;
  }

  overlayWindow = new BrowserWindow({
    width: 340,
    height: 72,
    x: 20,
    y: 20,
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

  overlayWindow.loadFile(path.join(__dirname, '../../dist/renderer/badge.html'));
  overlayWindow.webContents.once('did-finish-load', () => {
    overlayWindow?.webContents.send('recording:start', title, calendarEventId);
  });
}

function createReminderBadge(title: string): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) return; // don't interrupt active recording

  const win = new BrowserWindow({
    width: 340,
    height: 72,
    x: 20,
    y: 20,
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

  win.loadFile(path.join(__dirname, '../../dist/renderer/badge.html'));
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('recording:start', title);
  });

  // Auto-dismiss after 30 seconds if user doesn't interact
  setTimeout(() => { if (!win.isDestroyed()) win.close(); }, 30_000);
}

function sendToOverlay(msg: any) {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('recording:status', msg);
  }
}

// ── Voice auto-enrollment ────────────────────────────────────────────────────

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
    // 1:1 — we know exactly who speaker 1 is
    speakerMap['1'] = otherAttendees[0];
  } else if (otherAttendees.length > 1) {
    // Group — try to identify via voice prints, otherwise use "Others"
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
    log('info', 'pipeline:label-replace', `replaced ${replacementCount} speaker labels (${Object.entries(speakerMap).map(([k, v]) => `${k}→${v}`).join(', ')})`);
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

  // Check which attendees already have voice prints
  const enrolled: string[] = [];
  const unenrolled: string[] = [];
  for (const name of otherAttendees) {
    const existing = await getVoicePrintByName(name);
    if (existing) enrolled.push(name);
    else unenrolled.push(name);
  }

  log('info', 'voice-enroll:status', `attendees=${otherAttendees.length} enrolled=${enrolled.length} unenrolled=${unenrolled.length}`);

  // Tier 1: 1:1 meeting — only one other person, auto-enroll them
  if (otherAttendees.length === 1 && unenrolled.length === 1) {
    const name = unenrolled[0];
    await saveVoicePrint({ name, audioClip: rightChannelClip, isUser: false, embedding: clipEmbedding || undefined });
    log('info', 'voice-enroll:auto', `enrolled "${name}" from 1:1 recording`);
    return;
  }

  // Tier 2: Group call, all but one attendee already enrolled — enroll by elimination
  if (unenrolled.length === 1) {
    const name = unenrolled[0];
    await saveVoicePrint({ name, audioClip: rightChannelClip, isUser: false, embedding: clipEmbedding || undefined });
    log('info', 'voice-enroll:elimination', `enrolled "${name}" by elimination (${enrolled.length} already enrolled)`);
    return;
  }

  // Tier 3: Multiple unknowns — try MFCC matching against stored voice prints
  if (unenrolled.length > 1 && clipEmbedding) {
    const storedPrints = await getVoicePrintsWithEmbeddings();
    // Only match against non-user prints that have embeddings
    const candidates = storedPrints.filter((p: any) => !p.isUser && p.embedding);

    if (candidates.length > 0) {
      const samples = wavBufferToSamples(rightChannelClip);
      const matches = identifySpeaker(samples, 16000, candidates);
      const bestMatch = matches[0];

      if (bestMatch && bestMatch.similarity >= SPEAKER_MATCH_THRESHOLD) {
        // We recognized one of the speakers — mark them as identified
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

    // Still can't resolve — store as unidentified with embedding for future matching
    const label = `Unidentified (${unenrolled.join(', ')})`;
    await saveVoicePrint({ name: label, audioClip: rightChannelClip, isUser: false, embedding: clipEmbedding });
    log('info', 'voice-enroll:unidentified', `stored clip with embedding for ${unenrolled.length} unknown voices`);
  } else if (unenrolled.length > 1) {
    // No embedding computed — store raw clip only
    const label = `Unidentified (${unenrolled.join(', ')})`;
    await saveVoicePrint({ name: label, audioClip: rightChannelClip, isUser: false });
    log('info', 'voice-enroll:unidentified', `stored clip (no embedding) for ${unenrolled.length} unknown voices`);
  }
}

// ── Recording pipeline ────────────────────────────────────────────────────────

async function runRecordingPipeline(audioPath: string, meetingTitle: string, calendarEventId?: string, stereo?: boolean, attendees?: string[]): Promise<void> {
  sendToOverlay({ status: 'processing', message: 'Transcribing…' });
  log('info', 'pipeline:start', `title="${meetingTitle}" stereo=${!!stereo} path=${audioPath}`);

  // Create the meeting record FIRST so failed transcriptions are still recoverable
  const durationSec = getAudioDuration(audioPath);
  log('info', 'pipeline:transcribe', `duration=${durationSec}s`);

  const meetingId = await createMeeting({
    title: meetingTitle,
    date: new Date().toISOString(),
    duration: durationSec,
    calendarEventId,
    source: 'desktop_recording',
    attendees: attendees || [],
  });
  log('info', 'pipeline:meeting-created', meetingId);
  await updateMeetingStatus(meetingId, 'transcribing');
  mainWindow?.webContents.send('meeting:new', await getMeeting(meetingId));

  try {
    let transcript = await transcribeAudio(audioPath, stereo);
    log('info', 'pipeline:transcribed', `length=${transcript.length} chars`);

    // Replace speaker labels with real names
    if (stereo) {
      transcript = await replaceSpeakerLabels(transcript, attendees || []);
    }

    await updateMeetingTranscript(meetingId, transcript, durationSec);

    // Always notify renderer so meeting appears even if insights fail
    mainWindow?.webContents.send('meeting:new', await getMeeting(meetingId));

    sendToOverlay({ status: 'processing', message: 'Extracting insights…' });
    try {
      const insights = await extractInsights(transcript);

      // Detect contradictions against past decisions
      try {
        if (insights.decisions && insights.decisions.length > 0) {
          sendToOverlay({ status: 'processing', message: 'Checking for contradictions…' });
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

      // Auto-push to Jira if enabled — match to existing stories first
      const jiraConfig = getConfig();
      if ((jiraConfig as any).jiraAutoPush && (jiraConfig as any).jiraTokens && (jiraConfig as any).jiraDefaultProject) {
        try {
          const projectKey = (jiraConfig as any).jiraDefaultProject;
          const stories = await getJiraStories(projectKey);
          const matches = matchAllItems(insights.actionItems, stories);

          let created = 0;
          let linked = 0;

          for (let i = 0; i < matches.length; i++) {
            const match = matches[i];
            const item = insights.actionItems[i];

            if (match.autoApproved && match.bestMatch) {
              // High-confidence match — link to existing story via comment
              await addJiraComment(
                match.bestMatch.jiraKey,
                `Action item: ${item.text}\nOwner: ${item.owner || 'Unassigned'}`,
                meetingTitle,
              );
              // Create local task linked to the Jira story
              const task = await createTask({
                title: item.text,
                description: `From meeting: ${meetingTitle}`,
                priority: item.priority || 'medium',
                dueDate: item.dueDate,
                status: 'todo',
              });
              await updateTask(task._id, {
                source: { type: 'jira', id: match.bestMatch.jiraKey, url: match.bestMatch.jiraUrl },
              });
              linked++;
            } else {
              // No confident match — create new Jira issue
              const result = await createJiraIssue({
                title: item.text,
                description: `From meeting: ${meetingTitle}\nOwner: ${item.owner || 'Unassigned'}`,
                priority: item.priority || 'medium',
                dueDate: item.dueDate,
                projectKey,
              });
              // Create local task linked to the new Jira issue
              const task = await createTask({
                title: item.text,
                description: `From meeting: ${meetingTitle}`,
                priority: item.priority || 'medium',
                dueDate: item.dueDate,
                status: 'todo',
              });
              await updateTask(task._id, {
                source: { type: 'jira', id: result.key, url: result.url },
              });
              created++;
            }
          }

          const total = created + linked;
          log('info', 'pipeline:jira-auto-push', `created ${created}, linked ${linked} of ${total} tasks to ${projectKey}`);
          mainWindow?.webContents.send('jira:auto-synced', { created, linked, total });
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

    sendToOverlay({ status: 'done' });
    mainWindow?.webContents.send('recording:status', { status: 'done' });
    log('info', 'pipeline:done', meetingId);
    setTimeout(() => {
      if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
      overlayWindow = null;
    }, 3000);
  } catch (err: any) {
    log('error', 'pipeline:failed', err.message);
    // Mark the meeting as failed so it stays visible in the UI
    try {
      await updateMeetingStatus(meetingId, 'error');
      mainWindow?.webContents.send('meeting:new', await getMeeting(meetingId));
      mainWindow?.webContents.send('pipeline:error', { meetingId, error: err.message, stage: 'transcribe' });
    } catch { /* ignore */ }
    sendToOverlay({ status: 'error', message: err.message });
    mainWindow?.webContents.send('recording:status', { status: 'error', message: err.message });
    // Keep audio file on failure so user can retry — delete only on success
    return;
  }
  // Recording preserved on success and failure — user explicitly requested retention.
}

function getAudioDuration(filePath: string): number {
  try {
    const stat = fs.statSync(filePath);
    return Math.round(stat.size / 32000);
  } catch { return 0; }
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

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
ipcMain.handle('config:get', () => getConfig());
ipcMain.handle('config:set', (_e, updates) => { setConfig(updates); return true; });

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
    const m1Id = await createMeeting({ title: 'Sprint Planning — Q2 Priorities', date: daysAgo(2), duration: 2700, attendees: ['Alex Chen', 'Sarah Kim', 'Jordan Patel', 'Maya Rodriguez'], source: 'demo_seed' });
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
        { text: 'Staging environment CI pipeline failures — losing velocity', severity: 'high' },
      ],
    });
    await updateMeetingStatus(m1Id, 'reviewed');

    // Meeting 2: 1:1 with Alex
    const m2Id = await createMeeting({ title: '1:1 with Alex — Engineering Updates', date: daysAgo(1), duration: 1800, attendees: ['Alex Chen'], source: 'demo_seed' });
    await saveInsights(m2Id, {
      summary: 'DevOps found CI memory leak, fix tonight. API v2 may deprecate 3 endpoints — need 60-day deprecation policy. Dashboard needs WebSocket for real-time refresh. Jordan to be tech lead on API v2.',
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
    const m3Id = await createMeeting({ title: 'Design Review — Dashboard Wireframes', date: daysAgo(0), duration: 2100, attendees: ['Maya Rodriguez', 'Alex Chen', 'Sarah Kim'], source: 'demo_seed' });
    await saveInsights(m3Id, {
      summary: 'Dashboard wireframes approved — card-based layout with drag-to-reorder. Focus time metric to be added. Mobile responsive at 768px and 1024px breakpoints. Dev starts Monday.',
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

    log('info', 'seed:demo', `Seeded 3 meetings, ${demoTasks.length} tasks, ${people.length} people`);
    return { seeded: true, meetings: 3, tasks: demoTasks.length, people: people.length };
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

// Tasks
ipcMain.handle('db:getTasks', async () => getTasks());
ipcMain.handle('db:createTask', async (_e, data) => createTask(data));
ipcMain.handle('db:updateTask', async (_e, id, updates) => {
  const result = await updateTask(id, updates);

  // Auto-sync to Jira if enabled and task is linked
  try {
    const cfg = getConfig();
    if ((cfg as any).jiraAutoPush && (cfg as any).jiraTokens && result?.source?.type === 'jira' && result?.source?.id) {
      const jiraKey = result.source.id;
      let synced = false;

      // Status changed — transition in Jira
      if (updates.status) {
        await transitionJiraIssue(jiraKey, updates.status);
        synced = true;
      }

      // Title or description changed — update Jira issue fields
      if (updates.title || updates.description || updates.priority || updates.dueDate) {
        await updateJiraIssue(jiraKey, {
          title: updates.title,
          description: updates.description,
          priority: updates.priority,
          dueDate: updates.dueDate,
        });
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
        lines.push(`- ${p.name}${p.role ? ` (${p.role})` : ''}${p.meetingCount ? ` — ${p.meetingCount} meetings` : ''}`);
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

    const contextText = lines.length > 0 ? lines.join('\n') : 'No context available — suggest reasonable defaults.';

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

// Recording
ipcMain.handle('recording:start', (_e, title: string, calendarEventId?: string) => {
  createOverlayWindow(title, calendarEventId);
  updateTrayMenu(mainWindow!, true);
  isRecordingActive = true;
  lastMicFailureNotifiedAt = 0;
  lastSysAudioFailureNotifiedAt = 0;
  return true;
});

ipcMain.handle('recording:stop', async () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('recording:stop-request');
  }
  return true;
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
      body: next.message || 'Microphone unavailable — the rest of this meeting will not be transcribed.',
    }).show();
  }
  if (prev?.systemAudioOk === true && next.systemAudioOk === false && now - lastSysAudioFailureNotifiedAt > AUDIO_HEALTH_NOTIFY_DEBOUNCE_MS) {
    lastSysAudioFailureNotifiedAt = now;
    new Notification({
      title: 'System audio lost',
      body: next.message || 'System audio lost — only your mic will be transcribed for the rest of this meeting.',
    }).show();
  }
});

ipcMain.handle('audio:health:get', () => latestAudioHealth);

ipcMain.on('renderer:unhandled-rejection', (_e, payload: { name?: string; message?: string; stack?: string; source?: string }) => {
  const name = payload?.name || 'UnhandledRejection';
  const message = payload?.message || '(no message)';
  const source = payload?.source ? ` source=${payload.source}` : '';
  log('error', 'renderer:unhandled-rejection', `${name}: ${message}${source}`);
});

ipcMain.on('recording:audio-data', async (_e, { buffer, title, calendarEventId, stereo }: { buffer: Buffer; title: string; calendarEventId?: string; stereo?: boolean }) => {
  log('info', 'audio-data:received', `title="${title}" size=${buffer?.length ?? 0} stereo=${!!stereo}`);
  isRecordingActive = false;
  try {
    const recordingsDir = path.join(app.getPath('userData'), 'recordings');
    if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });
    const tmpPath = path.join(recordingsDir, `inwise-rec-${Date.now()}.wav`);
    fs.writeFileSync(tmpPath, buffer);
    updateTrayMenu(mainWindow!, false);
    // Look up attendees from the calendar event if available
    const attendees = calendarEventId
      ? calendarWatcher.getUpcomingEvents().find((e: any) => e.id === calendarEventId)?.attendees || []
      : [];
    await runRecordingPipeline(tmpPath, title, calendarEventId, stereo, attendees);
  } catch (e: any) {
    log('error', 'audio-data:failed', e.message);
  }
});

// ── Calendar watcher ──────────────────────────────────────────────────────────

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
      log('info', 'calendar-sync', `Synced calendar → meetingsDb: ${created} created, ${updated} updated`);
    }
  } catch (e: any) {
    log('error', 'calendar-sync', `Failed to sync calendar events to DB: ${e.message}`);
  }
});

calendarWatcher.on('meeting-starting', (event: any) => {
  createOverlayWindow(event.title);
  updateTrayMenu(mainWindow!, true);
  isRecordingActive = true;
  lastMicFailureNotifiedAt = 0;
  lastSysAudioFailureNotifiedAt = 0;
  mainWindow?.webContents.send('badge:show', event.title);
});

calendarWatcher.on('meeting-reminder', (event: any) => {
  // System notification
  if (Notification.isSupported()) {
    new Notification({
      title: 'Meeting starting soon',
      body: `${event.title} — don't forget to record`,
    }).show();
  }
  // Badge overlay with reminder mode (no auto-record)
  createReminderBadge(event.title);
  // Also notify the main window for a toast
  mainWindow?.webContents.send('meeting:reminder', event.title);
});

// ── App lifecycle ─────────────────────────────────────────────────────────────

// ── Daily Jira pull ─────────────────────────────────────────────────────────

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

app.whenReady().then(() => {
  initDatabase();
  const migration = migrateLegacyCalendars();
  if (migration.migrated) {
    log('info', 'config:migrate-calendars', `Seeded calendars[] from legacy fields — added=${migration.added}`);
  }
  createMainWindow();
  createTray(mainWindow!);
  calendarWatcher.start();

  // Daily Jira pull — run on startup (after a short delay) and every 6 hours
  setTimeout(() => runDailyJiraPull(), 10_000);
  setInterval(() => runDailyJiraPull(), 6 * 60 * 60 * 1000);

  // Grant microphone + screen access to all windows (needed for badge overlay)
  const { session } = require('electron');
  session.defaultSession.setPermissionRequestHandler((_webContents: any, permission: string, callback: (granted: boolean) => void) => {
    const allowed = ['media', 'audioCapture', 'videoCapture', 'desktopCapture', 'screen'];
    callback(allowed.includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_webContents: any, permission: string) => {
    const allowed = ['media', 'audioCapture', 'videoCapture', 'desktopCapture', 'screen'];
    return allowed.includes(permission);
  });

  globalShortcut.register('CommandOrControl+Shift+T', () => {
    createOverlayWindow('Test Meeting');
  });
});

app.on('window-all-closed', () => {
  // keep running in tray
});

app.on('activate', () => {
  mainWindow?.show();
});

app.on('before-quit', () => {
  calendarWatcher.stop();
  destroyTray();
  globalShortcut.unregisterAll();
  mainWindow?.removeAllListeners('close');
});
