# Release Notes

## 1.3.0 — Task mention deduplication

The same task, said three different ways in three different meetings, used to become
three cards. Now Inwise recognizes it as one.

When a task is extracted from a meeting transcript or a voice note, Inwise compares it
against your open tasks — first by wording, then by asking your configured model whether
it is genuinely the same piece of work. Confident matches merge onto the existing card.
Uncertain ones do not guess: you get a one-tap "Same task / New task" confirm in the same
review pane where extracted tasks already appear. Everything else is created as a new
task, exactly as before. If the model call fails for any reason, task creation still
happens — dedup degrades, it never blocks.

- Repeat mentions merge onto one card instead of piling up duplicates. Tasks from voice
  notes go through the same matching as tasks from meetings; previously they had none at all.
- Every task shows a thread of each time it came up: the source, the date, and the quote.
  Tasks mentioned only once look exactly as they did before — no extra chrome.
- Anything that got merged can be split back out into its own task, and you can merge two
  cards by hand whenever the matcher misses one.
- When a task comes up three times in a week, its card offers to bump the priority. It is
  a tap. Priority never changes on its own, and a task you already finished is never
  silently reopened.
- Matching runs on your own API key through the provider you configured, and the confirm
  card names the model that made the call.
- Every match decision is written to a local `match-decisions.db` so you can see how the
  matcher behaves on your own data. It never leaves your machine.
- Recurring meetings now store their series ID, so occurrences of the same standing
  meeting are recognized as one series instead of unrelated events.
