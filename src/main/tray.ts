import { Tray, Menu, BrowserWindow, nativeImage, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

let tray: Tray | null = null;
let showDailyPlan: (() => void) | null = null;

const IDLE_ICON_REL = '../../assets/favicon.png';
const MAC_IDLE_ICON_REL = '../../assets/icon-256.png';
const RECORDING_ICON_REL = '../../assets/favicon-recording.png';

function loadTrayIcon(isRecording: boolean) {
  const recordingPath = path.join(__dirname, RECORDING_ICON_REL);
  const target = isRecording && fs.existsSync(recordingPath)
    ? recordingPath
    : path.join(__dirname, process.platform === 'darwin' ? MAC_IDLE_ICON_REL : IDLE_ICON_REL);
  const size = process.platform === 'darwin' ? 18 : 16;
  const icon = nativeImage.createFromPath(target).resize({ width: size, height: size });
  // Template images automatically adapt to light/dark menu bars and accessibility
  // contrast. The recording icon stays coloured so active capture remains obvious.
  if (process.platform === 'darwin' && !isRecording) icon.setTemplateImage(true);
  return icon;
}

export function createTray(mainWindow: BrowserWindow, onToggle?: () => void, onShowDailyPlan?: () => void): void {
  tray = new Tray(loadTrayIcon(false));
  tray.setToolTip('Inwise');
  showDailyPlan = onShowDailyPlan ?? null;

  updateTrayMenu(mainWindow, false);

  // Single click toggles the popup anchored above the tray (Logi Tune-style).
  tray.on('click', () => {
    if (onToggle) onToggle();
    else { mainWindow.show(); mainWindow.focus(); }
  });

  tray.on('double-click', () => {
    mainWindow.show();
    mainWindow.focus();
  });
}

export function getTrayBounds(): Electron.Rectangle | null {
  if (!tray) return null;
  try {
    const b = tray.getBounds();
    return b && b.width > 0 ? b : null;
  } catch {
    return null;
  }
}

export function updateTrayMenu(mainWindow: BrowserWindow, isRecording: boolean): void {
  if (!tray) return;

  // Swap icon to recording variant when available; falls back to idle icon if asset missing
  try {
    const icon = loadTrayIcon(isRecording);
    if (!icon.isEmpty()) tray.setImage(icon);
  } catch { /* swallow — tray icon update is non-critical */ }

  tray.setToolTip(isRecording ? 'Inwise — Recording in progress' : 'Inwise');

  const menu = Menu.buildFromTemplate([
    {
      label: isRecording ? '● Recording in progress' : 'Inwise',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Open Inwise',
      click: () => { mainWindow.show(); mainWindow.focus(); },
    },
    ...(showDailyPlan
      ? [{ label: "Show today's plan", click: () => showDailyPlan?.() }]
      : []),
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => app.quit(),
    },
  ]);

  tray.setContextMenu(menu);
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}
