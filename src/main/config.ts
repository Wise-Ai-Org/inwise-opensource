import Store from 'electron-store';
import { randomUUID } from 'crypto';

export type CalendarProvider = 'google' | 'outlook' | 'ics';

export interface CalendarSubscription {
  id: string;
  label: string;
  provider: CalendarProvider;
  url: string;
  enabled: boolean;
}

interface Config {
  apiProvider: 'anthropic' | 'openai';
  apiKey: string;
  whisperModel: 'tiny' | 'base' | 'small' | 'medium';
  /** @deprecated use calendars[] — retained only for one-time migration */
  googleIcsUrl: string;
  /** @deprecated use calendars[] — retained only for one-time migration */
  outlookIcsUrl: string;
  calendars: CalendarSubscription[];
  selfEmails: string[];
  micDeviceId: string;
  userName: string;
  onboardingComplete: boolean;
  firstTimeFlowCount: number;
  jiraClientId: string;
  jiraClientSecret: string;
  jiraTokens: any | null;
  jiraAutoPush: boolean;
  jiraDefaultProject: string;
  lastOpenedAt: string | null;
  welcomeBackLastSeenAt: string | null;
}

const store = new Store<Config>({
  defaults: {
    apiProvider: 'anthropic',
    apiKey: '',
    whisperModel: 'base',
    googleIcsUrl: '',
    outlookIcsUrl: '',
    calendars: [],
    selfEmails: [],
    micDeviceId: 'default',
    userName: '',
    onboardingComplete: false,
    firstTimeFlowCount: 0,
    jiraClientId: '',
    jiraClientSecret: '',
    jiraTokens: null,
    jiraAutoPush: false,
    jiraDefaultProject: '',
    lastOpenedAt: null,
    welcomeBackLastSeenAt: null,
  },
});

export function getConfig(): Config {
  return store.store;
}

export function setConfig(updates: Partial<Config>): void {
  for (const [key, value] of Object.entries(updates)) {
    store.set(key as keyof Config, value);
  }
}

export function isOnboardingComplete(): boolean {
  return store.get('onboardingComplete') && store.get('apiKey') !== '';
}

export function listCalendars(): CalendarSubscription[] {
  return getConfig().calendars;
}

export function addCalendar(row: Omit<CalendarSubscription, 'id'>): CalendarSubscription {
  const created: CalendarSubscription = { id: randomUUID(), ...row };
  const next = [...listCalendars(), created];
  store.set('calendars', next);
  return created;
}

export function updateCalendar(
  id: string,
  patch: Partial<Omit<CalendarSubscription, 'id'>>,
): CalendarSubscription | null {
  const next = listCalendars().map((c) => (c.id === id ? { ...c, ...patch } : c));
  store.set('calendars', next);
  return next.find((c) => c.id === id) ?? null;
}

export function removeCalendar(id: string): void {
  const next = listCalendars().filter((c) => c.id !== id);
  store.set('calendars', next);
}

export function setSelfEmails(emails: string[]): void {
  store.set('selfEmails', emails);
}

// Snapshot the stored lastOpenedAt the first time this module is imported.
// markAppOpened() overwrites the stored value with now(), but the gap-since-
// last-open signal must reflect the PRIOR session, so we pin the prior value
// here for the lifetime of the current process.
const priorLastOpenedAtSnapshot: string | null = store.get('lastOpenedAt');

export function markAppOpened(): void {
  store.set('lastOpenedAt', new Date().toISOString());
}

/**
 * Pure helper exposed for tests: given an ISO timestamp (or null) and a
 * now-timestamp in ms, returns the gap in fractional days, or null when the
 * input is null/invalid.
 */
export function computeDaysSince(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  return (nowMs - then) / (1000 * 60 * 60 * 24);
}

export function getDaysSinceLastOpen(): number | null {
  return computeDaysSince(priorLastOpenedAtSnapshot, Date.now());
}

export function markWelcomeBackSeen(): void {
  store.set('welcomeBackLastSeenAt', new Date().toISOString());
}

/**
 * One-time migration: if calendars[] is empty but the deprecated
 * googleIcsUrl/outlookIcsUrl fields are set, seed calendars[] from them.
 * Idempotent — re-running is a no-op once calendars[] is non-empty.
 */
export function migrateLegacyCalendars(): { migrated: boolean; added: number } {
  const cfg = getConfig();
  if (cfg.calendars.length > 0) {
    return { migrated: false, added: 0 };
  }
  const seeded: CalendarSubscription[] = [];
  if (cfg.googleIcsUrl) {
    seeded.push({
      id: randomUUID(),
      label: 'Google',
      provider: 'google',
      url: cfg.googleIcsUrl,
      enabled: true,
    });
  }
  if (cfg.outlookIcsUrl) {
    seeded.push({
      id: randomUUID(),
      label: 'Outlook',
      provider: 'outlook',
      url: cfg.outlookIcsUrl,
      enabled: true,
    });
  }
  if (seeded.length === 0) {
    return { migrated: false, added: 0 };
  }
  store.set('calendars', seeded);
  return { migrated: true, added: seeded.length };
}
