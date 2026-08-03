# Execute an Inwise action item through an AI client

Inwise can now keep the result of AI-assisted work attached to the action item that
started it. The connected MCP host — Claude, Codex, OpenWorker, or another client —
still owns external tool calling. Inwise validates the local action item and stores the
approved plan, outcome, artifact links, audit trail, and final task status.

Action writeback is off by default.

## Enable it

1. Open **Inwise → Settings → Connect to AI**.
2. Turn on **Enable local AI access**.
3. Turn on **Allow approved action writeback**.
4. Connect your MCP client to `http://127.0.0.1:43117/mcp`.
5. Run `get_connection_status`. `actionWriteback.enabled` should be `true`, and the
   server should report thirteen capabilities.

The setting is separate from read access so existing installations stay read-only until
the user deliberately opts in.

## Test the complete flow

Give your client a prompt like this:

> Find my open action item about the launch follow-up. Show me Inwise's starter
> recommendation and propose an exact plan, tools, recipients, and data to share. Do
> not act yet. After I approve, execute only that scope, save the verified outcome and
> artifact links back to Inwise, and mark the item complete only if the result proves it.

The expected tool sequence is:

1. `list_action_items` or `get_action_item`
2. A normal chat turn where the client shows the plan and asks for explicit approval
3. `start_action_execution`
4. External tools owned by the client, such as Docs, Gmail, Calendar, or Jira
5. `append_action_outcome`
6. `update_action_status`, when the outcome justifies a status change
7. `get_action_item` to verify the saved history

Open the action item in Inwise after step 5. Its task-detail view should show an
**AI execution** card with the approved objective, latest outcome, status, remaining
work, and clickable artifacts.

## Approval contract

`start_action_execution` requires a recent approval record containing:

- the approving user's identity;
- the approval timestamp (no more than 24 hours old);
- the exact scope they approved;
- every proposed external tool name;
- a stable idempotency key for safe retries.

Inwise rejects an unapproved tool, an expired approval, a snoozed/missing action item,
or a conflicting reuse of an idempotency key. The later write tools must use the same
client name as the execution that was approved. `update_action_status` also accepts the
action item's prior `updatedAt` value so a client does not overwrite a newer user edit.

This is a local trust boundary, not account authentication: any process belonging to a
user who can reach the loopback port can call it. Keep the MCP server off on shared
machines when it is not in use.

## What Inwise does not do

Inwise does not send the email, edit the document, create the calendar event, or choose
which external connector to call. The AI client is the MCP host and orchestrator. This
separation lets the same Inwise memory work with different clients while keeping the
approval and result record in one local place.

