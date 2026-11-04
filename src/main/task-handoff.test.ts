import * as assert from 'node:assert/strict';
import {
  agentBlockers, agentCommand, buildAgentPrompt, buildChatContext, buildLaunchScript, claudeMcpConfig,
  isShellSafePrompt, isSafeTaskId, terminalCommand, HandoffReadiness,
} from './task-handoff';

async function run(): Promise<void> {
  // Task ids: only plain id characters reach a shell script.
  assert.equal(isSafeTaskId('aB3_x-9'), true);
  for (const bad of ['', 'a b', 'a&calc', 'a"b', '../x', 'x'.repeat(65), 42 as any, null as any]) {
    assert.equal(isSafeTaskId(bad), false, `rejects ${bad}`);
  }
  assert.throws(() => buildAgentPrompt('a&b', 'codex', true));

  // The opening prompt names the task and the tools, and has no shell characters.
  for (const client of ['claude-code', 'codex'] as const) {
    for (const wb of [true, false]) {
      const p = buildAgentPrompt('T123', client, wb);
      assert.ok(isShellSafePrompt(p), `prompt is shell-safe (${client}, ${wb})`);
      assert.ok(p.includes('get_action_item with actionItemId T123'));
      assert.ok(p.includes('wait for my OK'));
      assert.equal(p.includes('start_action_execution'), wb);
      if (wb) assert.ok(p.includes(`client ${client}`));
    }
  }

  // Claude Code gets the MCP server for this session only.
  const cfg = JSON.parse(claudeMcpConfig(43117));
  assert.deepEqual(cfg, { mcpServers: { inwise: { type: 'http', url: 'http://127.0.0.1:43117/mcp' } } });

  const prompt = buildAgentPrompt('T1', 'claude-code', true);
  assert.equal(
    agentCommand({ platform: 'win32', client: 'claude-code', folder: 'C:\\w', prompt, port: 43117, mcpConfigPath: 'C:\\u\\c.json' }),
    `claude --mcp-config "C:\\u\\c.json" "${prompt}"`,
  );
  assert.equal(
    agentCommand({ platform: 'darwin', client: 'codex', folder: '/w', prompt, port: 5000 }),
    `codex -c mcp_servers.inwise.url=http://127.0.0.1:5000/mcp '${prompt}'`,
  );
  assert.throws(() => agentCommand({ platform: 'win32', client: 'codex', folder: 'C:\\w', prompt: 'x & del', port: 1 }));

  // Windows script: cd into the folder, check the CLI, start it.
  const win = buildLaunchScript({ platform: 'win32', client: 'codex', folder: 'C:\\Users\\Me\\My Repo', prompt, port: 43117 });
  assert.ok(win.startsWith('@echo off\r\n'));
  assert.ok(win.includes('cd /d "C:\\Users\\Me\\My Repo"'));
  assert.ok(win.includes('where codex >nul 2>nul ||'));
  assert.ok(win.trimEnd().endsWith(`codex -c mcp_servers.inwise.url=http://127.0.0.1:43117/mcp "${prompt}"`));
  assert.throws(() => buildLaunchScript({ platform: 'win32', client: 'codex', folder: 'C:\\a"b', prompt, port: 1 }));

  // macOS script: single quotes in the folder are escaped.
  const mac = buildLaunchScript({ platform: 'darwin', client: 'claude-code', folder: "/Users/me/Bob's", prompt, port: 1, mcpConfigPath: '/tmp/c.json' });
  assert.ok(mac.startsWith('#!/bin/sh\n'));
  assert.ok(mac.includes(`cd '/Users/me/Bob'\\''s' || exit 1`));

  // Terminals.
  assert.deepEqual(terminalCommand('win32', 'C:\\s.cmd', true), { file: 'wt.exe', args: ['new-tab', '--title', 'Inwise', 'cmd.exe', '/k', 'C:\\s.cmd'] });
  assert.equal(terminalCommand('win32', 'C:\\s.cmd', false).file, 'cmd.exe');
  assert.deepEqual(terminalCommand('darwin', '/s.command', false), { file: 'open', args: ['-a', 'Terminal', '/s.command'] });

  // Chat text: task, meeting, quote; long text clipped.
  const text = buildChatContext(
    { _id: 'T1', title: 'Send pricing deck to Acme', description: 'Include the Team tier', owner: 'Priya', priority: 'high', taskMentions: [{ excerpt: 'Can you send the deck by Friday?' }] },
    { title: 'Acme weekly', date: '2026-11-02T17:00:00.000Z', summary: 'S'.repeat(2000) },
  );
  assert.ok(text.includes('Task: Send pricing deck to Acme'));
  assert.ok(text.includes('Owner: Priya'));
  assert.ok(text.includes('From the meeting: Acme weekly'));
  assert.ok(text.includes('What was said: "Can you send the deck by Friday?"'));
  assert.ok(text.length < 2000, 'summary is clipped');
  assert.ok(!buildChatContext({ _id: 'T2', title: 'x' }, null).includes('From the meeting'));

  // Readiness messages.
  const ok: HandoffReadiness = { serverEnabled: true, serverRunning: true, writeback: true, folder: 'C:\\w', installed: { 'claude-code': true, codex: false }, introSeen: true };
  assert.deepEqual(agentBlockers(ok, 'claude-code'), []);
  assert.deepEqual(agentBlockers(ok, 'codex'), ['Codex is not installed on this computer.']);
  assert.equal(agentBlockers({ ...ok, folder: null, serverEnabled: false }, 'claude-code').length, 2);

  console.log('task-handoff: all tests passed');
}

if (require.main === module) {
  run().catch(e => { console.error(e); process.exit(1); });
}

export { run };
