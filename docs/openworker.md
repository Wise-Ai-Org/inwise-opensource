# Use Inwise with OpenWorker

Inwise 1.4.0 and later includes a local MCP server. OpenWorker can use it to search your
meeting history, prepare agendas, and review action items while Inwise keeps its database
on your computer. Newer development builds also offer default-off, approval-aware action
writeback.

## Before you connect

- Install and open Inwise 1.4.0 or later.
- Install OpenWorker.
- In Inwise, open **Settings → Connect to AI**, keep the default port `43117`, and turn
  the local MCP server on.

Inwise must remain open while OpenWorker uses the connector or runs an automation.

## Connect from the catalog

When the Inwise card is available in your OpenWorker build:

1. Open **Connectors** in OpenWorker.
2. Select **Inwise** and click **Connect**.
3. Ask OpenWorker to check the Inwise connection. A successful response includes the
   Inwise version, ten read tools, and — on a writeback-capable build — three action
   execution tools whose writes remain blocked until separately enabled in Inwise.

There is no Inwise account or sign-in step. OpenWorker connects directly to
`http://127.0.0.1:43117/mcp` on the same computer.

## Connect manually

Until the catalog card is included in an OpenWorker release, quit OpenWorker and create or
edit its global MCP configuration:

- Windows: `%APPDATA%\coworker\mcp.json`
- macOS and Linux: `~/.config/coworker/mcp.json`

Add this server entry, preserving any other entries already in `mcpServers`:

```json
{
  "mcpServers": {
    "inwise": {
      "url": "http://127.0.0.1:43117/mcp",
      "enabled": true,
      "requires_approval": true,
      "include_tools": [
        "search_meetings",
        "get_meeting",
        "get_transcript",
        "list_action_items",
        "get_action_item",
        "list_people",
        "get_person",
        "list_upcoming_meetings",
        "prepare_meeting",
        "get_connection_status",
        "start_action_execution",
        "append_action_outcome",
        "update_action_status"
      ]
    }
  }
}
```

Restart OpenWorker, open its MCP management screen, and connect `inwise`. Then ask it to
run `get_connection_status`.

## Try it

Useful first requests include:

- "Find my meetings about the launch plan and summarize the latest decisions."
- "What action items are still open from my last meeting with Sam?"
- "Prepare my next 1:1 with Priya. Include what we owe each other and link each point to
  the source meeting."
- "List tomorrow's meetings and flag any overdue work related to the attendees."
- "For this action item, show me a plan and the exact tools you would use. Wait for my
  approval, then save the verified outcome back to Inwise."

The OpenWorker catalog integration also includes a **Meeting prep** automation template.
It runs at 8:00 AM on weekdays, lists the next 24 hours of meetings, prepares an agenda per
attendee, and flags overdue action items. OpenWorker uses a schedule rather than a
per-meeting calendar trigger, so both apps need to be running when the morning job starts.

## Understand the data boundary

- Inwise's MCP server binds only to loopback (`127.0.0.1`) and does not require an online
  Inwise account.
- The original ten tools are read-only. The three action-execution write tools remain
  blocked unless **Allow approved action writeback** is enabled in Inwise. They can store
  an approved execution, its outcomes/artifacts, and a local action-item status change;
  they cannot delete Inwise data or call an external service themselves.
- `get_meeting` returns only a short transcript excerpt. OpenWorker must call
  `get_transcript` separately to retrieve full transcript pages.
- Content returned to OpenWorker can be sent to the AI provider configured in OpenWorker.
  Request a full transcript only when that is appropriate for the meeting's participants
  and your organization's policies.
- On a shared machine, other operating-system accounts may be able to reach loopback
  services. Turn off **Connect to AI** when you are not using it on such a machine.

## Troubleshooting

**Connection refused**

Open Inwise and confirm **Settings → Connect to AI** is on and still uses port `43117`.

**OpenWorker says a tool is missing**

Run `get_connection_status` and verify the reported Inwise version is 1.4.0 or later. Then
restart both applications so OpenWorker refreshes the tool list.

**The morning brief did not run**

Confirm OpenWorker's automation is enabled and both OpenWorker and Inwise were running at
8:00 AM local time.

**A meeting or person is absent**

Open Inwise and confirm the meeting was recorded or imported and that calendar sync is
current. The MCP tools read the same local data shown in the desktop app.
