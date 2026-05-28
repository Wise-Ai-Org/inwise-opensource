import type { WelcomeBackAdapter, WelcomeBackPayload, WelcomeBackAction } from '@inwise/desktop-shared';

const api = (window as any).inwiseAPI;

function resultToPayload(result: any): WelcomeBackPayload {
  const gapDays: number = result?.gapDays ?? 1;
  const wins = result?.wins ?? {};
  const actions: WelcomeBackAction[] = [];

  if (wins.cleared?.count > 0) {
    actions.push({
      id: 'cleared',
      type: 'task',
      label: `${wins.cleared.count} task${wins.cleared.count !== 1 ? 's' : ''} cleared`,
      description: wins.cleared.sampleTitles?.slice(0, 2).join(', '),
    });
  }
  if (wins.jiraProgress?.doneCount > 0) {
    actions.push({
      id: 'jira',
      type: 'task',
      label: `${wins.jiraProgress.doneCount} Jira issue${wins.jiraProgress.doneCount !== 1 ? 's' : ''} completed`,
    });
  }
  if (wins.meetingsMatched?.count > 0) {
    actions.push({
      id: 'meetings',
      type: 'meeting',
      label: `${wins.meetingsMatched.count} meeting${wins.meetingsMatched.count !== 1 ? 's' : ''} logged`,
    });
  }
  if (wins.calendarHealthy?.upcomingCount > 0) {
    actions.push({
      id: 'calendar',
      type: 'other',
      label: `${wins.calendarHealthy.upcomingCount} upcoming event${wins.calendarHealthy.upcomingCount !== 1 ? 's' : ''} synced`,
    });
  }

  const dayBrief =
    gapDays >= 2
      ? `Welcome back — you've been away ${gapDays} day${gapDays !== 1 ? 's' : ''}.`
      : 'Welcome back!';

  return { date: new Date().toISOString(), dayBrief, actions };
}

export const ossWelcomeBackAdapter: WelcomeBackAdapter = {
  async compute(): Promise<WelcomeBackPayload> {
    const result = await api.welcomeBackCompute?.() ?? null;
    if (!result) {
      return { date: new Date().toISOString(), dayBrief: 'Welcome back!', actions: [] };
    }
    return resultToPayload(result);
  },

  async dismiss(): Promise<void> {
    await api.welcomeBackDismiss?.();
  },

  liveMeeting$(handler) {
    api.welcomeBackLiveMeeting?.()
      .then((m: any) => {
        if (m) {
          handler({ id: m.id, title: m.title, startsAt: new Date(m.startTime).toISOString() });
        } else {
          handler(undefined);
        }
      })
      .catch(() => handler(undefined));
    return () => {};
  },
};
