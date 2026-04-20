import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

let logPath: string | null = null;

function getLogPath(): string {
  if (!logPath) {
    logPath = path.join(app.getPath('userData'), 'app.log');
  }
  return logPath;
}

function ts(): string {
  return new Date().toISOString();
}

export function log(level: 'info' | 'warn' | 'error', message: string, detail?: string): void {
  const line = `[${ts()}] ${level.toUpperCase()} ${message}${detail ? ' | ' + detail : ''}\n`;
  try {
    fs.appendFileSync(getLogPath(), line);
  } catch {
    // If we can't write the log, don't crash the app
  }
  if (level === 'error') {
    console.error(`[${level}]`, message, detail || '');
  } else {
    console.log(`[${level}]`, message, detail || '');
  }
}
