import React, { createContext, useContext, useEffect, useState } from 'react';
import { NavProvider, useNav, api, Page, POPUP_NAV_EVENT, LegacyView } from './nav';
import { ReviewItems, useReviewItems } from './useReviewItems';
import MeetingsTab from './MeetingsTab';
import TasksTab from './TasksTab';
import PeopleTab from './PeopleTab';
import ReviewPage from './ReviewPage';
import SearchPage from './SearchPage';
import { SettingsRootPage, SettingsSectionPage } from './SettingsPages';
import MeetingDetailPage from './MeetingDetailPage';
import TaskDetailPage from './TaskDetailPage';
import PersonDetailPage from './PersonDetailPage';
import './popup.css';

const ReviewContext = createContext<ReviewItems | null>(null);
export function useReview(): ReviewItems {
  const ctx = useContext(ReviewContext);
  if (!ctx) throw new Error('useReview must be used inside PopupShell');
  return ctx;
}

function MenuDropdown({ onClose }: { onClose: () => void }) {
  const { push } = useNav();
  const [version, setVersion] = useState('');

  useEffect(() => {
    api().getAppVersion?.().then((v: string) => setVersion(v || '')).catch(() => {});
  }, []);

  const go = (page: Page) => {
    push(page);
    onClose();
  };

  return (
    <>
      <div className="pp-menu-backdrop" onClick={onClose} />
      <div className="pp-menu" role="menu">
        <button className="pp-menu-item" role="menuitem" onClick={() => go({ kind: 'search' })}>
          <span className="pp-menu-icon">⌕</span>Search meetings
        </button>
        <button className="pp-menu-item" role="menuitem" data-nav="settings" onClick={() => go({ kind: 'settings-root' })}>
          <span className="pp-menu-icon">⚙</span>Settings
        </button>
        <hr className="pp-menu-sep" />
        <button
          className="pp-menu-item pp-quiet"
          role="menuitem"
          onClick={() => { api().openExternal?.('https://github.com/inwise-ai/inwise/releases'); onClose(); }}
        >
          <span className="pp-menu-icon">↻</span>Check for updates
        </button>
        <div className="pp-menu-item pp-quiet" style={{ cursor: 'default' }}>
          <span className="pp-menu-icon">i</span>About Inwise{version ? ` · v${version}` : ''}
        </div>
        <hr className="pp-menu-sep" />
        <button className="pp-menu-item pp-quiet" role="menuitem" onClick={() => api().quitApp?.()}>
          <span className="pp-menu-icon">⏻</span>Quit Inwise
        </button>
      </div>
    </>
  );
}

function PageView({ page }: { page: Page }) {
  switch (page.kind) {
    case 'settings-root': return <SettingsRootPage />;
    case 'settings-section': return <SettingsSectionPage section={page.section} title={page.title} />;
    case 'review': return <ReviewPage focus={page.focus} />;
    case 'search': return <SearchPage />;
    case 'meeting': return <MeetingDetailPage meetingId={page.id} />;
    case 'task': return <TaskDetailPage taskId={page.id} />;
    case 'person': return <PersonDetailPage personId={page.id} />;
    default: return null;
  }
}

function ShellInner() {
  const { tab, stack, setTab, openPage } = useNav();
  const review = useReviewItems();
  const [menuOpen, setMenuOpen] = useState(false);
  const [pipelineError, setPipelineError] = useState<string | null>(null);

  // Extraction/pipeline failures were toasted in the old app; surface them as a
  // dismissible banner so a failed recording never dies silently.
  useEffect(() => {
    const a = api();
    const onPipelineError = (payload: any) => {
      const msg = String(payload?.message || payload?.error || 'Something went wrong processing a recording.');
      if (/api key|401|invalid[_ ]?key|authentication/i.test(msg)) {
        setPipelineError('Insight extraction failed — your AI API key looks invalid. Fix it in Settings › AI provider, then upload the transcript again.');
      } else {
        setPipelineError(`A recording failed to process: ${msg}`);
      }
    };
    a.on?.('pipeline:error', onPipelineError);
    return () => { a.off?.('pipeline:error', onPipelineError); };
  }, []);

  // Legacy navigation bridge: WelcomeBack, the first-time tour, and main-process
  // deep links (meeting:open-details) all speak the old view vocabulary.
  useEffect(() => {
    const onNavEvent = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      if (detail.meetingId) {
        setTab('meetings');
        openPage({ kind: 'meeting', id: detail.meetingId });
        return;
      }
      const view: LegacyView | undefined = detail.view;
      if (view === 'settings') openPage({ kind: 'settings-root' });
      else if (view === 'tasks') setTab('tasks');
      else if (view === 'people') setTab('people');
      else if (view === 'communications') setTab('meetings');
    };
    window.addEventListener(POPUP_NAV_EVENT, onNavEvent);

    const a = api();
    const onOpenDetails = (payload: { meetingId: string }) => {
      if (payload?.meetingId) {
        setTab('meetings');
        openPage({ kind: 'meeting', id: payload.meetingId });
      }
    };
    a.on?.('meeting:open-details', onOpenDetails);
    return () => {
      window.removeEventListener(POPUP_NAV_EVENT, onNavEvent);
      a.off?.('meeting:open-details', onOpenDetails);
    };
  }, [setTab, openPage]);

  const today = new Date();
  const dateLabel = today.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  const topPage = stack.length > 0 ? stack[stack.length - 1] : null;
  const onReviewPage = topPage?.kind === 'review';

  return (
    <ReviewContext.Provider value={review}>
      <div className="pp-root">
        <div className="pp-titlebar">
          <div className="pp-titlebar-left">
            <button className="pp-dots" aria-label="Menu" onClick={() => setMenuOpen(o => !o)}>•••</button>
            {review.count > 0 && !onReviewPage && (
              <button className="pp-review-pill" onClick={() => openPage({ kind: 'review' })}>
                {review.count} to review
              </button>
            )}
          </div>
          <div className="pp-winctl">
            <button aria-label="Hide" onClick={() => api().hideWindow?.()}>—</button>
            <button aria-label="Close" onClick={() => api().hideWindow?.()}>✕</button>
          </div>
        </div>

        {menuOpen && <MenuDropdown onClose={() => setMenuOpen(false)} />}

        {pipelineError && (
          <div style={{ margin: '4px 14px 0', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 12, padding: '10px 12px', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <div style={{ flex: 1, fontSize: 12, color: 'var(--red)', lineHeight: 1.5 }}>{pipelineError}</div>
            <button className="pp-quiet-action" aria-label="Dismiss error" onClick={() => setPipelineError(null)}>✕</button>
          </div>
        )}

        {topPage ? (
          <PageView page={topPage} />
        ) : (
          <>
            <div className="pp-datehead">{dateLabel}</div>
            <div className="pp-tabs" role="tablist">
              <button role="tab" aria-selected={tab === 'meetings'} className={`pp-tab ${tab === 'meetings' ? 'pp-on' : ''}`} onClick={() => setTab('meetings')}>
                Meetings
              </button>
              <button role="tab" aria-selected={tab === 'tasks'} data-nav="tasks" className={`pp-tab ${tab === 'tasks' ? 'pp-on' : ''}`} onClick={() => setTab('tasks')}>
                Tasks
              </button>
              <button role="tab" aria-selected={tab === 'people'} data-nav="people" className={`pp-tab ${tab === 'people' ? 'pp-on' : ''}`} onClick={() => setTab('people')}>
                People
              </button>
            </div>
            {tab === 'meetings' && <MeetingsTab />}
            {tab === 'tasks' && <TasksTab />}
            {tab === 'people' && <PeopleTab />}
          </>
        )}
      </div>
    </ReviewContext.Provider>
  );
}

export default function PopupShell() {
  return (
    <NavProvider>
      <ShellInner />
    </NavProvider>
  );
}
