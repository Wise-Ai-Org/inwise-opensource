# Jira safety: how Inwise writes to and reads from Jira

Inwise proposes Jira changes from meetings and keeps a small local copy of the Jira tickets that matter to you. This page describes the rules that keep those writes safe.

## One path for every write

Every Jira write goes through `submitJiraWrite` in `src/main/jira-writes.ts`: meeting proposals, ticket intents, task edits on a linked task, the renderer's `jira:*` calls, approvals from the queue, retries and "Create new" on a suggestion. `jira-client.ts` only performs the HTTP call (`executeJiraPush`) after this path has decided.

Each write is recorded in the SoR write log (`sor-writes.db`) with:
- provenance: source meeting, linked local task, transcript quote, intent (done, due moved, decision, new),
- a numeric confidence (never empty),
- who started it (`initiator`: `user` for a click, `system` for meeting and sync work),
- the gate's reason and, for suggestions, the question shown ("Update PILOT-42 instead?"),
- an idempotency key.

## The setting

Settings > Jira > Jira changes:
- **Ask me every time** (default). Every system write waits in the approval queue (Review page, the meeting recap, the prep card).
- **Apply on their own when Inwise is very sure.** Writes with confidence of at least 0.9 apply straight away; the rest wait.

Clicks count as approval of that click: moving a linked task to Done, Approve on a held row, Retry, Create new. They still get provenance and a log entry.

The gate (`decideJiraWrite` in `jira-gate.ts`), in order:
1. A click: push.
2. The local task was skipped: drop.
3. The local task is waiting on a "same task?" dedup answer: wait (nothing is recorded; the item is re-planned when the answer comes in).
4. A suggestion ("Update PILOT-42 instead?"): hold, in both modes.
5. Ask mode: hold.
6. Auto mode: push at confidence 0.9 or more, or when you already kept the task; otherwise hold.

Keep and Skip on a task found in a meeting: Skip also skips its held Jira writes. Under the auto setting, Keep releases held writes that were only waiting on confidence (not suggestions). Under Ask, Keep never pushes; the Jira row has its own Approve. Approving a Jira row also keeps its task.

### Migration

`sor.jira.writeMode` is new. Older installs only had `approvalGateEnabled` (default false) and `approvalThreshold` (default 0.6). electron-store persists defaults, so an untouched install cannot be told apart from someone who chose exactly those values. `resolveJiraWriteMode` treats anything different from the shipped defaults as an explicit choice: gate turned on, or threshold moved, becomes **Apply on their own** (they had asked for confident writes to go through and weak ones to wait). Everyone else becomes **Ask me every time**. The resolved value is not written back until the user picks one, so the rule stays inspectable.

## Confidence

`computeWriteConfidence` in `jira-confidence.ts` is deterministic. The only model input is the extractor's own certainty for the item (`certainty`, 0 to 1, default 0.5 when the model leaves it out; the older `confidence` field is read as a fallback).

- Create: `0.50 * certainty + 0.15 * owner named + 0.10 * due date said + 0.25 * (1 - best match to an existing ticket)`.
- Update, transition, comment: `0.45 * certainty + 0.35 * target + 0.10 * owner named + 0.10 * due date said`, where target is 1 when the key was said or the local task is already linked, otherwise the match strength.

A create that looks like an existing ticket stays below 0.9 even when everything else is certain.

## Idempotency

- Meeting items carry a stable key, `meeting:<meetingId>:<normalized item text>`. Ticket intents use `meeting:<meetingId>:intent:<kind>:<KEY>`. Renderer creates use `task:<taskId>:create`.
- Before any write: if an entry with the same key exists (pending, held, done, failed or skipped), the write is a duplicate and nothing is sent. Before any create: if the linked task already has a Jira key, or any create was ever logged for that task, nothing is created. Failed creates are retried with Retry, never created again.
- Writes run one at a time, and meeting passes are serialized per meeting, so two passes cannot both pass the check.
- `saveInsights` keeps one task per (meeting, item) across reprocessing (segment merges, Retry). It finds earlier tasks by `meetingId` and the stored item key, not by `source.id`, so a task whose source became Jira is still found. Earlier pending tasks whose item is gone are removed and their held Jira writes are skipped. Each action item stores the id of the task it landed in.
- `updateTask` refuses a missing id instead of silently doing nothing.

## Match before create

For each item, using the task local dedup produced:
1. The task is already linked to a key (dedup merged it into a Jira task): comment on that key.
2. A key was said: comment on that key.
3. Keyword match of 0.85 or more: comment on that ticket.
4. 0.3 to 0.85: ask the LLM (`semanticMatch`) once for the whole meeting. A confirmed or unanswered match becomes the suggestion "Update PILOT-42 instead?", with Approve, Create new and Skip. An explicit "no match" becomes a create.
5. Otherwise: create in the default project.

Ticket intents from the extraction (done, due moved, decision) target the key that was said, or a ticket the hint matches at 0.3 or more; with no confident target there is no row. Done on a ticket that is already done is skipped.

## More suggestion types

Ticket intents can also become:
- **Started** ("I've started PILOT-40, move it to In Progress" -> "Move PILOT-40 to In Progress?"). Skipped when the ticket is already in progress or done.
- **Assign** ("Jordan will take PILOT-40" -> "Assign PILOT-40 to Jordan Lee?"). "Me", "myself" or your own Jira name means the connected account, with no lookup. Anyone else is resolved like the pull does (stored id, then email). If they cannot be resolved the row says so and offers **Find in Jira** instead of Approve; Inwise never guesses an account. Picking someone fills the row and stores the id on the person.
- **Blocking link** ("PILOT-33 is blocked on the SSO work" -> "Mark PILOT-33 as blocked by OPS-12?"), link type "Blocks". Only when both tickets are identified: a spoken key, a Jira-linked task or ticket whose title matches at 0.85 or more, or an LLM match. Otherwise no row. No row either when Jira already has that link. The link is sent with the blocker as `inwardIssue` (Jira reads "<inward> blocks <outward>").
- **Sprint** ("let's pull PILOT-41 into this sprint" -> "Add PILOT-41 to Sprint 14?") through the Agile API, using the active (or, for "next sprint", the next future) sprint of a board on the issue's project. With no board or open sprint the row stays with the reason ("OPS's board has no active or upcoming sprint") and only Skip.

Rows that cannot go through yet carry `blockedReason` (and `needs: 'jira-user'` for an unresolved assignee). They are held under both settings, Approve is refused, and a click cannot push them either. Their confidence uses the same non-create formula, so a fully certain assignment with a spoken key lands at 0.88 and still waits under the auto setting.

Finding people needs one extra OAuth scope, `read:jira-user`; the weekly personal data check-in needs `report:personal-data`. Both are requested at connect time and enabled on the Atlassian app. Existing connections must reconnect; until then the rows say "Reconnect Jira in Settings". Sprints need no extra scope: Inwise finds a project's active or next sprint through a normal ticket search (tickets already in that sprint carry it), and adds a ticket by editing its Sprint field. A brand new sprint with no tickets in it yet is not found, so the row says the project has no active or upcoming sprint.

## People and Jira accounts

`jira-people.ts` resolves a person to a Jira accountId in this order: an id stored on the person (picked with Find in Jira, or cached from an earlier email match), then an email lookup, then unresolved. Unresolved people are re-checked at most weekly. The People tab shows "Not linked to Jira yet" with Find in Jira for unresolved people (Jira hides their email); the person page shows the linked account with Unlink. An unlinked person is never re-matched by email silently. Stored ids are used for the pull scope and for "Their Jira", which matches linked people by accountId only.

## Moved since you last met

The prep card reads each candidate issue's changelog (`GET /issue/{key}/changelog`, jumping to the newest page on long histories), so any status change counts, including within a category (In Review to QA). Candidates are bounded to the 4 newest open, unblocked attendee issues updated since the last meeting, and results are cached per issue and its `updated` timestamp. When the changelog call fails, the status-category change time is used as before.

## Dates

Every Jira date shown (recap, prep, wrap, Review, notification copy) reads like "Wed, Nov 4" (`jira-format.ts formatJiraDate`).

## Transitions

`pickTransition` (`jira-transitions.ts`) reads the issue's own transitions (`GET /rest/api/3/issue/{key}/transitions`) and picks: an exact transition or destination-status name, then the destination status category (`new`, `indeterminate`, `done`), then common names. If nothing fits, the write fails with "PILOT-42 has no transition to Done", shown in the recap and on the Review page.

## Pull

`runJiraPull` in `jira-sync.ts`:
- Runs when Jira is connected (independent of the meeting setting): 10 seconds after launch, then every 30 minutes while the app is open.
- Window: since the last successful pull, at least 7 and at most 90 days (90 on the first pull).
- Follows `nextPageToken` up to 10 pages of 100.
- JQL: `(assignee = currentUser() OR reporter = currentUser() OR assignee in (<people you met in the last 30 days, max 15>) OR project = "<default project>") AND updated >= -<N>d ORDER BY updated DESC`. People are matched to Jira accounts by email (`/user/search`); people whose email Jira hides are skipped.
- Fields: summary, status, priority, updated, created, project, description, duedate, assignee, reporter, issuelinks, comment, statuscategorychangedate, issuetype, and the site's Sprint field (looked up through `/field`, falling back to `customfield_10020`).
- Every issue goes into `jira-issues.db` (key, status and category, when the category last changed, due date, assignee, reporter, open "is blocked by" links, active sprint, last five comments with author, time and whether they mention you, your newest comment time). The Ollie cards read this cache. Entries not seen for 120 days are pruned.
- Only issues assigned to you, or already linked to a local task, touch local tasks. A linked task is refreshed when Jira is newer. A new one is deduplicated against local tasks, but never against a task linked to a different key; "same task?" answers go to the dedup queue, nothing is dropped. Answering "same" on a pulled task moves its link to the local task only when that task has no other key.

## What this does not cover

There is no test against a real Jira site; the HTTP layer is exercised with mocked `fetch`. People whose email Jira hides need a one-time Find in Jira. The issue-link direction for "Blocks" (outward = blocker) follows Atlassian's documentation and has not been checked against a live site.

## Personal data

Inwise keeps some Jira people data on your device for longer than a day: the cached issues (assignee, reporter, comment authors), the Jira accounts linked on the People tab, and suggested assignments waiting for your OK. Atlassian requires apps that keep this data to check in with them weekly, so Inwise does.

- About a minute after launch, and once a day after that, Inwise checks whether a week has passed since the last check-in. If it has, it sends Atlassian the list of Jira account IDs it holds, with when each was last fetched. Nothing else is sent.
- If someone deleted their Atlassian account, Inwise erases them: their cached issues are dropped (the next pull fetches them again without that person), their People tab link is removed, and any suggestion to assign them work is closed with their name removed.
- If someone's profile changed, Inwise drops its cached copy, and the next pull or People tab lookup picks up the new details.
- If your own account was deleted, Inwise disconnects Jira.
- If Atlassian is busy or the check-in fails, Inwise does not count it and tries again the next day.

Code: `src/main/jira-personal-data.ts`, `reportPersonalDataAccounts` in `jira-client.ts`.

## Live run, 2026-11-03

A test meeting naming three labelled tickets (I90-363 to I90-365, label `inwise-live-test`) on inwise-team-wpxl1dr2 went through the real upload path. Every suggestion waited for approval. After approval Jira showed I90-364 In Progress, I90-365 assigned to the connected user, I90-364 "is blocked by I90-365", and one comment on I90-363; the "no active or upcoming sprint" row could not be approved. The run found and fixed: no "in progress" intent, "assign to me" asking for Find in Jira, action items repeating an intent as a comment, the blocked-by link sent backwards, and the 201-with-empty-body link response read as an error. A third run of the same meeting suggested nothing already applied.
