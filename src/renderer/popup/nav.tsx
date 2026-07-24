import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

export type Tab = 'meetings' | 'tasks' | 'people';

export type SettingsSectionKey =
  | 'ai' | 'transcription' | 'calendar' | 'jira' | 'zoom' | 'slack'
  | 'ai-connect' | 'integrations' | 'voice' | 'data';

export type Page =
  | { kind: 'settings-root' }
  | { kind: 'settings-section'; section: SettingsSectionKey; title: string }
  | { kind: 'review'; focus?: 'approvals' | 'priorities' | 'people' | 'voices' }
  | { kind: 'search' }
  | { kind: 'meeting'; id: string; title?: string }
  | { kind: 'task'; id: string }
  | { kind: 'person'; id: string; name?: string };

interface NavState {
  tab: Tab;
  stack: Page[];
  setTab: (tab: Tab) => void;
  push: (page: Page) => void;
  pop: () => void;
  popAll: () => void;
  /** Replace whole stack — used by deep links (notifications, chips). */
  openPage: (page: Page) => void;
}

const NavContext = createContext<NavState | null>(null);

export function NavProvider({ children }: { children: React.ReactNode }) {
  const [tab, setTabState] = useState<Tab>('meetings');
  const [stack, setStack] = useState<Page[]>([]);

  const setTab = useCallback((t: Tab) => {
    setTabState(t);
    setStack([]); // switching tabs always exits any drill-down
  }, []);
  const push = useCallback((page: Page) => setStack(s => [...s, page]), []);
  const pop = useCallback(() => setStack(s => s.slice(0, -1)), []);
  const popAll = useCallback(() => setStack([]), []);
  const openPage = useCallback((page: Page) => setStack([page]), []);

  const value = useMemo(
    () => ({ tab, stack, setTab, push, pop, popAll, openPage }),
    [tab, stack, setTab, push, pop, popAll, openPage],
  );
  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}

export function useNav(): NavState {
  const ctx = useContext(NavContext);
  if (!ctx) throw new Error('useNav must be used inside NavProvider');
  return ctx;
}

export const api = () => (window as any).inwiseAPI;

// ── Bridge for components outside the NavProvider (WelcomeBack, tour, IPC) ──
// Legacy view names map onto popup navigation via a window event the shell
// listens for.
export const POPUP_NAV_EVENT = 'pp-navigate';
export type LegacyView = 'communications' | 'tasks' | 'people' | 'settings';

export function requestPopupNav(detail: { view?: LegacyView; meetingId?: string }) {
  window.dispatchEvent(new CustomEvent(POPUP_NAV_EVENT, { detail }));
}

// ── Small shared helpers ─────────────────────────────────────────────────────

export function initials(name: string | null | undefined): string {
  return (name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0].toUpperCase())
    .join('') || '?';
}

export function fmtTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function fmtDueDate(iso: string | null | undefined): { label: string; overdue: boolean } | null {
  if (!iso) return null;
  const due = new Date(iso);
  if (Number.isNaN(due.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dueDay = new Date(due);
  dueDay.setHours(0, 0, 0, 0);
  const diffDays = Math.round((dueDay.getTime() - today.getTime()) / 86400000);
  if (diffDays < 0) return { label: `Overdue ${-diffDays}d`, overdue: true };
  if (diffDays === 0) return { label: 'Due today', overdue: true };
  if (diffDays === 1) return { label: 'Due tomorrow', overdue: false };
  return { label: due.toLocaleDateString([], { month: 'short', day: 'numeric' }), overdue: false };
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
