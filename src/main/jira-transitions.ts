/**
 * Map a wanted status to one of the issue's available Jira transitions.
 * Pure: the caller fetches GET /rest/api/3/issue/{key}/transitions.
 *
 * Order: an exact transition or destination-status name, then the destination
 * status category (new / indeterminate / done), then common names. Nothing
 * matched -> null, and the caller says "PILOT-42 has no transition to Done".
 */

export type StatusCategory = 'new' | 'indeterminate' | 'done';

export interface JiraTransitionLike {
  id: string;
  name: string;
  to?: { name?: string; statusCategory?: { key?: string } };
}

const CATEGORY_BY_TARGET: Record<string, StatusCategory> = {
  done: 'done', completed: 'done', complete: 'done', closed: 'done', resolved: 'done',
  inprogress: 'indeterminate', in_progress: 'indeterminate', 'in-progress': 'indeterminate', doing: 'indeterminate', started: 'indeterminate',
  todo: 'new', to_do: 'new', open: 'new', backlog: 'new', reopen: 'new', reopened: 'new',
};

const NAMES_BY_CATEGORY: Record<StatusCategory, string[]> = {
  done: ['done', 'complete', 'closed', 'resolved'],
  indeterminate: ['in progress', 'start progress', 'in development', 'in review'],
  new: ['to do', 'open', 'backlog', 'reopen'],
};

const LABEL_BY_CATEGORY: Record<StatusCategory, string> = { done: 'Done', indeterminate: 'In Progress', new: 'To Do' };

const squash = (s: string) => s.toLowerCase().replace(/[\s-]+/g, '').replace(/_/g, '');

export function targetCategory(target: string): StatusCategory | null {
  if (!target) return null;
  const key = target.trim().toLowerCase();
  return CATEGORY_BY_TARGET[key] ?? CATEGORY_BY_TARGET[squash(target)] ?? CATEGORY_BY_TARGET[key.replace(/\s+/g, '_')] ?? null;
}

/** Human label for a wanted status: local 'completed' -> 'Done'; Jira names pass through. */
export function statusLabel(target: string): string {
  const cat = targetCategory(target);
  return cat ? LABEL_BY_CATEGORY[cat] : target;
}

export function pickTransition(transitions: JiraTransitionLike[], target: string): JiraTransitionLike | null {
  const list = Array.isArray(transitions) ? transitions.filter((t) => t && t.id) : [];
  if (list.length === 0 || !target) return null;
  const want = squash(target);
  const exact = list.find((t) => squash(t.to?.name || '') === want || squash(t.name || '') === want);
  if (exact) return exact;
  const cat = targetCategory(target);
  if (!cat) return null;
  const byCategory = list.filter((t) => t.to?.statusCategory?.key === cat);
  if (byCategory.length === 1) return byCategory[0];
  if (byCategory.length > 1) {
    const named = byCategory.find((t) => NAMES_BY_CATEGORY[cat].some((n) => (t.to?.name || t.name || '').toLowerCase().includes(n)));
    return named || byCategory[0];
  }
  // Older payloads without `to.statusCategory`: fall back to names.
  return list.find((t) => NAMES_BY_CATEGORY[cat].some((n) => `${t.to?.name || ''} ${t.name || ''}`.toLowerCase().includes(n))) || null;
}

export function noTransitionMessage(issueKey: string, target: string): string {
  return `${issueKey} has no transition to ${statusLabel(target)}`;
}

/** Jira status category key -> local task status (the tray uses todo / inProgress / completed). */
export function localStatusForCategory(category: string | null | undefined): 'todo' | 'inProgress' | 'completed' | null {
  if (category === 'done') return 'completed';
  if (category === 'indeterminate') return 'inProgress';
  if (category === 'new') return 'todo';
  return null;
}
