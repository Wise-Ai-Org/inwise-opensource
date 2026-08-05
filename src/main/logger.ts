import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

let logPath: string | null = null;

// GUI launches do not always have a durable stdout/stderr consumer. For
// example, a launcher can exit while Electron keeps running, leaving the
// inherited pipe closed. Node emits EPIPE as a stream "error" event, so a
// try/catch around console.log is not enough and the main process would crash.
// The file log remains authoritative; console output is best-effort only.
for (const stream of [process.stdout, process.stderr]) {
  stream?.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') return;
    try {
      fs.appendFileSync(getLogPath(), `[${ts()}] WARN logger:console | ${error.message}\n`);
    } catch {
      // Logging must never crash the app.
    }
  });
}

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
