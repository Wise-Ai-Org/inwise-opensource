import { app, ipcMain, safeStorage, shell, IpcMainInvokeEvent } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { getMeeting } from './database';
import { draftOrgContext } from './work-brain-ai';

const devBuild = () => app.getVersion().includes('-dev.');
const apiBase = () => (process.env.INWISE_WORK_BRAIN_API_BASE || (devBuild() ? 'https://appwise-dev-final-a0dxcqcad3dyhpaa.westus-01.azurewebsites.net/api' : 'https://appwise-functions.azurewebsites.net/api')).replace(/\/$/, '');
const webBase = () => (process.env.INWISE_WORK_BRAIN_WEB_BASE || (devBuild() ? 'https://yellow-river-03906531e.7.azurestaticapps.net' : 'https://projects.inwise.ai')).replace(/\/$/, '');
type Binding = { token: string; organisationId: string; expiresAt: number };
let pending: { pairId: string; pollSecret: string; expiresAt: number } | null = null;
const bindingPath = () => path.join(app.getPath('userData'), 'org-work-brain.enc');
function readBinding(): Binding | null {
  if (!safeStorage.isEncryptionAvailable() || !fs.existsSync(bindingPath())) return null;
  try { return JSON.parse(safeStorage.decryptString(fs.readFileSync(bindingPath()))); }
  catch { throw new Error('The saved org connection could not be unlocked. Reconnect to your organisation.'); }
}
function writeBinding(binding: Binding) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable on this device.');
  const file = bindingPath(), temporary = file + '.tmp';
  fs.writeFileSync(temporary, safeStorage.encryptString(JSON.stringify(binding)), { mode: 0o600 });
  fs.renameSync(temporary, file);
}
async function request(action: string, data: Record<string, unknown> = {}) {
  if (new URL(apiBase()).protocol !== 'https:') throw new Error('The org connection requires HTTPS.');
  const response = await fetch(`${apiBase()}/desktop-work-brain`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...data }), signal: AbortSignal.timeout(20000) });
  let result: any;
  try { result = await response.json(); } catch { throw new Error('The org connection service is unavailable. Try again shortly.'); }
  if (!response.ok) throw new Error(result.error || 'The org connection could not complete. Try again.');
  return result;
}
async function connected(action: string, data: Record<string, unknown> = {}) {
  const binding = readBinding();
  if (!binding) throw new Error('Connect your organisation first.');
  return request(action, { ...data, connectionToken: binding.token });
}
export function registerWorkBrainHandlers() {
  const handle = (channel: string, handler: (event: IpcMainInvokeEvent, ...args: any[]) => any) => ipcMain.handle(channel, (event, ...args) => {
    let trusted = false;
    try { const url = new URL(event.senderFrame?.url || ''); trusted = url.protocol === 'app:' && url.hostname === 'bundle' && url.pathname === '/index.html'; } catch { /* Reject unknown senders. */ }
    if (!trusted) throw new Error('This page is not allowed to use the org connection.');
    return handler(event, ...args);
  });
  handle('work-brain:status', async () => readBinding() ? connected('status') : { connected: false });
  handle('work-brain:connect', async () => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is required to connect this device.');
    const result = await request('start');
    if (!/^[a-f0-9]{64}$/.test(result.pairId) || !/^[a-f0-9]{64}$/.test(result.pollSecret)) throw new Error('The service returned an invalid connection request.');
    pending = { pairId: result.pairId, pollSecret: result.pollSecret, expiresAt: result.expiresAt };
    const url = new URL('/desktop/connect', webBase());
    if (url.protocol !== 'https:') throw new Error('The org sign-in page requires HTTPS.');
    url.searchParams.set('pair', result.pairId);
    await shell.openExternal(url.href);
    return { verificationCode: result.verificationCode, expiresAt: result.expiresAt };
  });
  handle('work-brain:poll', async () => {
    if (!pending || pending.expiresAt < Date.now()) { pending = null; throw new Error('Connection request expired. Start again.'); }
    const result = await request('poll', { pairId: pending.pairId, pollSecret: pending.pollSecret });
    if (result.state === 'connected') {
      writeBinding({ token: result.token, organisationId: result.organisationId, expiresAt: result.expiresAt });
      pending = null;
      return { state: 'connected', organisationId: result.organisationId };
    }
    return { state: 'pending' };
  });
  handle('work-brain:catalogue', () => connected('catalogue'));
  handle('work-brain:draft', async (_event, meetingId: string) => {
    if (typeof meetingId !== 'string') throw new Error('Choose a source meeting.');
    const meeting = await getMeeting(meetingId);
    if (!meeting) throw new Error('The private source meeting is no longer available.');
    const catalogue = await connected('catalogue');
    return { drafts: await draftOrgContext(meeting, catalogue.projects || []) };
  });
  handle('work-brain:share', async (_event, contribution: any, sourceMeetingId?: string) => {
    if (sourceMeetingId && (typeof sourceMeetingId !== 'string' || !(await getMeeting(sourceMeetingId)))) throw new Error('The private source meeting is no longer available. Choose it again.');
    const result = await connected('share', { contribution });
    if (sourceMeetingId) {
      const file = path.join(app.getPath('userData'), 'org-work-brain-provenance.json');
      try {
        const entries = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
        entries[contribution.contributionId] = { meetingId: sourceMeetingId, organisationId: readBinding()?.organisationId, sharedAt: new Date().toISOString() };
        fs.writeFileSync(file + '.tmp', JSON.stringify(entries), { mode: 0o600 });
        fs.renameSync(file + '.tmp', file);
      } catch { throw new Error('The contribution was shared, but its private source reference could not be saved. Retry to save the local reference without duplicating the contribution.'); }
    }
    return result;
  });
  handle('work-brain:disconnect', async () => {
    await connected('disconnect');
    if (fs.existsSync(bindingPath())) fs.unlinkSync(bindingPath());
    pending = null;
    return { disconnected: true };
  });
  handle('work-brain:open', () => shell.openExternal(new URL('/org-work-brain', webBase()).href));
}
