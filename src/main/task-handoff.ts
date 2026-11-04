/**
 * Hand a task to an AI agent.
 *
 * Agents (Claude Code, Codex): Inwise opens a terminal in the folder the user
 * picked and starts a new session with a short opening prompt. The prompt
 * names only the task id; the agent reads the task and its meeting through the
 * local MCP server ("Connect to AI") and, with write-back on, saves its plan
 * and outcome to the task. The MCP server is attached for that one session
 * (--mcp-config / -c), so nothing is written to the user's Claude or Codex
 * settings.
 *
 * Chats (Claude, ChatGPT): their MCP connectors run in the vendor's cloud and
 * cannot reach 127.0.0.1, so Inwise copies the task and a short meeting excerpt
 * to the clipboard and opens a new chat for the user to paste into. Nothing is
 * put in the URL.
 */

export type AgentClient = 'claude-code' | 'codex';
export type ChatClient = 'claude-chat' | 'chatgpt';
export type HandoffTarget = AgentClient | ChatClient;

export const AGENT_LABEL: Record<AgentClient, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };
export const CHAT_LABEL: Record<ChatClient, string> = { 'claude-chat': 'Claude', chatgpt: 'ChatGPT' };
export const CHAT_URL: Record<ChatClient, string> = {
  'claude-chat': 'https://claude.ai/new',
  chatgpt: 'https://chatgpt.com/',
};
const AGENT_COMMAND: Record<AgentClient, string> = { 'claude-code': 'claude', codex: 'codex' };
export const MCP_SERVER_NAME = 'inwise';

export function isAgent(t: string): t is AgentClient { return t === 'claude-code' || t === 'codex'; }
export function isChat(t: string): t is ChatClient { return t === 'claude-chat' || t === 'chatgpt'; }

/**
 * Task ids are interpolated into a shell script, so only plain id characters
 * are accepted (nedb ids are alphanumeric).
 */
export function isSafeTaskId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

/**
 * The opening prompt. Fixed text plus the task id only: no titles or meeting
 * text, so nothing user-written reaches the shell, and the agent fetches the
 * full context itself. Must stay free of characters cmd.exe or sh treat
 * specially (quotes, &, |, <, >, ^, %, !, $, backticks, parentheses).
 */
export function buildAgentPrompt(taskId: string, client: AgentClient, writeback: boolean): string {
  if (!isSafeTaskId(taskId)) throw new Error('invalid task id');
  const lines = [
    `You are picking up Inwise task ${taskId}.`,
    `First call the inwise MCP tool get_action_item with actionItemId ${taskId}, then read its source meeting with get_meeting, and get_transcript only if you need the exact wording.`,
    'Tell me in a few sentences what the task is and who asked for it, then propose a short plan and wait for my OK before changing anything.',
  ];
  if (writeback) {
    lines.push(
      `Once I approve, record the plan with start_action_execution, using client ${client}.`,
      'As you work, save progress and the final result with append_action_outcome, and set the task status with update_action_status. Only mark it completed if the work is done and checked.',
    );
  } else {
    lines.push('Saving results back to Inwise is turned off, so give me a summary at the end instead.');
  }
  return lines.join(' ');
}

const UNSAFE_PROMPT_CHARS = /["'`&|<>^%!$()\r\n]/;
export function isShellSafePrompt(p: string): boolean { return !UNSAFE_PROMPT_CHARS.test(p); }

export function mcpUrl(port: number): string { return `http://127.0.0.1:${port}/mcp`; }

/** Claude Code --mcp-config file: attaches Inwise for one session only. */
export function claudeMcpConfig(port: number): string {
  return JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url: mcpUrl(port) } } }, null, 2);
}

/** Quote a path for cmd.exe. Paths with a double quote are refused upstream. */
function cmdQuote(s: string): string { return `"${s}"`; }
function shQuote(s: string): string { return `'${s.replace(/'/g, `'\\''`)}'`; }

export interface ScriptInput {
  platform: NodeJS.Platform;
  client: AgentClient;
  folder: string;
  prompt: string;
  port: number;
  /** Claude Code only: path of the per-session MCP config file. */
  mcpConfigPath?: string;
  taskTitle?: string;
}

/** The command line that starts the agent, without the cd. */
export function agentCommand(input: ScriptInput): string {
  const { client, prompt, port, platform } = input;
  if (!isShellSafePrompt(prompt)) throw new Error('prompt contains shell characters');
  const q = platform === 'win32' ? cmdQuote : shQuote;
  const exe = AGENT_COMMAND[client];
  if (client === 'claude-code') {
    if (!input.mcpConfigPath) throw new Error('missing MCP config path');
    // Prompt first: --mcp-config takes several files and would swallow it.
    return `${exe} ${q(prompt)} --mcp-config ${q(input.mcpConfigPath)}`;
  }
  // Codex: a -c value that is not valid TOML is taken as a literal string.
  return `${exe} -c mcp_servers.${MCP_SERVER_NAME}.url=${mcpUrl(port)} ${q(prompt)}`;
}

/** A small script the terminal runs: header, cd into the folder, start the agent. */
export function buildLaunchScript(input: ScriptInput): string {
  const label = AGENT_LABEL[input.client];
  if (input.folder.includes('"') || /[\r\n]/.test(input.folder)) throw new Error('unsupported folder path');
  const cmd = agentCommand(input);
  if (input.platform === 'win32') {
    return [
      '@echo off',
      `title Inwise: ${label}`,
      'echo.',
      `echo   Inwise handed this task to ${label}.`,
      'echo   Approve its plan here. Its results show up on the task in Inwise.',
      'echo.',
      `cd /d ${cmdQuote(input.folder)}`,
      `where ${AGENT_COMMAND[input.client]} >nul 2>nul || (echo   ${label} is not installed or not on PATH. & echo   ${installHint(input.client)} & pause & exit /b 1)`,
      cmd,
      '',
    ].join('\r\n');
  }
  return [
    '#!/bin/sh',
    `printf '\\n  Inwise handed this task to ${label}.\\n  Approve its plan here. Its results show up on the task in Inwise.\\n\\n'`,
    `cd ${shQuote(input.folder)} || exit 1`,
    `command -v ${AGENT_COMMAND[input.client]} >/dev/null 2>&1 || { echo '  ${label} is not installed or not on PATH.'; echo '  ${installHint(input.client)}'; exit 1; }`,
    cmd,
    '',
  ].join('\n');
}

export function installHint(client: AgentClient): string {
  return client === 'claude-code'
    ? 'Install it with: npm install -g @anthropic-ai/claude-code'
    : 'Install it with: npm install -g @openai/codex';
}

/** How the terminal is opened for a script. */
export function terminalCommand(platform: NodeJS.Platform, scriptPath: string, hasWindowsTerminal: boolean): { file: string; args: string[] } {
  if (platform === 'win32') {
    return hasWindowsTerminal
      ? { file: 'wt.exe', args: ['new-tab', '--title', 'Inwise', 'cmd.exe', '/k', scriptPath] }
      : { file: 'cmd.exe', args: ['/c', 'start', '""', 'cmd.exe', '/k', `"${scriptPath}"`] };
  }
  if (platform === 'darwin') return { file: 'open', args: ['-a', 'Terminal', scriptPath] };
  return { file: 'x-terminal-emulator', args: ['-e', 'sh', scriptPath] };
}

// ── Chat hand-off ──────────────────────────────────────────────────────────

export interface TaskLike {
  _id: string;
  title?: string;
  description?: string | null;
  owner?: string | null;
  dueDate?: string | null;
  priority?: string | null;
  status?: string | null;
  taskMentions?: { excerpt?: string | null }[];
}
export interface MeetingLike { title?: string | null; date?: string | null; summary?: string | null }

const EXCERPT_MAX = 600;
const SUMMARY_MAX = 1200;
function clip(s: string, n: number): string { return s.length > n ? s.slice(0, n).trimEnd() + '…' : s; }

/** Text copied for a chat: the task, a short excerpt, and what to do with it. */
export function buildChatContext(task: TaskLike, meeting: MeetingLike | null): string {
  const out: string[] = ['I need help with a task from one of my meetings.', '', `Task: ${task.title || 'Untitled task'}`];
  if (task.description) out.push(`Details: ${task.description.trim()}`);
  if (task.owner) out.push(`Owner: ${task.owner}`);
  if (task.dueDate) {
    const d = new Date(task.dueDate);
    if (!Number.isNaN(d.getTime())) out.push(`Due: ${d.toDateString()}`);
  }
  if (task.priority) out.push(`Priority: ${task.priority}`);
  if (meeting) {
    const when = meeting.date ? new Date(meeting.date) : null;
    out.push('', `From the meeting: ${meeting.title || 'Untitled meeting'}${when && !Number.isNaN(when.getTime()) ? ` (${when.toDateString()})` : ''}`);
    if (meeting.summary) out.push(`Meeting summary: ${clip(meeting.summary.trim(), SUMMARY_MAX)}`);
  }
  const excerpt = task.taskMentions?.find(m => m.excerpt)?.excerpt;
  if (excerpt) out.push(`What was said: "${clip(excerpt.trim(), EXCERPT_MAX)}"`);
  out.push('', 'Help me get this done: tell me what it involves, suggest the first steps, and draft anything I need to send.');
  return out.join('\n');
}

// ── Readiness ──────────────────────────────────────────────────────────────

export interface HandoffReadiness {
  serverRunning: boolean;
  serverEnabled: boolean;
  writeback: boolean;
  folder: string | null;
  installed: Record<AgentClient, boolean>;
  introSeen: boolean;
}

/** What still blocks an agent hand-off, as user-facing sentences. */
export function agentBlockers(r: HandoffReadiness, client: AgentClient): string[] {
  const out: string[] = [];
  if (!r.serverEnabled) out.push('Connect to AI is turned off, so the agent cannot read your tasks.');
  else if (!r.serverRunning) out.push('Inwise could not start its local connection for AI tools. Check Settings, Connect to AI.');
  if (!r.folder) out.push('Pick the folder the agent should work in.');
  if (!r.installed[client]) out.push(`${AGENT_LABEL[client]} is not installed on this computer.`);
  return out;
}
