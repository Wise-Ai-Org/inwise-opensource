interface RecapItem {
  text: string;
  owner?: string;
  assignee?: string;
}

interface RecapMeeting {
  title?: string;
  date?: string;
  insights?: {
    summary?: string;
    decisions?: RecapItem[];
    actionItems?: RecapItem[];
    blockers?: RecapItem[];
  };
}

function section(label: string, items: RecapItem[] | undefined, format: (item: RecapItem) => string): string[] {
  if (!items?.length) return [];
  return [`*${label}*`, ...items.map((item) => `• ${format(item)}`)];
}

/** Build the explicit, transcript-free recap sent from a meeting detail page. */
export function buildMeetingSlackRecap(meeting: RecapMeeting): string {
  const insights = meeting.insights ?? {};
  const lines: string[] = [`*${meeting.title || 'Meeting recap'}*`];

  if (meeting.date) {
    const date = new Date(meeting.date);
    if (!Number.isNaN(date.getTime())) lines.push(date.toLocaleString());
  }
  if (insights.summary?.trim()) lines.push('', insights.summary.trim());

  lines.push(
    ...section('Decisions', insights.decisions, (item) => item.text),
    ...section('Action items', insights.actionItems, (item) => {
      const owner = item.owner || item.assignee;
      return owner ? `${item.text} — ${owner}` : item.text;
    }),
    ...section('Blockers', insights.blockers, (item) => item.text),
  );

  lines.push('', '_Shared explicitly from Inwise_');
  return lines.join('\n').slice(0, 35_000);
}
