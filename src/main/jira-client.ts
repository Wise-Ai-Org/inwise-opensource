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
      const scopes = 'read:jira-work write:jira-work offline_access';
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

async function jiraFetch(path: string, options: RequestInit = {}): Promise<any> {
  const config = getConfig();
  const tokens = (config as any).jiraTokens as JiraTokens;
  if (!tokens) throw new Error('Jira not connected');

  const token = await getValidToken();
  const url = `https://api.atlassian.com/ex/jira/${tokens.cloudId}/rest/api/3${path}`;

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
    if (!retry.ok) throw new Error(`Jira API error: ${retry.status}`);
    return retry.json();
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jira API error ${res.status}: ${body.slice(0, 300)}`);
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

export async function createJiraIssue(task: {
  title: string;
  description?: string;
  priority?: string;
  dueDate?: string;
  projectKey: string;
}): Promise<{ key: string; url: string }> {
  const config = getConfig();
  const tokens = (config as any).jiraTokens as JiraTokens;

  const fields: any = {
    project: { key: task.projectKey },
    summary: task.title,
    issuetype: { name: 'Task' },
  };

  if (task.description) {
    fields.description = textToAdf(task.description);
  }
  if (task.priority) {
    fields.priority = { name: PRIORITY_TO_JIRA[task.priority] || 'Medium' };
  }
  if (task.dueDate) {
    fields.duedate = task.dueDate.slice(0, 10); // YYYY-MM-DD
  }

  const data = await jiraFetch('/issue', {
    method: 'POST',
    body: JSON.stringify({ fields }),
  });

  const key = data.key;
  const url = `${tokens.cloudUrl}/browse/${key}`;
  log('info', 'jira:issue-created', `${key} — ${task.title}`);
  return { key, url };
}

export async function updateJiraIssue(issueKey: string, updates: {
  title?: string;
  description?: string;
  priority?: string;
  dueDate?: string;
}): Promise<void> {
  const fields: any = {};
  if (updates.title) fields.summary = updates.title;
  if (updates.description) fields.description = textToAdf(updates.description);
  if (updates.priority) fields.priority = { name: PRIORITY_TO_JIRA[updates.priority] || 'Medium' };
  if (updates.dueDate) fields.duedate = updates.dueDate.slice(0, 10);

  await jiraFetch(`/issue/${issueKey}`, {
    method: 'PUT',
    body: JSON.stringify({ fields }),
  });
  log('info', 'jira:issue-updated', issueKey);
}

export async function transitionJiraIssue(issueKey: string, targetStatus: string): Promise<void> {
  // Get available transitions
  const data = await jiraFetch(`/issue/${issueKey}/transitions`);
  const transitions = data.transitions || [];

  const statusMap: Record<string, string[]> = {
    completed: ['Done', 'Complete', 'Closed', 'Resolved'],
    inProgress: ['In Progress', 'Start Progress', 'In Development'],
    todo: ['To Do', 'Open', 'Backlog', 'Reopen'],
  };

  const targetNames = statusMap[targetStatus] || [];
  const match = transitions.find((t: any) => targetNames.some(n => t.name.toLowerCase().includes(n.toLowerCase())));

  if (match) {
    await jiraFetch(`/issue/${issueKey}/transitions`, {
      method: 'POST',
      body: JSON.stringify({ transition: { id: match.id } }),
    });
    log('info', 'jira:issue-transitioned', `${issueKey} → ${match.name}`);
  }
}

export async function addJiraComment(issueKey: string, comment: string, meetingTitle?: string): Promise<void> {
  const prefix = meetingTitle ? `[Inwise] From "${meetingTitle}":\n\n` : '[Inwise]\n\n';
  await jiraFetch(`/issue/${issueKey}/comment`, {
    method: 'POST',
    body: JSON.stringify({ body: textToAdf(prefix + comment) }),
  });
  log('info', 'jira:comment-added', issueKey);
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
