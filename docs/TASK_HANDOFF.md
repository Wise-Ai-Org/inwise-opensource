# Hand a task to AI

Every open task has a "Hand this to AI" card with two buttons, Claude Code and Codex, and a line underneath to talk it through in a Claude or ChatGPT chat instead.

## What the user sees

- **Tasks tab:** a one-time tip, "New: hand a task to Claude Code or Codex", with a link that opens a task to try it. It goes away after "Got it" or after the first hand-off is set up.
- **First hand-off:** a sheet explains the three steps (a terminal opens in your folder, the agent reads the task and its meeting and shows a plan, the result is saved to the task). The user picks the folder, sees whether the agent is installed (with a "How to install" link if not), and chooses whether the agent may save its plan and results. Starting turns on Connect to AI if it was off.
- **After that:** one click opens a terminal titled "Inwise: Claude Code" (or Codex) in the chosen folder with a new session already running. The task card says "Handed to Claude Code at 3:12 PM" until the agent records its plan; then the existing AI execution card takes over. The task list shows "Sent to Claude Code", then "With Claude Code" while the agent works.
- **Chats:** the first time, a sheet explains that Inwise copies the task and a short quote from its meeting, opens a new chat, and that pasting sends it to Anthropic or OpenAI. After that it copies and opens directly, with a reminder to paste.

## What it deliberately does not do

- Run agents inside Inwise, or start one without a click.
- Put meeting text in a URL or in the shell command. The agent prompt contains only the task id and fixed instructions; the agent reads the rest over MCP.
- Change the user's Claude Code or Codex settings. The Inwise MCP server is attached for that session only.
- Let chats write back. Cloud chats cannot reach the local MCP server.

## Under the hood

`src/main/task-handoff.ts` builds the prompt, a small launch script in `userData/handoff/`, and the terminal command (Windows Terminal, falling back to cmd; Terminal on macOS). Claude Code gets `--mcp-config <file>`; Codex gets `-c mcp_servers.inwise.url=<url>`. Task ids are checked against `[A-Za-z0-9_-]` and the prompt against shell metacharacters before anything is written. Write-back uses the existing `start_action_execution`, `append_action_outcome` and `update_action_status` tools, which still require `mcpWritebackEnabled` and an approval record.

Verified on Windows, 2026-11-03, against a test copy of user data: both agents read the task and its meeting and stopped at a plan; with approval, Claude Code saved a local draft, recorded the execution and outcome, and moved the task to In Progress, which showed on the task page and in the list. Not yet run on macOS.
