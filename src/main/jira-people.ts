/**
 * Person -> Jira accountId (docs/JIRA_SAFETY.md, "People and Jira accounts").
 *
 * Resolution order:
 *   1. an id stored on the person (picked with "Find in Jira", or cached from
 *      an earlier email match),
 *   2. an email lookup (/user/search), cached on the person when it works,
 *   3. unresolved: the People tab offers "Find in Jira" once.
 * A person the user unlinked stays unresolved (no silent email re-match).
 */

export type JiraLinkStatus = 'linked' | 'email' | 'unresolved' | 'unlinked';

export interface JiraLink {
  status: JiraLinkStatus;
  accountId: string | null;
  displayName: string | null;
  checkedAt: string;
}

export interface Resolution {
  accountId: string | null;
  source: 'stored' | 'email' | 'unresolved';
  /** New link to persist on the person, or null when nothing changed. */
  update: JiraLink | null;
}

/** Re-try an email lookup that found nobody at most this often. */
export const UNRESOLVED_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

export function storedAccountId(person: any): string | null {
  const link: JiraLink | undefined = person?.jiraLink;
  if (link && (link.status === 'linked' || link.status === 'email') && link.accountId) return link.accountId;
  return null;
}

export async function resolvePersonAccountId(
  person: any,
  lookupEmail: (email: string) => Promise<string | null>,
  now: Date = new Date(),
): Promise<Resolution> {
  const stored = storedAccountId(person);
  if (stored) return { accountId: stored, source: 'stored', update: null };
  const link: JiraLink | undefined = person?.jiraLink;
  if (link?.status === 'unlinked') return { accountId: null, source: 'unresolved', update: null };
  const checked = link?.status === 'unresolved' ? Date.parse(link.checkedAt) : NaN;
  if (Number.isFinite(checked) && now.getTime() - checked < UNRESOLVED_RECHECK_MS) {
    return { accountId: null, source: 'unresolved', update: null };
  }
  const emails = [person?.email, ...(Array.isArray(person?.altEmails) ? person.altEmails : [])]
    .filter((e: unknown): e is string => typeof e === 'string' && e.includes('@'));
  for (const email of emails) {
    let id: string | null = null;
    try { id = await lookupEmail(email.toLowerCase()); } catch { id = null; }
    if (id) {
      return { accountId: id, source: 'email', update: { status: 'email', accountId: id, displayName: person?.name || null, checkedAt: now.toISOString() } };
    }
  }
  return { accountId: null, source: 'unresolved', update: { status: 'unresolved', accountId: null, displayName: null, checkedAt: now.toISOString() } };
}

/** People tab note: shown for people Inwise tried and could not match. */
export function needsJiraLink(person: any): boolean {
  return person?.jiraLink?.status === 'unresolved' || person?.jiraLink?.status === 'unlinked';
}
