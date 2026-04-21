# inwise-opensource — Multi-Calendar & Multi-Account Support

## Context

Today the OSS app supports exactly **one** Google calendar URL and **one** Outlook calendar URL (two fixed string fields in `src/main/config.ts:7-8`). Users with multiple accounts (work + personal) or multiple calendars within one account (work + shared team + family) can't subscribe to all of them. Since the app uses ICS (not OAuth), "multiple accounts" and "multiple calendars in one account" are the same problem: let the user add N labeled ICS URLs.

A secondary issue surfaces once multiple calendars are supported: attendee self-filtering for speaker labels and voice enrollment currently relies on `config.userName` substring-matching (`src/main/main.ts:162, 210-218`; `src/main/database.ts:395, 554, 565`). If the user has multiple calendars with different email aliases (e.g. `shrav@work.com` vs `shravani.vatti@gmail.com`), the current filter misses one — the user ends up listed as an attendee of their own meetings and voice enrollment gets confused. Fix: a list of self-emails.

## Goals

- Let the user configure any number of calendars from any provider (Google, Outlook, any ICS-exposing service).
- Each calendar has a user-editable label, provider hint, URL, and enabled toggle.
- Existing single-URL config migrates cleanly on first upgrade — no user action required.
- `calendar-watcher` polls all enabled calendars and merges events, de-duplicating across calendars.
- Users can list multiple of their own email addresses for accurate self-filtering across accounts.

## Non-goals

- OAuth-based calendar enumeration (stays ICS; future work if needed).
- Parallel recording of simultaneous meetings (separate concern — still one overlay at a time).
- Per-calendar event filters or colors.

---

## User Stories

### US-001 — Config schema: calendars array + selfEmails, with migration

**As a developer**, I need the config to hold an arbitrary list of calendar subscriptions and a list of self-email aliases, migrating from the existing single-URL fields without data loss.

**Acceptance criteria:**
- In `src/main/config.ts`, extend the `Config` interface with:
  - `calendars: Array<{ id: string; label: string; provider: 'google' | 'outlook' | 'ics'; url: string; enabled: boolean }>`
  - `selfEmails: string[]`
- Defaults: `calendars: []`, `selfEmails: []`.
- Add a migration helper (call it on app start in `src/main/main.ts`) that runs once:
  - If `config.calendars` is empty AND either `config.googleIcsUrl` or `config.outlookIcsUrl` is non-empty, insert a row for each non-empty URL (generate `id` via `crypto.randomUUID()`, `label` = `'Google'` / `'Outlook'`, `provider` set appropriately, `enabled: true`).
  - Keep the old fields in the schema (do NOT delete) — treat them as deprecated; only the migration reads them. This keeps downgrades safe.
  - Migration is idempotent: running it twice doesn't duplicate rows.
- Add helpers to `src/main/database.ts` or a new config-helpers module:
  - `addCalendar(row: Omit<Calendar, 'id'>): Calendar` — assigns UUID, appends, persists.
  - `updateCalendar(id: string, patch: Partial<Calendar>): void`
  - `removeCalendar(id: string): void`
  - `listCalendars(): Calendar[]`
- Typecheck passes
- Tests pass

---

### US-002 — calendar-watcher polls all enabled calendars and merges events

**As a user**, when I have multiple calendars enabled, I want events from all of them to appear in my upcoming meeting list, de-duplicated.

**Why broken today:**
`src/main/calendar-watcher.ts:75` reads `config.googleIcsUrl` directly. Single URL, single feed.

**Acceptance criteria:**
- In `src/main/calendar-watcher.ts`, replace the direct `config.googleIcsUrl` / `config.outlookIcsUrl` reads with an iteration over `getConfig().calendars.filter(c => c.enabled)`.
- For each calendar, fetch and parse its ICS feed in parallel (`Promise.allSettled`) — one failed calendar must not block the others.
- Merge all events into a single list. De-duplicate by a composite key of `(event.id, event.startTime.toISOString())`. Ties: prefer the entry with more attendees; if tied, first-fetched wins.
- Tag each merged event with a new field `sourceCalendarId: string` (the id of the calendar it came from) for future UI use.
- Existing public API of `calendar-watcher` (getUpcomingEvents, on('meeting-starting'), on('meeting-reminder')) keeps the same shape; only the internal polling path changes.
- Log line format: `calendar-watcher:fetch | calendarId=X label="Y" got=N events` per calendar per poll, plus `calendar-watcher:poll | Done — total=M unique events across K calendars`.
- If `calendars` is empty, skip polling with a debug log; don't error.
- Typecheck passes
- Tests pass

---

### US-003 — Use selfEmails for attendee self-filtering

**As a user with multiple email addresses**, I want the app to recognize all my aliases so I'm not listed as an attendee of my own meetings and voice enrollment filters me out correctly regardless of which calendar the event came from.

**Why broken today:**
- `src/main/main.ts:162` and `:210-218` filter attendees by `userName.toLowerCase()` substring — misses aliases that don't share characters with userName.
- `src/main/database.ts:395, 554, 565` does the same.

**Acceptance criteria:**
- Add a helper `isSelf(attendee: string): boolean` in a shared module (e.g. `src/main/self-identity.ts`) that:
  - Reads `getConfig().selfEmails` and `getConfig().userName`.
  - Normalizes attendee to lowercase.
  - Returns true if attendee contains any entry from `selfEmails` (email match), OR if `userName` is non-empty AND attendee includes `userName.toLowerCase()` (display-name fallback).
  - Handles attendee strings that are email, display name, or `"Name <email>"` formats.
- Replace the inline attendee filtering at the four cited call sites with `isSelf(a)`.
- When `selfEmails` is empty and `userName` is empty, `isSelf` returns false (no filtering) — preserves current behavior for fresh installs.
- Typecheck passes
- Tests pass: add a unit test for `isSelf` covering email match, display-name fallback, mixed-case, and empty-config cases.

---

### US-004 — Settings UI: calendar list with add / edit / remove / test / toggle

**As a user**, I want a Settings page section where I can add, rename, disable, test, and remove calendar subscriptions.

**Why broken today:**
`src/renderer/Settings.tsx` has two fixed `IcsField` components (Google + Outlook), one URL each.

**Acceptance criteria:**
- Replace the two fixed IcsFields with a `CalendarList` component.
- Each row renders: label input, provider dropdown (Google / Outlook / Other), URL input, enabled toggle, `Test` button, `Delete` button.
- `Test` button hits the existing IPC `testCalendarUrl(url)` and shows the result inline (same style as current IcsField).
- `+ Add calendar` button at the bottom appends an empty row (auto-focused label field).
- Changes persist on blur (or debounced on-change) via new IPC methods: `inwiseAPI.addCalendar`, `updateCalendar`, `removeCalendar`.
- Migration from US-001 is visible: on upgrade, the user sees their existing Google/Outlook URLs as rows labeled `Google` and `Outlook`.
- Empty state: if no calendars configured, show "Add your first calendar to get started — paste a secret ICS link from Google/Outlook calendar settings."
- CalendarStatus component at the top continues to work; it now aggregates health across all enabled calendars (total event count + any-failing flag).
- Typecheck passes
- Verify in browser using dev-browser skill: open Settings, add a calendar, test an invalid URL, confirm error inline; test a valid URL, confirm event count; toggle enabled off, confirm events from that calendar disappear from upcoming list after next poll.

---

### US-005 — Settings UI: selfEmails editor

**As a user**, I want to list all the email addresses I use (work, personal, alias) so the app knows not to treat me as an attendee of my own meetings.

**Acceptance criteria:**
- Add a "Your email addresses" section in Settings, near the existing `userName` field.
- Field is a chip-input (or a comma-separated text field with visible chips rendered below) — user types an email, presses Enter or comma, a chip is added.
- Each chip has a small `×` to remove it.
- Validate on add: must match a basic email regex; invalid entries show a short inline error and are not added.
- Persists via IPC `inwiseAPI.setSelfEmails(list)`; reads initial via `inwiseAPI.getConfig()` (existing).
- Helper text below: "Separate from userName. Used to identify you in multi-calendar attendee lists so you're not labeled as an attendee of your own meetings."
- Typecheck passes
- Verify in browser using dev-browser skill: add an email, reload the Settings page, confirm chip persists; add an invalid entry, confirm rejection; remove a chip, confirm removal persists.

---

### US-006 — Handle simultaneous meeting starts

**As a user with two meetings starting at the same moment**, I want the app to tell me about the conflict and let me pick which one to record, instead of silently dropping one.

**Why broken today:**
`src/main/main.ts` keeps a single `overlayWindow` global and a single `currentMeeting` slot. The `meeting-starting` handler creates the overlay only if `!overlayWindow`. If two events fire within a narrow window, the second is silently dropped.

**Acceptance criteria:**
- Detect conflict at `meeting-starting` handler: if a recording is already active (or another meeting-starting fired within the last 90 seconds), treat as a conflict.
- On conflict, show a modal in the main window (or a desktop Notification with buttons if the main window isn't visible) listing both meetings with title + start time + attendee count, letting the user pick which to record.
- If the user doesn't respond within 30 seconds, auto-select using: prefer the meeting where more attendees match `selfEmails`/`userName`; tiebreaker = earlier startTime; final tiebreaker = first-fired wins.
- Log the decision: `calendar-watcher:conflict | recording="X" passed-over="Y" reason=auto-selected|user-selected`.
- The meeting that wasn't recorded still appears in the upcoming list (no silent drop from calendar).
- If only one meeting starts (no conflict), current single-overlay behavior is preserved — no modal, no delay.
- Typecheck passes
- Verify in browser using dev-browser skill: inject two synthetic events with the same start time via the calendar-watcher test hook; confirm modal appears, pick one, confirm only that one gets recorded and the log shows the decision.

---

## Rollout

- One branch: `ralph/multi-calendar-accounts`.
- Migration runs exactly once on first app start post-upgrade; idempotent on repeated runs.
- No breaking schema changes — old `googleIcsUrl`/`outlookIcsUrl` fields kept in Config interface but unused post-migration.

## Success signal

After the fix:
- A user with two Google calendars and one Outlook calendar sees events from all three in the upcoming meeting list, with no duplicates for cross-invited events.
- Disabling a calendar in Settings → events from that calendar disappear after the next poll.
- Adding a second email to selfEmails → the user's own email stops appearing in attendee lists for meetings from that account.
- Upgrading from a version with just `googleIcsUrl` set → after first launch, Settings shows one migrated "Google" calendar row with the same URL, marked enabled.
