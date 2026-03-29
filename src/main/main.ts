import { app, BrowserWindow, ipcMain, globalShortcut, Menu, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

import { getConfig, setConfig, isOnboardingComplete } from './config';
import { CalendarWatcher } from './calendar-watcher';
import { transcribeAudio } from './transcriber';
import { extractInsights } from './extractor';
import {
  createMeeting, updateMeetingTranscript, saveInsights,
  getMeetings, getMeeting, deleteMeeting, getPeople,
  getTasks, createTask, updateTask, deleteTask,
} from './database';
import { createTray, updateTrayMenu, destroyTray } from './tray';

Menu.setApplicationMenu(null);

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
const calendarWatcher = new CalendarWatcher();
let activeRecording: { mediaRecorder?: any; chunks: Buffer[]; tmpPath?: string } | null = null;

// ── Windows ───────────────────────────────────────────────────────────────────

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#f8fafc',
    icon: path.join(__dirname, '../../assets/inwise_logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'inWise',
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, '../../dist/renderer/index.html'));
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  mainWindow.on('close', (e) => {
    e.preventDefault();
    mainWindow?.hide();
  });
}

function createOverlayWindow(title: string): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('recording:start', title);
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
    overlayWindow?.webContents.send('recording:start', title);
  });
}

// ── Recording pipeline ────────────────────────────────────────────────────────

async function runRecordingPipeline(audioPath: string, meetingTitle: string, calendarEventId?: string): Promise<void> {
  overlayWindow?.webContents.send('recording:status', { status: 'processing', message: 'Transcribing…' });

  try {
    const durationSec = getAudioDuration(audioPath);
    const transcript = await transcribeAudio(audioPath);

    const meetingId = createMeeting({
      title: meetingTitle,
      date: new Date().toISOString(),
      duration: durationSec,
      calendarEventId,
      source: 'desktop_recording',
    });

    updateMeetingTranscript(meetingId, transcript, durationSec);

    overlayWindow?.webContents.send('recording:status', { status: 'processing', message: 'Extracting insights…' });
    const insights = await extractInsights(transcript);
    saveInsights(meetingId, insights);

    mainWindow?.webContents.send('meeting:new', getMeeting(meetingId));
    overlayWindow?.webContents.send('recording:status', { status: 'done' });

    setTimeout(() => {
      overlayWindow?.close();
      overlayWindow = null;
    }, 3000);
  } catch (err: any) {
    overlayWindow?.webContents.send('recording:status', { status: 'error', message: err.message });
  } finally {
    fs.unlink(audioPath, () => {});
  }
}

function getAudioDuration(filePath: string): number {
  try {
    const stat = fs.statSync(filePath);
    // rough estimate: 16kHz mono 16-bit ≈ 32000 bytes/sec
    return Math.round(stat.size / 32000);
  } catch { return 0; }
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('shell:openExternal', (_e, url: string) => shell.openExternal(url));
ipcMain.handle('config:get', () => getConfig());
ipcMain.handle('config:set', (_e, updates) => { setConfig(updates); return true; });

ipcMain.handle('calendar:testUrl', (_e, url: string) => calendarWatcher.testUrl(url));
ipcMain.handle('calendar:getEvents', () => {
  return calendarWatcher.getUpcomingEvents().map(e => ({
    ...e,
    startTime: e.startTime.toISOString(),
    endTime: e.endTime.toISOString(),
  }));
});

ipcMain.handle('db:getTasks', () => getTasks());
ipcMain.handle('db:createTask', (_e, data) => createTask(data));
ipcMain.handle('db:updateTask', (_e, id, updates) => updateTask(id, updates));
ipcMain.handle('db:deleteTask', (_e, id) => { deleteTask(id); return true; });

ipcMain.handle('db:getMeetings', () => getMeetings());
ipcMain.handle('db:getMeeting', (_e, id) => getMeeting(id));
ipcMain.handle('db:deleteMeeting', (_e, id) => { deleteMeeting(id); return true; });
ipcMain.handle('db:getPeople', () => getPeople());

ipcMain.handle('recording:start', (_e, title: string) => {
  createOverlayWindow(title);
  updateTrayMenu(mainWindow!, true);
  return true;
});

ipcMain.handle('recording:stop', async () => {
  // renderer sends audio blob via recording:audio-data
  return true;
});

ipcMain.on('recording:audio-data', async (_e, { buffer, title, calendarEventId }: { buffer: Buffer; title: string; calendarEventId?: string }) => {
  const tmpPath = path.join(os.tmpdir(), `inwise-rec-${Date.now()}.wav`);
  fs.writeFileSync(tmpPath, buffer);
  updateTrayMenu(mainWindow!, false);
  await runRecordingPipeline(tmpPath, title, calendarEventId);
});

// ── Calendar watcher ──────────────────────────────────────────────────────────

calendarWatcher.on('events-updated', (events: any[]) => {
  mainWindow?.webContents.send('calendar:events', events.map(e => ({
    ...e,
    startTime: e.startTime instanceof Date ? e.startTime.toISOString() : e.startTime,
    endTime: e.endTime instanceof Date ? e.endTime.toISOString() : e.endTime,
  })));
});

calendarWatcher.on('meeting-starting', (event: any) => {
  createOverlayWindow(event.title);
  updateTrayMenu(mainWindow!, true);
  mainWindow?.webContents.send('badge:show', event.title);
});

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createMainWindow();
  createTray(mainWindow!);
  calendarWatcher.start();

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
