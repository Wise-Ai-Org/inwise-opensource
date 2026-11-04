import React, { useEffect, useState } from 'react';
import { api, useNav } from './nav';

type Agent = 'claude-code' | 'codex';
type Chat = 'claude-chat' | 'chatgpt';
const AGENT_LABEL: Record<Agent, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };
const CHAT_LABEL: Record<Chat, string> = { 'claude-chat': 'Claude', chatgpt: 'ChatGPT' };
const INSTALL_URL: Record<Agent, string> = {
  'claude-code': 'https://docs.claude.com/en/docs/claude-code/setup',
  codex: 'https://developers.openai.com/codex/cli',
};

interface Readiness {
  serverRunning: boolean;
  serverEnabled: boolean;
  writeback: boolean;
  folder: string | null;
  installed: Record<Agent, boolean>;
  introSeen: boolean;
}

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '');
const PASTE_KEYS = isMac ? 'Cmd+V' : 'Ctrl+V';

function shortPath(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…${p.includes('\\') ? '\\' : '/'}${parts.slice(-2).join(p.includes('\\') ? '\\' : '/')}` : p;
}

function timeLabel(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/**
 * "Hand this to AI" on the task page. First use opens a sheet that explains
 * the three steps and sets up the folder and write-back; after that one click
 * opens the agent in a terminal.
 */
export default function HandoffCard({ task, onHandedOff }: { task: any; onHandedOff: () => void }) {
  const { push } = useNav();
  const [ready, setReady] = useState<Readiness | null>(null);
  const [chatNoticeSeen, setChatNoticeSeen] = useState(true);
  const [setupFor, setSetupFor] = useState<Agent | null>(null);
  const [chatFor, setChatFor] = useState<Chat | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    api().handoffStatus?.().then(setReady).catch(() => {});
    api().getConfig?.().then((c: any) => setChatNoticeSeen(c?.handoffChatNoticeSeen === true)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const needsSetup = (r: Readiness, a: Agent) =>
    !r.introSeen || !r.folder || !r.serverEnabled || !r.serverRunning || !r.installed[a];

  const launch = async (a: Agent) => {
    setError(null);
    const r: Readiness | null = await api().handoffStatus?.(true).catch(() => null);
    if (r) setReady(r);
    if (!r || needsSetup(r, a)) { setSetupFor(a); return; }
    setBusy(true);
    try {
      const res = await api().handoffLaunchAgent?.(task._id, a);
      if (res?.ok) {
        setToast(`${AGENT_LABEL[a]} is opening in a terminal window. Approve its plan there.`);
        onHandedOff();
      } else {
        if (res?.readiness) { setReady(res.readiness); setSetupFor(a); }
        setError(res?.error || 'Could not start the agent.');
      }
    } finally {
      setBusy(false);
    }
  };

  const openChat = async (c: Chat, confirmed = false) => {
    setError(null);
    if (!chatNoticeSeen && !confirmed) { setChatFor(c); return; }
    const res = await api().handoffOpenChat?.(task._id, c);
    setChatFor(null);
    if (res?.ok) {
      setChatNoticeSeen(true);
      setToast(`Task copied. Paste it into the new ${CHAT_LABEL[c]} chat with ${PASTE_KEYS}.`);
    } else {
      setError(res?.error || `Could not open ${CHAT_LABEL[c]}.`);
    }
  };

  const handoff = task.handoff as { client: Agent; at: string } | undefined;
  const execAt = task.executionSummary?.createdAt;
  const execStartedAfter = !!(handoff && execAt && new Date(execAt).getTime() >= new Date(handoff.at).getTime() - 60_000);
  const waiting = handoff && !execStartedAfter && Date.now() - new Date(handoff.at).getTime() < 24 * 3600_000;

  return (
    <>
      <div className="pp-seclabel">Hand this to AI</div>
      <div className="pp-card pp-handoff">
        {waiting ? (
          <div className="pp-handoff-wait">
            <span className="pp-handoff-pulse" aria-hidden="true" />
            <div>
              <div className="pp-title-sm">Handed to {AGENT_LABEL[handoff!.client] || 'an AI agent'} at {timeLabel(handoff!.at)}</div>
              <div className="pp-meta" style={{ marginTop: 2, lineHeight: 1.45 }}>
                Look for the terminal window. Once you approve its plan there, progress and results show up on this page.
              </div>
            </div>
          </div>
        ) : (
          <div className="pp-meta" style={{ lineHeight: 1.45 }}>
            An AI agent reads this task and the meeting it came from, shows you a plan, and saves what it did here.
          </div>
        )}
        <div className="pp-row" style={{ gap: 8, marginTop: 10 }}>
          {(['claude-code', 'codex'] as Agent[]).map((a, i) => (
            <button
              key={a}
              className={`pp-btn ${i === 0 ? 'pp-solid' : 'pp-ghost'}`}
              style={{ flex: 1, padding: '7px 0' }}
              disabled={busy}
              onClick={() => launch(a)}
            >
              {waiting && handoff!.client === a ? `Open ${AGENT_LABEL[a]} again` : AGENT_LABEL[a]}
            </button>
          ))}
        </div>
        <div className="pp-row pp-handoff-chat">
          <span className="pp-meta">Or talk it through in a chat:</span>
          <button className="pp-quiet-action" onClick={() => openChat('claude-chat')}>Claude</button>
          <button className="pp-quiet-action" onClick={() => openChat('chatgpt')}>ChatGPT</button>
        </div>
        {ready?.folder && ready.introSeen && (
          <div className="pp-meta pp-handoff-folder" title={ready.folder}>
            Agents work in {shortPath(ready.folder)}
            <button className="pp-quiet-action" onClick={async () => {
              const r = await api().handoffPickFolder?.();
              if (r?.ok) setReady(x => (x ? { ...x, folder: r.folder } : x));
              else if (r?.error) setError(r.error);
            }}>Change</button>
          </div>
        )}
        {toast && <div className="pp-handoff-toast" role="status">{toast}</div>}
        {error && !setupFor && <div className="pp-meta" style={{ color: 'var(--red)', marginTop: 6 }}>{error}</div>}
      </div>

      {setupFor && ready && (
        <SetupSheet
          agent={setupFor}
          ready={ready}
          error={error}
          onReady={setReady}
          onClose={() => { setSetupFor(null); setError(null); }}
          onOpenSettings={() => { setSetupFor(null); push({ kind: 'settings-section', section: 'ai-connect', title: 'Connect to AI' }); }}
          onStart={async (writeback) => {
            setBusy(true);
            setError(null);
            try {
              const s = await api().handoffSetup?.({ writeback });
              if (!s?.ok) { setError(s?.error || 'Setup failed.'); return; }
              setReady(s.readiness);
              const a = setupFor;
              setSetupFor(null);
              await launch(a);
            } finally {
              setBusy(false);
            }
          }}
          busy={busy}
        />
      )}

      {chatFor && (
        <>
          <div className="pp-sheet-backdrop" onClick={() => setChatFor(null)} />
          <div className="pp-sheet" role="dialog" aria-label={`Open in ${CHAT_LABEL[chatFor]}`}>
            <div className="pp-sheet-handle" />
            <div className="pp-title-sm" style={{ fontSize: 15 }}>Talk it through with {CHAT_LABEL[chatFor]}</div>
            <ol className="pp-handoff-steps">
              <li>Inwise copies this task and a short quote from its meeting.</li>
              <li>A new {CHAT_LABEL[chatFor]} chat opens in your browser. Paste with {PASTE_KEYS}.</li>
              <li>Good for thinking it through or drafting. A chat cannot save results back to Inwise; use Claude Code or Codex for that.</li>
            </ol>
            <div className="pp-handoff-note">
              What you paste is sent to {chatFor === 'chatgpt' ? 'OpenAI' : 'Anthropic'} under your {CHAT_LABEL[chatFor]} account. Read it before you send.
            </div>
            <div className="pp-row" style={{ gap: 8 }}>
              <button className="pp-btn pp-ghost" style={{ flex: 1 }} onClick={() => setChatFor(null)}>Cancel</button>
              <button className="pp-btn pp-solid" style={{ flex: 2 }} onClick={() => openChat(chatFor, true)}>
                Copy and open {CHAT_LABEL[chatFor]}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}

function SetupSheet({ agent, ready, error, busy, onReady, onClose, onStart, onOpenSettings }: {
  agent: Agent;
  ready: Readiness;
  error: string | null;
  busy: boolean;
  onReady: (r: Readiness) => void;
  onClose: () => void;
  onStart: (writeback: boolean) => void;
  onOpenSettings: () => void;
}) {
  const [writeback, setWriteback] = useState(ready.introSeen ? ready.writeback : true);
  const [folderError, setFolderError] = useState<string | null>(null);
  const label = AGENT_LABEL[agent];
  const installed = ready.installed[agent];
  const canStart = !!ready.folder && installed && !busy;

  const pick = async () => {
    setFolderError(null);
    const r = await api().handoffPickFolder?.();
    if (r?.ok) onReady({ ...ready, folder: r.folder });
    else if (r?.error) setFolderError(r.error);
  };

  return (
    <>
      <div className="pp-sheet-backdrop" onClick={onClose} />
      <div className="pp-sheet" role="dialog" aria-label="Hand tasks to an AI agent">
        <div className="pp-sheet-handle" />
        <div className="pp-title-sm" style={{ fontSize: 15 }}>Hand tasks to an AI agent</div>
        <ol className="pp-handoff-steps">
          <li>Inwise opens a terminal window and starts {label} in a folder you choose, such as a project or a documents folder.</li>
          <li>{label} reads this task and the meeting it came from, then shows you a plan. Nothing changes until you approve it in the terminal.</li>
          <li>When it is done, it saves what it did to this task, so you see the result here.</li>
        </ol>

        <div className="pp-listcard">
          <div className="pp-setrow" style={{ cursor: 'default' }}>
            <div className="pp-grow">
              <div className="pp-rowlabel" style={{ fontWeight: 500 }}>Folder to work in</div>
              <div className="pp-meta" title={ready.folder || ''}>{ready.folder ? shortPath(ready.folder) : 'Not chosen yet'}</div>
            </div>
            <button className="pp-btn pp-ghost" onClick={pick}>{ready.folder ? 'Change' : 'Choose…'}</button>
          </div>
          <div className="pp-setrow" style={{ cursor: 'default', borderTop: '1px solid var(--slate-100)' }}>
            <div className="pp-grow">
              <div className="pp-rowlabel" style={{ fontWeight: 500 }}>{label}</div>
              <div className="pp-meta">{installed ? 'Installed on this computer' : 'Not found on this computer'}</div>
            </div>
            {!installed && (
              <button className="pp-btn pp-ghost" onClick={() => api().openExternal?.(INSTALL_URL[agent])}>How to install</button>
            )}
          </div>
          <label className="pp-setrow" style={{ cursor: 'pointer', borderTop: '1px solid var(--slate-100)', alignItems: 'flex-start' }}>
            <input type="checkbox" checked={writeback} onChange={e => setWriteback(e.target.checked)} style={{ marginTop: 3 }} />
            <div className="pp-grow">
              <div className="pp-rowlabel" style={{ fontWeight: 500 }}>Save the agent's plan and results to my tasks</div>
              <div className="pp-meta" style={{ lineHeight: 1.45 }}>It can only update a task after you approve its plan. Without this, it gives you a summary in the terminal instead.</div>
            </div>
          </label>
        </div>

        <div className="pp-handoff-note">
          The agent reads your meetings through a connection that only works on this computer.
          {' '}{label} sends what it reads to {agent === 'codex' ? 'OpenAI' : 'Anthropic'} to do the work.
          {!ready.serverEnabled && ' Starting turns on Connect to AI in Settings.'}
          {' '}<button className="pp-quiet-action" style={{ padding: 0 }} onClick={onOpenSettings}>Connect to AI settings</button>
        </div>

        {(folderError || error) && <div className="pp-meta" style={{ color: 'var(--red)' }}>{folderError || error}</div>}
        {!installed && (
          <div className="pp-meta">After installing {label}, come back and press Check again.</div>
        )}
        <div className="pp-row" style={{ gap: 8 }}>
          <button className="pp-btn pp-ghost" style={{ flex: 1 }} onClick={onClose} disabled={busy}>Cancel</button>
          {installed ? (
            <button className="pp-btn pp-solid" style={{ flex: 2 }} disabled={!canStart} onClick={() => onStart(writeback)}>
              {busy ? 'Starting…' : `Start ${label}`}
            </button>
          ) : (
            <button className="pp-btn pp-solid" style={{ flex: 2 }} onClick={async () => {
              const r = await api().handoffStatus?.(true);
              if (r) onReady(r);
            }}>Check again</button>
          )}
        </div>
      </div>
    </>
  );
}
