import { Tray, Menu, BrowserWindow, nativeImage, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { log } from './logger';

let tray: Tray | null = null;
let showDailyPlan: (() => void) | null = null;

const MAC_IDLE_ICON_REL = '../../assets/icon-256.png';
const IDLE_ICON_REL = process.platform === 'win32'
  ? '../../assets/tray-owl.ico'
  : '../../assets/favicon.png';
const RECORDING_ICON_REL = process.platform === 'win32'
  ? '../../assets/tray-owl-recording.ico'
  : '../../assets/favicon-recording.png';

function loadTrayIcon(isRecording: boolean) {
  const recordingPath = path.join(__dirname, RECORDING_ICON_REL);
  const target = isRecording && fs.existsSync(recordingPath)
    ? recordingPath
    : path.join(__dirname, process.platform === 'darwin' ? MAC_IDLE_ICON_REL : IDLE_ICON_REL);
  const image = nativeImage.createFromPath(target);
  if (!image.isEmpty()) {
    // Preserve every embedded ICO size on Windows so Explorer can select the
    // right representation for the current display scale.
    const size = image.getSize();
    log('info', 'tray:icon', `loaded ${path.basename(target)} (${size.width}x${size.height})`);
    if (process.platform === 'win32') return image;
    const resized = image.resize({ width: process.platform === 'darwin' ? 18 : 16, height: process.platform === 'darwin' ? 18 : 16 });
    // Template images automatically adapt to light/dark menu bars and accessibility
    // contrast. The recording icon stays coloured so active capture remains obvious.
    if (process.platform === 'darwin' && !isRecording) resized.setTemplateImage(true);
    return resized;
  }

  // Reading PNG bytes avoids returning an empty tray slot if a platform cannot
  // decode the preferred file format or resolve an archive-backed path.
  const fallback = path.join(__dirname, isRecording
    ? '../../assets/favicon-recording.png'
    : '../../assets/favicon.png');
  const fallbackImage = nativeImage.createFromBuffer(fs.readFileSync(fallback)).resize({ width: 16, height: 16 });
  log('warn', 'tray:icon', `preferred icon was empty; loaded ${path.basename(fallback)} from bytes`);
  return fallbackImage;
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
