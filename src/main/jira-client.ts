/**
 * Jira Cloud client — handles OAuth 2.0 (PKCE), token management, and all
 * Atlassian REST API calls directly from the Electron main process.
 * No backend required.
 */

import * as http from 'http';
import * as crypto from 'crypto';
import { shell } from 'electron';
import { getConfig, setConfig } from './config';
import { log } from './logger';
import { markCompleted, PushParams } from './sor-write-log';
import { noTransitionMessage, pickTransition } from './jira-transitions';

// Writes: this module only performs the HTTP call (executeJiraPush). Every
// Jira write is gated, logged and made idempotent in jira-writes.ts.

// ── Types ────────────────────────────────────────────────────────────────────

export interface JiraTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  cloudId: string;
  cloudName: string;
  cloudUrl: string;
  accountId: string;
  email: string;
  displayName: string;
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
}

export interface JiraStory {
  jiraKey: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  epicName: string | null;
  issueType: string;
  parentKey: string | null;
  projectKey: string;
  jiraUrl: string;
  updatedAt: string;
}

// ── PKCE helpers ─────────────────────────────────────────────────────────────

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('hex');
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// ── ADF (Atlassian Document Format) ──────────────────────────────────────────

function textToAdf(text: string): any {
  return {
    type: 'doc',
    version: 1,
    content: text.split('\n').filter(Boolean).map(line => ({
      type: 'paragraph',
      content: [{ type: 'text', text: line }],
    })),
  };
}

function adfToText(adf: any): string {
  if (!adf || !adf.content) return '';
  return adf.content.map((block: any) => {
    if (!block.content) return '';
    return block.content.map((node: any) => node.text || '').join('');
  }).join('\n');
}

// ── Priority mapping ─────────────────────────────────────────────────────────

const PRIORITY_TO_JIRA: Record<string, string> = {
  critical: 'Highest', urgent: 'Highest', high: 'High', medium: 'Medium', low: 'Low',
};

const JIRA_TO_PRIORITY: Record<string, string> = {
  Highest: 'critical', High: 'high', Medium: 'medium', Low: 'low', Lowest: 'low',
};

// ── OAuth flow ───────────────────────────────────────────────────────────────

export async function connectJira(): Promise<{ ok: boolean; error?: string }> {
  const config = getConfig();
  const clientId = (config as any).jiraClientId;
  const clientSecret = (config as any).jiraClientSecret;

  if (!clientId || !clientSecret) {
    return { ok: false, error: 'Jira Client ID and Secret must be set in Settings first' };
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = crypto.randomBytes(16).toString('hex');

  return new Promise((resolve) => {
    // Start temp local server to capture OAuth redirect
    const server = http.createServer(async (req, res) => {
      if (!req.url?.startsWith('/callback')) {
        res.writeHead(404);
        res.end();
        return;
      }

      const url = new URL(req.url, 'http://localhost');
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');

      if (!code || returnedState !== state) {
        res.writeHead(400);
        res.end('Invalid OAuth callback');
        server.close();
        resolve({ ok: false, error: 'OAuth state mismatch or missing code' });
        return;
      }

      // Show success page
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Jira Connected!</h2><p>You can close this tab and return to Inwise.</p></body></html>');

      try {
        // Exchange code for tokens
        const tokenRes = await fetch('https://auth.atlassian.com/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'authorization_code',
            client_id: clientId,
            client_secret: clientSecret,
            code,
            redirect_uri: 'http://localhost:17291/callback',
            code_verifier: codeVerifier,
          }),
        });

        if (!tokenRes.ok) {
          const err = await tokenRes.text();
          log('error', 'jira:token-exchange', err);
          server.close();
          resolve({ ok: false, error: 'Token exchange failed' });
          return;
        }

        const tokenData = await tokenRes.json() as any;
        const accessToken = tokenData.access_token;
        const refreshToken = tokenData.refresh_token;
        const expiresAt = Date.now() + (tokenData.expires_in || 3600) * 1000;

        // Get accessible cloud instances
        const cloudRes = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const clouds = await cloudRes.json() as any[];
        if (!clouds.length) {
          server.close();
          resolve({ ok: false, error: 'No Jira Cloud instances found' });
          return;
        }
        const cloud = clouds[0];

        // Get user identity
        const myselfRes = await fetch(`https://api.atlassian.com/ex/jira/${cloud.id}/rest/api/3/myself`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const myself = await myselfRes.json() as any;

        const tokens: JiraTokens = {
          accessToken,
          refreshToken,
          expiresAt,
          cloudId: cloud.id,
          cloudName: cloud.name,
          cloudUrl: cloud.url,
          accountId: myself.accountId,
          email: myself.emailAddress || '',
          displayName: myself.displayName || '',
        };

        setConfig({ jiraTokens: tokens } as any);
        log('info', 'jira:connected', `${cloud.name} as ${myself.displayName}`);
        server.close();
        resolve({ ok: true });
      } catch (e: any) {
        log('error', 'jira:connect-failed', e.message);
        server.close();
        resolve({ ok: false, error: e.message });
      }
    });

    server.listen(17291, () => {
      // read:jira-user: user search (attendee lookup, "Find in Jira").
      // Sprints use the issue search and edit APIs, so no Jira Software scopes.
      const scopes = [
        'read:jira-work', 'write:jira-work', 'read:jira-user', 'offline_access',
        // Weekly personal data check-in (jira-personal-data.ts).
        'report:personal-data',
      ].join(' ');
      const authUrl = `https://auth.atlassian.com/authorize?audience=api.atlassian.com&client_id=${clientId}&scope=${encodeURIComponent(scopes)}&redirect_uri=${encodeURIComponent('http://localhost:17291/callback')}&state=${state}&response_type=code&prompt=consent&code_challenge=${codeChallenge}&code_challenge_method=S256`;
      shell.openExternal(authUrl);
      log('info', 'jira:oauth-started', 'opened browser for authorization');
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      resolve({ ok: false, error: 'OAuth timed out — please try again' });
    }, 5 * 60 * 1000);
  });
}

export function disconnectJira(): void {
  setConfig({ jiraTokens: null } as any);
  log('info', 'jira:disconnected', 'tokens cleared');
}

// ── Token refresh ────────────────────────────────────────────────────────────

async function getValidToken(): Promise<string> {
  const config = getConfig();
  const tokens = (config as any).jiraTokens as JiraTokens | null;
  if (!tokens) throw new Error('Jira not connected');

  // If token is valid for 5+ minutes, use it
  if (tokens.expiresAt > Date.now() + 5 * 60 * 1000) {
    return tokens.accessToken;
  }

  // Refresh
  const clientId = (config as any).jiraClientId;
  const clientSecret = (config as any).jiraClientSecret;

  const res = await fetch('https://auth.atlassian.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refreshToken,
    }),
  });

  if (!res.ok) throw new Error('Jira token refresh failed — please reconnect');

  const data = await res.json() as any;
  const updated: JiraTokens = {
    ...tokens,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || tokens.refreshToken,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };

  setConfig({ jiraTokens: updated } as any);
  log('info', 'jira:token-refreshed', 'access token renewed');
  return updated.accessToken;
}

/** Thrown for Jira HTTP errors so callers can tell "not allowed" from "not found". */
export class JiraHttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function jiraFetch(path: string, options: RequestInit = {}, api: 'core' | 'agile' = 'core'): Promise<any> {
  const config = getConfig();
  const tokens = (config as any).jiraTokens as JiraTokens;
  if (!tokens) throw new Error('Jira not connected');

  const token = await getValidToken();
  const base = api === 'agile' ? 'rest/agile/1.0' : 'rest/api/3';
  const url = `https://api.atlassian.com/ex/jira/${tokens.cloudId}/${base}${path}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });

  if (res.status === 401) {
    // Try one more refresh
    const newToken = await getValidToken();
    const retry = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${newToken}`,
        ...(options.headers || {}),
      },
    });
    if (!retry.ok) throw new JiraHttpError(retry.status, `Jira API error: ${retry.status}`);
    return retry.json();
  }

  if (!res.ok) {
    const body = await res.text();
    throw new JiraHttpError(res.status, `Jira API error ${res.status}: ${body.slice(0, 300)}`);
  }

  // Handle 204 No Content
  if (res.status === 204) return null;
  return res.json();
}

// ── API methods ──────────────────────────────────────────────────────────────

export async function getJiraProjects(): Promise<JiraProject[]> {
  const data = await jiraFetch('/project/search?maxResults=50&orderBy=name');
  return (data.values || []).map((p: any) => ({
    id: p.id,
    key: p.key,
    name: p.name,
  }));
}

export async function getJiraStories(projectKey?: string, maxDays = 60, maxResults = 100): Promise<JiraStory[]> {
  let jql = `issuetype in (Story, Task, Sub-task, Bug) AND updated >= -${maxDays}d ORDER BY updated DESC`;
  if (projectKey) jql = `project = ${projectKey} AND ${jql}`;

  const data = await jiraFetch('/search/jql', {
    method: 'POST',
    body: JSON.stringify({
      jql,
      maxResults: Math.min(maxResults, 200),
      fields: ['summary', 'status', 'priority', 'updated', 'project', 'customfield_10014', 'description', 'parent', 'issuetype'],
    }),
  });

  const config = getConfig();
  const tokens = (config as any).jiraTokens as JiraTokens;

  return (data.issues || []).map((issue: any) => ({
    jiraKey: issue.key,
    title: issue.fields.summary || '',
    description: issue.fields.description ? adfToText(issue.fields.description) : '',
    status: issue.fields.status?.name || '',
    priority: issue.fields.priority?.name || '',
    epicName: issue.fields.customfield_10014 || null,
    issueType: issue.fields.issuetype?.name || '',
    parentKey: issue.fields.parent?.key || null,
    projectKey: issue.fields.project?.key || '',
    jiraUrl: `${tokens.cloudUrl}/browse/${issue.key}`,
    updatedAt: issue.fields.updated || '',
  }));
}


/**
 * One page of POST /search/jql. Jira Cloud's enhanced search pages with
 * `nextPageToken` (no startAt/total); the last page has no token.
 */
export async function searchJiraIssuesPage(
  jql: string,
  fields: string[],
  nextPageToken?: string | null,
  maxResults = 100,
): Promise<{ issues: any[]; nextPageToken: string | null }> {
  const body: any = { jql, maxResults: Math.min(maxResults, 100), fields };
  if (nextPageToken) body.nextPageToken = nextPageToken;
  const data = await jiraFetch('/search/jql', { method: 'POST', body: JSON.stringify(body) });
  return { issues: data?.issues || [], nextPageToken: data?.isLast ? null : (data?.nextPageToken || null) };
}

/** Jira accountId for an email, or null. Email visibility depends on the site's privacy settings. */
export async function findJiraAccountIdByEmail(email: string): Promise<string | null> {
  if (!email || !email.includes('@')) return null;
  try {
    const rows = await jiraFetch(`/user/search?query=${encodeURIComponent(email)}&maxResults=2`);
    const exact = (rows || []).find((u: any) => (u.emailAddress || '').toLowerCase() === email.toLowerCase());
    const pick = exact || (Array.isArray(rows) && rows.length === 1 ? rows[0] : null);
    return pick?.accountId || null;
  } catch {
    return null;
  }
}

/** Custom field id of the Sprint field (differs per site), or null. */
export async function findSprintFieldId(): Promise<string | null> {
  try {
    const fields = await jiraFetch('/field');
    const sprint = (fields || []).find((f: any) => f?.schema?.custom === 'com.pyxis.greenhopper.jira:gh-sprint');
    return sprint?.id || null;
  } catch {
    return null;
  }
}

/**
 * Atlassian personal data reporting (jira-personal-data.ts): one batch of up
 * to 90 accounts. Returns the accounts that need action, or null for 204.
 */
export async function reportPersonalDataAccounts(
  accounts: { accountId: string; updatedAt: string }[],
): Promise<{ accountId: string; status: 'closed' | 'updated' }[] | null> {
  const send = async (token: string) => fetch('https://api.atlassian.com/app/report-accounts/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ accounts }),
  });
  let res = await send(await getValidToken());
  if (res.status === 401) res = await send(await getValidToken());
  if (res.status === 204) return null;
  if (!res.ok) {
    const err: any = new JiraHttpError(res.status, `Personal data report failed: ${res.status}`);
    const retry = Number(res.headers.get('retry-after'));
    if (Number.isFinite(retry)) err.retryAfterSec = retry;
    throw err;
  }
  const data = await res.json() as any;
  return Array.isArray(data?.accounts) ? data.accounts : [];
}

export function getJiraAccountId(): string | null {
  const tokens = (getConfig() as any).jiraTokens as JiraTokens | null;
  return tokens?.accountId || null;
}

export interface JiraIssueBrief {
  key: string;
  title: string;
  status: string | null;
  statusCategory: string | null;
  dueDate: string | null;
  description: string | null;
  priority: string | null;
}

/** Summary + status of one issue, for diffs and for showing the target ticket. */
export async function fetchIssueBrief(issueKey: string): Promise<JiraIssueBrief | null> {
  try {
    const current = await jiraFetch(`/issue/${issueKey}?fields=summary,status,duedate,description,priority`);
    if (!current) return null;
    return {
      key: issueKey,
      title: current.fields?.summary || '',
      status: current.fields?.status?.name ?? null,
      statusCategory: current.fields?.status?.statusCategory?.key ?? null,
      dueDate: current.fields?.duedate ?? null,
      description: current.fields?.description ? adfToText(current.fields.description) : null,
      priority: current.fields?.priority?.name ?? null,
    };
  } catch {
    return null;
  }
}

export function buildJiraIssueUrl(issueKey: string): string | null {
  const config = getConfig();
  const tokens = (config as any).jiraTokens as JiraTokens | null;
  if (!tokens?.cloudUrl) return null;
  return `${tokens.cloudUrl}/browse/${issueKey}`;
}

export function commentPrefix(meetingTitle?: string | null): string {
  return meetingTitle ? `[Inwise] From "${meetingTitle}":\n\n` : '[Inwise]\n\n';
}

export interface JiraUser { accountId: string; displayName: string; email: string | null; avatarUrl: string | null }

/** Jira users matching a name (or email). Only real people (accountType atlassian). */
export async function searchJiraUsers(query: string, max = 8): Promise<JiraUser[]> {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  const rows = await jiraFetch(`/user/search?query=${encodeURIComponent(q)}&maxResults=${Math.min(20, max)}`);
  return (Array.isArray(rows) ? rows : [])
    .filter((u: any) => u?.accountId && (u.accountType === undefined || u.accountType === 'atlassian') && u.active !== false)
    .map((u: any) => ({
      accountId: u.accountId,
      displayName: u.displayName || '',
      email: u.emailAddress || null,
      avatarUrl: u.avatarUrls?.['24x24'] || null,
    }));
}

export interface StatusChange { at: string; from: string | null; to: string | null }

/** Status changes from a changelog payload (GET /issue/{key}/changelog or expand=changelog), oldest first. */
export function parseStatusChanges(payload: any): StatusChange[] {
  const histories = Array.isArray(payload?.values) ? payload.values
    : Array.isArray(payload?.histories) ? payload.histories
      : Array.isArray(payload?.changelog?.histories) ? payload.changelog.histories : [];
  const out: StatusChange[] = [];
  for (const h of histories) {
    for (const item of Array.isArray(h?.items) ? h.items : []) {
      if (item?.field === 'status' || item?.fieldId === 'status') {
        out.push({ at: h.created, from: item.fromString ?? null, to: item.toString ?? null });
      }
    }
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** Status changes for one issue (newest 100 changelog entries). */
export async function fetchIssueStatusChanges(issueKey: string): Promise<StatusChange[]> {
  const data = await jiraFetch(`/issue/${encodeURIComponent(issueKey)}/changelog?maxResults=100`);
  // The endpoint pages oldest-first; on long histories jump to the last page.
  if (data && typeof data.total === 'number' && data.total > (data.values?.length || 0) && !data.isLast) {
    const startAt = Math.max(0, data.total - 100);
    const last = await jiraFetch(`/issue/${encodeURIComponent(issueKey)}/changelog?startAt=${startAt}&maxResults=100`);
    return parseStatusChanges(last);
  }
  return parseStatusChanges(data);
}

export type SprintLookup =
  | { ok: true; sprintId: number; sprintName: string; state: string; boardId: number }
  | { ok: false; reason: string };

/**
 * The active (or next) sprint of this issue's project. Uses an ordinary issue
 * search (read:jira-work) instead of the Jira Software board API, so no extra
 * permissions are needed: tickets in an open (or future) sprint carry that
 * sprint on their Sprint field. A sprint nobody has put a ticket in yet is not
 * found. Reasons read as plain sentences for the recap row.
 */
export async function findSprintForIssue(issueKey: string, prefer: 'active' | 'next' = 'active'): Promise<SprintLookup> {
  const projectKey = issueKey.split('-')[0];
  try {
    const fieldId = await findSprintFieldId();
    if (!fieldId) return { ok: false, reason: `This Jira site has no sprints, so there is no sprint to add ${issueKey} to` };
    const collect = async (fn: 'openSprints' | 'futureSprints') => {
      const res = await searchJiraIssuesPage(`project = "${projectKey}" AND sprint in ${fn}()`, [fieldId], null, 50);
      const out = new Map<number, any>();
      for (const issue of res.issues) {
        const raw = issue?.fields?.[fieldId];
        for (const sp of Array.isArray(raw) ? raw : raw ? [raw] : []) if (sp && typeof sp.id === 'number') out.set(sp.id, sp);
      }
      return [...out.values()];
    };
    const active = (await collect('openSprints')).find((v) => v.state === 'active');
    const future = prefer === 'next' || !active
      ? (await collect('futureSprints')).filter((v) => v.state === 'future')
        .sort((a, b) => (Date.parse(a.startDate || '') || Infinity) - (Date.parse(b.startDate || '') || Infinity) || a.id - b.id)[0]
      : undefined;
    const pick = prefer === 'next' ? (future || active) : (active || future);
    if (pick) return { ok: true, sprintId: pick.id, sprintName: pick.name, state: pick.state, boardId: pick.boardId ?? 0 };
    return { ok: false, reason: `${projectKey} has no active or upcoming sprint` };
  } catch (e: any) {
    if (e instanceof JiraHttpError && e.status === 400) return { ok: false, reason: `${projectKey} has no active or upcoming sprint` };
    return { ok: false, reason: `Could not read ${projectKey}'s sprints (${e?.message || 'Jira error'})` };
  }
}

/**
 * Perform the raw Jira call for an already-logged write and stamp the result
 * on its sor-writes entry. Only jira-writes.ts calls this, after the gate.
 */
export async function executeJiraPush(
  id: string,
  pushParams: PushParams,
): Promise<{ ok: boolean; error?: string; key?: string; url?: string | null }> {
  const p = pushParams;
  try {
    if (p.operation === 'create') {
      const fields: any = {
        project: { key: p.args.projectKey },
        summary: p.args.title,
        issuetype: { name: 'Task' },
      };
      if (p.args.description) fields.description = textToAdf(p.args.description);
      if (p.args.priority) fields.priority = { name: PRIORITY_TO_JIRA[p.args.priority] || 'Medium' };
      if (p.args.dueDate) fields.duedate = p.args.dueDate.slice(0, 10);
      const data = await jiraFetch('/issue', { method: 'POST', body: JSON.stringify({ fields }) });
      const key = data.key;
      const url = buildJiraIssueUrl(key);
      await markCompleted(id, 'success', undefined, { targetRecordId: key, targetRecordUrl: url });
      log('info', 'jira:issue-created', `${key}: ${p.args.title}`);
      return { ok: true, key, url };
    }
    if (p.operation === 'update') {
      const fields: any = {};
      if (p.args.updates.title) fields.summary = p.args.updates.title;
      if (p.args.updates.description) fields.description = textToAdf(p.args.updates.description);
      if (p.args.updates.priority) fields.priority = { name: PRIORITY_TO_JIRA[p.args.updates.priority] || 'Medium' };
      if (p.args.updates.dueDate) fields.duedate = p.args.updates.dueDate.slice(0, 10);
      await jiraFetch(`/issue/${p.args.issueKey}`, { method: 'PUT', body: JSON.stringify({ fields }) });
      await markCompleted(id, 'success');
      log('info', 'jira:issue-updated', p.args.issueKey);
      return { ok: true, key: p.args.issueKey, url: buildJiraIssueUrl(p.args.issueKey) };
    }
    if (p.operation === 'transition') {
      const data = await jiraFetch(`/issue/${p.args.issueKey}/transitions`);
      const match = pickTransition(data?.transitions || [], p.args.targetStatus);
      if (!match) {
        const msg = noTransitionMessage(p.args.issueKey, p.args.targetStatus);
        log('warn', 'jira:issue-transition-no-match', msg);
        await markCompleted(id, 'failed', msg);
        return { ok: false, error: msg };
      }
      await jiraFetch(`/issue/${p.args.issueKey}/transitions`, {
        method: 'POST',
        body: JSON.stringify({ transition: { id: match.id } }),
      });
      await markCompleted(id, 'success');
      log('info', 'jira:issue-transitioned', `${p.args.issueKey} to ${match.to?.name || match.name}`);
      return { ok: true, key: p.args.issueKey, url: buildJiraIssueUrl(p.args.issueKey) };
    }
    if (p.operation === 'comment') {
      await jiraFetch(`/issue/${p.args.issueKey}/comment`, {
        method: 'POST',
        body: JSON.stringify({ body: textToAdf(commentPrefix(p.args.meetingTitle) + p.args.comment) }),
      });
      await markCompleted(id, 'success');
      log('info', 'jira:comment-added', p.args.issueKey);
      return { ok: true, key: p.args.issueKey, url: buildJiraIssueUrl(p.args.issueKey) };
    }
    if (p.operation === 'assign') {
      if (!p.args.accountId) {
        const msg = `Find ${p.args.assigneeName} in Jira before assigning ${p.args.issueKey}`;
        await markCompleted(id, 'failed', msg);
        return { ok: false, error: msg };
      }
      await jiraFetch(`/issue/${p.args.issueKey}/assignee`, { method: 'PUT', body: JSON.stringify({ accountId: p.args.accountId }) });
      await markCompleted(id, 'success');
      log('info', 'jira:issue-assigned', p.args.issueKey);
      return { ok: true, key: p.args.issueKey, url: buildJiraIssueUrl(p.args.issueKey) };
    }
    if (p.operation === 'link') {
      // "Blocks": the outward issue blocks the inward one (inward reads "is blocked by").
      await jiraFetch('/issueLink', {
        method: 'POST',
        body: JSON.stringify({ type: { name: 'Blocks' }, outwardIssue: { key: p.args.blockerKey }, inwardIssue: { key: p.args.blockedKey } }),
      });
      await markCompleted(id, 'success');
      log('info', 'jira:issue-linked', `${p.args.blockerKey} blocks ${p.args.blockedKey}`);
      return { ok: true, key: p.args.blockedKey, url: buildJiraIssueUrl(p.args.blockedKey) };
    }
    if (p.operation === 'sprint') {
      if (!p.args.sprintId) {
        const msg = p.args.reason || `No sprint found for ${p.args.issueKey}`;
        await markCompleted(id, 'failed', msg);
        return { ok: false, error: msg };
      }
      // Ordinary issue edit (write:jira-work): set the Sprint field to the sprint id.
      const sprintField = await findSprintFieldId();
      if (!sprintField) {
        const msg = 'This Jira site has no Sprint field';
        await markCompleted(id, 'failed', msg);
        return { ok: false, error: msg };
      }
      await jiraFetch(`/issue/${encodeURIComponent(p.args.issueKey)}`, { method: 'PUT', body: JSON.stringify({ fields: { [sprintField]: p.args.sprintId } }) });
      await markCompleted(id, 'success');
      log('info', 'jira:issue-sprint', `${p.args.issueKey} to ${p.args.sprintName || p.args.sprintId}`);
      return { ok: true, key: p.args.issueKey, url: buildJiraIssueUrl(p.args.issueKey) };
    }
    await markCompleted(id, 'failed', 'Unknown operation');
    return { ok: false, error: 'Unknown operation' };
  } catch (err: any) {
    const msg = err instanceof JiraHttpError && (err.status === 401 || err.status === 403)
      ? `Jira did not allow this change (${err.status}). Reconnect Jira in Settings, or check your permissions on ${'args' in p ? (p.args as any).issueKey || (p.args as any).blockedKey || 'the issue' : 'the issue'}`
      : err.message;
    await markCompleted(id, 'failed', msg);
    return { ok: false, error: msg };
  }
}

export function isJiraConnected(): boolean {
  const config = getConfig();
  return !!(config as any).jiraTokens?.accessToken;
}

export function getJiraInfo(): { cloudName: string; email: string; cloudUrl: string } | null {
  const config = getConfig();
  const tokens = (config as any).jiraTokens as JiraTokens | null;
  if (!tokens) return null;
  return { cloudName: tokens.cloudName, email: tokens.email, cloudUrl: tokens.cloudUrl };
}

export { adfToText, JIRA_TO_PRIORITY };
