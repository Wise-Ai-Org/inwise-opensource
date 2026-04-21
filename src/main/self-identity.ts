import { getConfig } from './config';

/**
 * Pure predicate used by {@link isSelf}, extracted so callers can unit-test
 * the matching rule without touching electron-store.
 *
 * Returns true when `attendee` (after lowercasing) contains any non-empty
 * entry from `selfEmails`, or — as a fallback — when `userName` is non-empty
 * and is a substring of `attendee`. This matches the attendee formats emitted
 * by ICS parsers: plain emails, plain display names, and the combined
 * `"Name <email>"` form.
 */
export function matchesSelf(
  attendee: string,
  selfEmails: readonly string[],
  userName: string,
): boolean {
  if (!attendee) return false;
  const lower = attendee.toLowerCase();

  for (const raw of selfEmails) {
    const email = (raw || '').trim().toLowerCase();
    if (email && lower.includes(email)) return true;
  }

  const name = (userName || '').trim().toLowerCase();
  if (name && lower.includes(name)) return true;

  return false;
}

/**
 * Returns true if `attendee` refers to the current user via any of their
 * configured self-emails (`Config.selfEmails`) or their display name
 * (`Config.userName`). When both are empty, returns false — preserving
 * fresh-install behavior where nothing is filtered.
 */
export function isSelf(attendee: string): boolean {
  const cfg = getConfig();
  return matchesSelf(attendee, cfg.selfEmails, cfg.userName);
}
