import { Tray, Menu, BrowserWindow, nativeImage, app } from 'electron';
import * as path from 'path';

let tray: Tray | null = null;

export function createTray(mainWindow: BrowserWindow): void {
  const iconPath = path.join(__dirname, '../../assets/tray-icon.png');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });

  tray = new Tray(icon);
  tray.setToolTip('inWise');

  updateTrayMenu(mainWindow, false);

  tray.on('double-click', () => {
    mainWindow.show();
    mainWindow.focus();
  });
}

export function updateTrayMenu(mainWindow: BrowserWindow, isRecording: boolean): void {
  if (!tray) return;

  const menu = Menu.buildFromTemplate([
    {
      label: isRecording ? '● Recording…' : 'inWise',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Open inWise',
      click: () => { mainWindow.show(); mainWindow.focus(); },
    },
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
