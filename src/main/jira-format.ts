/**
 * Import-free formatting shared by the main process (card payloads,
 * notification copy) and the renderer (Review page). Dates read like
 * "Wed, Nov 4" everywhere a Jira date is shown.
 */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM-DD' (a local calendar day) or an ISO timestamp -> "Wed, Nov 4". Unknown input passes through. */
export function formatJiraDate(value: string | null | undefined): string {
  if (!value) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** Replace every bare YYYY-MM-DD inside a sentence with the friendly form. */
export function friendlyDatesIn(text: string): string {
  return String(text || '').replace(/\b(\d{4}-\d{2}-\d{2})\b/g, (_, ymd) => formatJiraDate(ymd));
}

/** Local status names and Jira names -> a word for people. */
export function jiraStatusWord(s: string): string {
  const k = String(s || '').toLowerCase().replace(/[\s_-]+/g, '');
  if (['done', 'completed', 'complete', 'closed', 'resolved'].includes(k)) return 'Done';
  if (['inprogress', 'doing', 'started'].includes(k)) return 'In Progress';
  if (['todo', 'open', 'backlog'].includes(k)) return 'To Do';
  return s;
}

/**
 * The question a held Jira change asks, used by the recap, prep and Review
 * rows: "Move PILOT-42 to Done?", "Assign PILOT-40 to Jordan Lee?".
 */
export function describeJiraChange(
  pushParams: { operation?: string; args?: any } | null | undefined,
  extra: { intent?: string | null; suggestion?: string | null } = {},
): string {
  if (extra.suggestion) return extra.suggestion;
  const op = pushParams?.operation || 'create';
  const a = pushParams?.args || {};
  const key = a.issueKey || 'the ticket';
  switch (op) {
    case 'create': return `Create ticket “${a.title || 'issue'}”?`;
    case 'update': {
      const fields = Object.keys(a.updates || {}).filter((k) => a.updates[k] !== undefined);
      if (fields.length === 1 && fields[0] === 'dueDate') return `Move the due date on ${key} to ${formatJiraDate(a.updates.dueDate)}?`;
      return `Update ${key}${a.updates?.title ? `: ${a.updates.title}` : ''}?`;
    }
    case 'transition': return `Move ${key} to ${jiraStatusWord(a.targetStatus) || 'a new status'}?`;
    case 'assign': return `Assign ${key} to ${a.assigneeName || 'someone'}?`;
    case 'link': return `Mark ${a.blockedKey} as blocked by ${a.blockerKey}?`;
    case 'sprint': return a.sprintName ? `Add ${key} to ${a.sprintName}?` : `Add ${key} to a sprint?`;
    default:
      return extra.intent === 'decision' ? `Add the decision to ${key} as a comment?` : `Add a comment on ${key}?`;
  }
}
