import * as http from 'http';
import { app } from 'electron';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getMeetings, getMeeting, getTasks } from './database';
import { log } from './logger';

/**
 * Local MCP server ("Connect to AI").
 *
 * Serves the app's local meeting store to MCP clients (Claude Desktop,
 * Claude Code, etc.) over Streamable HTTP. Strictly read-only, strictly
 * loopback: the listener binds to 127.0.0.1 and every request is additionally
 * checked for a loopback peer address and a localhost Host header (defense
 * against DNS-rebinding). No auth is used: the surface never leaves the
 * machine. Caveat: on a multi-user machine, loopback is shared across OS
 * accounts, so another local user could query this port while the app runs.
 * Disable the server in Settings → Connect to AI on shared machines.
 */

export const MCP_DEFAULT_PORT = 43117;
export const MCP_PATH = '/mcp';

/** Keep single get_meeting responses comfortably under ~50 KB. */
export const TRANSCRIPT_CHUNK_CHARS = 48 * 1024;

const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 50;
const SNIPPET_RADIUS = 120;

// ── Tool handlers (exported for tests; no HTTP or Electron required) ─────────

function truncate(text: string, max: number): string {
  if (!text || text.length <= max) return text || '';
  return text.slice(0, max) + '…';
}

/** Extract a short snippet around the first case-insensitive match. */
export function extractSnippet(text: string, query: string): string | null {
  if (!text) return null;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return null;
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(text.length, idx + query.length + SNIPPET_RADIUS);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

export async function searchMeetingsHandler(args: { query: string; limit?: number }): Promise<any> {
  const query = (args.query || '').trim();
  if (!query) return { error: 'query must not be empty' };
  const limit = Math.min(Math.max(1, Math.floor(args.limit ?? SEARCH_DEFAULT_LIMIT)), SEARCH_MAX_LIMIT);
  const q = query.toLowerCase();

  const meetings = await getMeetings();
  const results: any[] = [];
  for (const m of meetings) {
    const titleHit = (m.title || '').toLowerCase().includes(q);
    const summaryHit = (m.insights?.summary || '').toLowerCase().includes(q);
    const transcriptHit = !titleHit && !summaryHit && (m.transcript || '').toLowerCase().includes(q);
    if (!titleHit && !summaryHit && !transcriptHit) continue;

    results.push({
      meetingId: m._id,
      title: m.title,
      date: m.date,
      source: m.source,
      status: m.status,
      attendees: m.attendees || [],
      matchedIn: titleHit ? 'title' : summaryHit ? 'summary' : 'transcript',
      snippet: transcriptHit
        ? extractSnippet(m.transcript || '', query)
        : summaryHit
          ? extractSnippet(m.insights?.summary || '', query)
          : null,
      hasTranscript: !!m.transcript,
      actionItemCount: m.insights?.actionItems?.length || 0,
      decisionCount: m.insights?.decisions?.length || 0,
    });
    if (results.length >= limit) break;
  }
  return { query, total: results.length, results };
}

export async function getMeetingHandler(args: { meetingId: string; transcriptOffset?: number }): Promise<any> {
  const m = await getMeeting(args.meetingId);
  if (!m) return { error: `No meeting found with id "${args.meetingId}"` };

  const transcript: string = m.transcript || '';
  const offset = Math.max(0, Math.floor(args.transcriptOffset ?? 0));
  const chunk = transcript.slice(offset, offset + TRANSCRIPT_CHUNK_CHARS);
  const nextOffset = offset + chunk.length < transcript.length ? offset + chunk.length : null;

  return {
    meetingId: m._id,
    title: m.title,
    date: m.date,
    duration: m.duration || 0,
    source: m.source,
    status: m.status,
    attendees: m.attendees || [],
    insights: m.insights
      ? {
          summary: m.insights.summary || null,
          actionItems: m.insights.actionItems || [],
          decisions: m.insights.decisions || [],
          blockers: m.insights.blockers || [],
          commitments: m.insights.commitments || [],
          contradictions: m.insights.contradictions || [],
        }
      : null,
    transcript: {
      totalChars: transcript.length,
      offset,
      chunk,
      // Pass nextOffset back as transcriptOffset to page through long transcripts.
      nextOffset,
    },
  };
}

export async function listActionItemsHandler(args: { status?: string; meetingId?: string; limit?: number }): Promise<any> {
  const limit = Math.min(Math.max(1, Math.floor(args.limit ?? 50)), 200);
  // Action items live in the tasks store (auto-extracted from meeting insights
  // plus manually created ones). Include snoozed so the view is complete.
  const tasks = await getTasks({ includeSnoozed: true });
  const filtered = tasks.filter((t: any) => {
    if (args.status && t.status !== args.status) return false;
    if (args.meetingId) {
      const mid = t.source?.id || t.provenance?.meetingId;
      if (mid !== args.meetingId) return false;
    }
    return true;
  });
  return {
    total: filtered.length,
    actionItems: filtered.slice(0, limit).map((t: any) => ({
      taskId: t._id,
      title: t.title,
      description: truncate(t.description || '', 500),
      status: t.status,
      priority: t.priority,
      dueDate: t.dueDate || null,
      sourceMeetingId: t.source?.type === 'meeting' ? t.source.id : null,
      aiExtracted: !!t.aiExtracted,
      snoozed: t.snoozedAt != null,
      createdAt: t.createdAt,
    })),
  };
}

function getAppVersion(): string {
  try {
    const v = (app as any)?.getVersion?.();
    if (v) return v;
  } catch {
    /* not running under Electron (tests) */
  }
  try {
    // dist/main/mcp-server.js → ../../package.json (repo root / packaged app root)
    return require('../../package.json').version || 'unknown';
  } catch {
    return 'unknown';
  }
}

export function whoamiHandler(): any {
  return {
    app: 'Inwise (open source)',
    version: getAppVersion(),
    mode: 'local',
    storage: 'local NeDB files on this machine',
    access: 'read-only',
    server: `http://127.0.0.1:${currentPort ?? MCP_DEFAULT_PORT}${MCP_PATH}`,
  };
}

// ── Loopback / Host-header guards (exported for tests) ───────────────────────

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  if (addr === '::1') return true;
  const v4 = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  return v4.startsWith('127.');
}

export function isAllowedHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  // Strip port. Handles "127.0.0.1:43117", "localhost:43117", "[::1]:43117".
  const hostname = host.startsWith('[')
    ? host.slice(1, host.indexOf(']') === -1 ? host.length : host.indexOf(']'))
    : host.split(':')[0];
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

// ── MCP server assembly ───────────────────────────────────────────────────────

function toText(result: any): { content: { type: 'text'; text: string }[]; isError?: boolean } {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    ...(result && result.error ? { isError: true } : {}),
  };
}

/**
 * Registration goes through this wrapper for two reasons: every tool on this
 * server is read-only by design (readOnlyHint is applied centrally), and the
 * SDK's zod-generic inference on registerTool hits TS2589 ("excessively deep")
 * under this repo's TypeScript 5.3 — the cast sidesteps the inference while
 * mcp-server.test.ts verifies the actual wire behavior (tool list, annotations,
 * schemas, calls).
 */
function registerReadOnlyTool(
  server: McpServer,
  name: string,
  cfg: { title: string; description: string; inputSchema: Record<string, z.ZodTypeAny> },
  handler: (args: any) => any
): void {
  (server.registerTool as any)(
    name,
    { ...cfg, annotations: { readOnlyHint: true } },
    async (args: any) => toText(await handler(args))
  );
}

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: 'inwise-local', version: getAppVersion() });

  registerReadOnlyTool(
    server,
    'search_meetings',
    {
      title: 'Search meetings',
      description:
        'Keyword search over the meetings recorded or imported on this machine. Matches titles, AI summaries, and transcript text. Returns meeting ids to pass to get_meeting.',
      inputSchema: {
        query: z.string().describe('Keyword or phrase to search for'),
        limit: z.number().int().min(1).max(SEARCH_MAX_LIMIT).optional().describe(`Max results (default ${SEARCH_DEFAULT_LIMIT})`),
      },
    },
    searchMeetingsHandler
  );

  registerReadOnlyTool(
    server,
    'get_meeting',
    {
      title: 'Get meeting',
      description:
        'Fetch one meeting: metadata, AI insights (summary, action items, decisions, blockers, commitments), and the transcript. Long transcripts are paged — pass transcript.nextOffset back as transcriptOffset for the next chunk.',
      inputSchema: {
        meetingId: z.string().describe('Meeting id from search_meetings'),
        transcriptOffset: z.number().int().min(0).optional().describe('Character offset into the transcript (default 0)'),
      },
    },
    getMeetingHandler
  );

  registerReadOnlyTool(
    server,
    'list_action_items',
    {
      title: 'List action items',
      description:
        'List action items / tasks tracked on this machine (auto-extracted from meetings plus manually created). Filter by status or source meeting.',
      inputSchema: {
        status: z.string().optional().describe('Filter by status, e.g. "todo" or "done"'),
        meetingId: z.string().optional().describe('Only items extracted from this meeting'),
        limit: z.number().int().min(1).max(200).optional().describe('Max results (default 50)'),
      },
    },
    listActionItemsHandler
  );

  registerReadOnlyTool(
    server,
    'whoami',
    {
      title: 'Who am I',
      description: 'Returns app version and confirms this is the local, read-only Inwise data on this machine.',
      inputSchema: {},
    },
    whoamiHandler
  );

  return server;
}

// ── HTTP lifecycle ────────────────────────────────────────────────────────────

let httpServer: http.Server | null = null;
let currentPort: number | null = null;
let lastError: string | null = null;

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // Defense in depth: the listener is bound to 127.0.0.1, but reject any
  // non-loopback peer and any non-localhost Host header (DNS rebinding).
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Loopback connections only' }));
    return;
  }
  if (!isAllowedHostHeader(req.headers.host)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid Host header' }));
    return;
  }

  const pathname = (req.url || '').split('?')[0];
  if (pathname !== MCP_PATH) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found. The MCP endpoint is ' + MCP_PATH }));
    return;
  }

  if (req.method !== 'POST') {
    // Stateless mode: no SSE stream to resume, no session to delete.
    res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed. This stateless MCP endpoint only accepts POST.' },
        id: null,
      })
    );
    return;
  }

  // Stateless: fresh server + transport per request, torn down when the
  // response closes. Keeps requests fully isolated for concurrent clients.
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err: any) {
    log('error', 'mcp:request', err?.message || String(err));
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        })
      );
    }
  }
}

export async function startMcpServer(port?: number): Promise<{ ok: boolean; port: number | null; error?: string }> {
  const desiredPort = port ?? currentPort ?? MCP_DEFAULT_PORT;
  await stopMcpServer();

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      void handleRequest(req, res);
    });
    server.on('error', (err: any) => {
      lastError =
        err?.code === 'EADDRINUSE'
          ? `Port ${desiredPort} is already in use — pick a different port.`
          : err?.message || String(err);
      log('error', 'mcp:server', lastError!);
      httpServer = null;
      currentPort = null;
      resolve({ ok: false, port: null, error: lastError! });
    });
    server.listen(desiredPort, '127.0.0.1', () => {
      httpServer = server;
      const addr = server.address();
      currentPort = typeof addr === 'object' && addr ? addr.port : desiredPort;
      lastError = null;
      log('info', 'mcp:server', `Local MCP server listening on http://127.0.0.1:${currentPort}${MCP_PATH}`);
      resolve({ ok: true, port: currentPort });
    });
  });
}

export async function stopMcpServer(): Promise<void> {
  if (!httpServer) return;
  const server = httpServer;
  httpServer = null;
  currentPort = null;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // Don't wait on open keep-alive sockets.
    server.closeAllConnections?.();
  });
  log('info', 'mcp:server', 'Local MCP server stopped');
}

export function getMcpStatus(): { running: boolean; port: number | null; error: string | null } {
  return { running: httpServer !== null, port: currentPort, error: lastError };
}
