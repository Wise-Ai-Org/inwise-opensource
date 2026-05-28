import type { CalendarAdapter, CalendarConnection, CalendarHealth } from '@inwise/desktop-shared';
import { NotSupportedError } from '@inwise/desktop-shared';

const api = (window as any).inwiseAPI;

interface OSSCalendarRow {
  id: string;
  label: string;
  provider: 'google' | 'outlook' | 'ics';
  url: string;
  enabled: boolean;
}

interface OSSCalendarHealth {
  status: 'unknown' | 'ok' | 'error' | 'no-url';
  lastPollAt: number | null;
  lastError: string | null;
  googleConfigured: boolean;
  outlookConfigured: boolean;
}

export const ossCalendarAdapter: CalendarAdapter = {
  async listConnections(): Promise<CalendarConnection[]> {
    const rows: OSSCalendarRow[] = await api.listCalendars();
    return rows
      .filter(r => r.provider === 'google' || r.provider === 'outlook')
      .map(r => ({
        id: r.id,
        provider: r.provider as 'google' | 'outlook',
        email: r.url || r.label,
        displayName: r.label || undefined,
        addedAt: new Date(0).toISOString(),
        status: r.enabled ? 'ok' : ('sync-stalled' as const),
      }));
  },

  async connectGoogle(): Promise<CalendarConnection> {
    throw new NotSupportedError('Google OAuth is not available — use an ICS link instead.');
  },

  async connectOutlook(): Promise<CalendarConnection> {
    throw new NotSupportedError('Outlook OAuth is not available — use an ICS link instead.');
  },

  async remove(id: string): Promise<boolean> {
    await api.removeCalendar(id);
    return true;
  },

  async getHealth(): Promise<CalendarHealth> {
    const h: OSSCalendarHealth = await api.getCalendarHealth();
    return {
      googleConnected: h.googleConfigured,
      outlookConnected: h.outlookConfigured,
      lastError: h.lastError ?? undefined,
      lastCheckedAt: h.lastPollAt ? new Date(h.lastPollAt).toISOString() : new Date().toISOString(),
    };
  },
};
