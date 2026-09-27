// The app shell: the left navigation rail (always on screen), the top bar (screen title, the job tabs with count
// pills, search, and the AI chip that shows the dollar balance when publik is the provider), the connection banner,
// and the assistant button and panel.

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Alert, Button, Input } from 'antd';
import { Tooltip } from './Tip.tsx';
import { SearchOutlined, CloseOutlined, ExpandAltOutlined } from '@ant-design/icons';
import { formatDollars } from '@jobleft/contracts';
import { navigate } from '../app/router.ts';
import { useLayer, useReturnFocus } from '../app/layers.ts';
import { invalidate } from '../app/data.ts';
import { setFeed, useAiSettings, useFeed, useNotifications, usePublik, useTrackerCounts } from '../app/session.ts';
import { aiCheckFailed, lastAiCheck, subscribeAiCheck } from '../lib/aiHealth.ts';
import { LogoMark } from './Art.tsx';
import { Chat } from './Chat.tsx';
import { closeChat, openChat, useChatTarget } from './chatStore.ts';
import { IconAssistant, IconBell, IconDashboard, IconInterview, IconJobs, IconNetwork, IconProfile, IconResume, IconSettings, IconTracker, IconSparkle } from './Icons.tsx';

export type ScreenId = 'jobs' | 'tracker' | 'dashboard' | 'resume' | 'profile' | 'network' | 'interview' | 'assistant' | 'settings' | 'notifications';

const NAV: Array<{ id: ScreenId; label: string; icon: ReactNode; to: string }> = [
  { id: 'jobs', label: 'Jobs', icon: <IconJobs />, to: '#/jobs' },
  { id: 'tracker', label: 'Tracker', icon: <IconTracker />, to: '#/tracker' },
  { id: 'dashboard', label: 'Dashboard', icon: <IconDashboard />, to: '#/dashboard' },
  { id: 'resume', label: 'Resume', icon: <IconResume />, to: '#/resume' },
  { id: 'profile', label: 'Profile', icon: <IconProfile />, to: '#/profile' },
  { id: 'network', label: 'Network', icon: <IconNetwork />, to: '#/network' },
  { id: 'interview', label: 'Interview', icon: <IconInterview />, to: '#/interview' },
  { id: 'assistant', label: 'Assistant', icon: <IconAssistant />, to: '#/assistant' },
];

export function Rail({ active }: { active: ScreenId }) {
  const notes = useNotifications();
  const n = notes.data?.length ?? 0;
  return (
    <nav className="jl-rail" aria-label="Main">
      <a className="jl-rail-logo" href="#/jobs" aria-label="jobleft, go to jobs"><LogoMark size={36} title="jobleft" /></a>
      <div className="jl-rail-nav">
        {NAV.map((x) => (
          <a key={x.id} href={x.to} className="jl-rail-item" aria-current={active === x.id ? 'page' : undefined}>
            {x.icon}<span>{x.label}</span>
          </a>
        ))}
      </div>
      <div className="jl-rail-bottom">
        <a href="#/notifications" className="jl-rail-item" aria-current={active === 'notifications' ? 'page' : undefined} aria-label={`Alerts${n ? `, ${n} new` : ''}`}>
          <IconBell /><span>Alerts</span>
          {n > 0 && <span className="jl-rail-badge" aria-hidden="true">{n > 99 ? '99+' : n}</span>}
        </a>
        <a href="#/settings" className="jl-rail-item" aria-current={active === 'settings' ? 'page' : undefined}>
          <IconSettings /><span>Settings</span>
        </a>
      </div>
    </nav>
  );
}

/** The AI chip: the dollar balance with publik, or where AI answers come from. */
export function ProviderChip({ compact = false }: { compact?: boolean }) {
  const ai = useAiSettings();
  const s = ai.data;
  const lastCheck = useSyncExternalStore(subscribeAiCheck, lastAiCheck);
  const publik = usePublik(s?.provider === 'publik');
  let text = 'AI: not set up';
  let on = false;
  let to = 'settings/ai';
  if (s?.provider === 'publik') {
    const w = publik.data?.wallet;
    if (publik.data?.state === 'connected' && w) { text = `Balance: ${formatDollars(w.balanceMicros)}`; on = true; to = 'settings/balance'; }
    else if (publik.error) { text = 'Balance: not available'; to = 'settings/balance'; }
    else if (publik.data) { text = 'publik: not connected'; to = 'settings/balance'; }
    else text = 'Balance: …';
  } else if (s?.provider === 'local') { text = compact ? 'AI on this Mac' : 'AI: model on this Mac'; on = true; }
  else if (s?.provider === 'custom') { text = 'AI: your server'; on = true; }
  else if (s?.provider === 'own_key') { text = 'AI: your own key'; on = true; }
  // The last setup check of these settings failed (JL-settings-3): never a green dot then.
  if (s?.provider && s.provider !== 'publik' && aiCheckFailed(lastCheck, s.updatedAt)) { text = 'AI: not answering'; on = false; }
  return (
    <Tooltip title={s?.provider === 'publik' ? 'Your publik balance in dollars. Select to see it or add money.' : 'Where AI answers come from. Select to change it.'}>
      <button type="button" className="jl-status-chip" onClick={() => navigate(to)}>
        <span className={`dot${on ? '' : ' off'}`} aria-hidden="true" />{text}
      </button>
    </Tooltip>
  );
}

function JobsTabs({ tab }: { tab: string | null }) {
  const counts = useTrackerCounts();
  const c = counts.data;
  const tabs = [
    { id: 'recommended', label: 'Recommended', to: '#/jobs', n: null },
    { id: 'liked', label: 'Liked', to: '#/jobs/liked', n: c?.liked ?? null },
    // Every application, whatever its stage: "Applications", so it never reads as the Tracker's "Applied" column (JL-tracker-23).
    { id: 'applied', label: 'Applications', to: '#/jobs/applied', n: c?.applied ?? null },
    { id: 'external', label: 'External', to: '#/jobs/external', n: c?.external ?? null },
  ];
  return (
    <nav className="jl-topbar-tabs" aria-label="Job lists">
      {tabs.map((t) => (
        <a key={t.id} href={t.to} className="jl-toptab" aria-current={tab === t.id ? 'page' : undefined} aria-label={t.n !== null ? `${t.label}, ${t.n}` : t.label}>
          {t.label}{t.n !== null && <span className="jl-pill" aria-hidden="true">{t.n}</span>}
        </a>
      ))}
    </nav>
  );
}

/** The longest search the jobs search takes (JobSearchRequest.q); the box stops there (JL-feed-17). */
const SEARCH_MAX = 500;

function JobSearch({ onRecommended }: { onRecommended: boolean }) {
  const feed = useFeed();
  const [v, setV] = useState(feed.q);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { setV(feed.q); }, [feed.q]);
  const commit = (q0: string) => {
    const q = q0.slice(0, SEARCH_MAX);
    if (timer.current) clearTimeout(timer.current);
    setFeed({ q });
    if (!onRecommended && q.trim()) navigate('jobs');
  };
  return (
    <Input className="jl-search" allowClear prefix={<SearchOutlined aria-hidden="true" />} placeholder="Search title, company or words" value={v}
      maxLength={SEARCH_MAX} title={v.length >= SEARCH_MAX ? `Search words stop at ${SEARCH_MAX} characters.` : undefined}
      aria-label="Search jobs by title, company or words"
      onChange={(e) => { const q = e.target.value; setV(q); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => commit(q), 120); }}
      onPressEnter={() => commit(v)} />
  );
}

const TITLES: Record<ScreenId, string> = {
  jobs: 'Jobs', tracker: 'Tracker', dashboard: 'Dashboard', resume: 'Resume', profile: 'Profile', network: 'Network', interview: 'Interview',
  assistant: 'Assistant', settings: 'Settings', notifications: 'Alerts',
};

/** The assistant button in the top bar: opens or closes the assistant panel (the panel stays over the page, closes with Esc). */
function AssistantButton() {
  const t = useChatTarget();
  return (
    <Tooltip title={t.open ? 'Close the assistant' : 'Ask the assistant'}>
      <button type="button" className="jl-assist-btn" aria-label={t.open ? 'Close the assistant panel' : 'Open the assistant panel'} aria-expanded={t.open}
        onClick={() => { if (t.open) closeChat(); else openChat({}); }}><IconSparkle size={20} /></button>
    </Tooltip>
  );
}

export function TopBar({ screen, jobsTab }: { screen: ScreenId; jobsTab: string | null }) {
  return (
    <header className="jl-topbar">
      <h1 className="jl-title">{TITLES[screen]}</h1>
      {screen === 'jobs' && <><span aria-hidden="true" className="jl-sep">›</span><JobsTabs tab={jobsTab} /></>}
      <div className="jl-topbar-right">
        {screen === 'jobs' && <JobSearch onRecommended={jobsTab === 'recommended'} />}
        {screen !== 'assistant' && <AssistantButton />}
        <ProviderChip />
      </div>
    </header>
  );
}

/** Says plainly when the local service or the network is not there; the rest of the app keeps working. */
export function ConnectionBanner() {
  const [local, setLocal] = useState(true);
  const [online, setOnline] = useState(navigator.onLine);
  const wasDown = useRef(false);
  useEffect(() => {
    let alive = true;
    const ping = async () => {
      let ok = false;
      try { ok = (await fetch('api/v1/health', { cache: 'no-store' })).ok; } catch { ok = false; }
      if (!alive) return;
      setLocal(ok);
      // the service came back: every screen reads its data again, so nothing stays on old or empty values
      if (ok && wasDown.current) invalidate('');
      wasDown.current = !ok;
    };
    void ping();
    const t = setInterval(() => { void ping(); }, local ? 20000 : 4000);
    const on = () => setOnline(true), off = () => setOnline(false);
    let lastSoon = 0;
    const soon = () => { if (Date.now() - lastSoon > 1000) { lastSoon = Date.now(); void ping(); } };
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    window.addEventListener('jl-unreachable', soon);
    return () => { alive = false; clearInterval(t); window.removeEventListener('online', on); window.removeEventListener('offline', off); window.removeEventListener('jl-unreachable', soon); };
  }, [local]);
  if (!local) return <Alert className="jl-banner" type="error" banner showIcon message="jobleft's local service is not answering. Your data is safe on this Mac; jobleft keeps trying to reconnect." />;
  if (!online) return <Alert className="jl-banner" type="warning" banner showIcon message="This Mac reports no internet connection. Your saved jobs, tracker, resumes and profile still work. Steps that need the internet can fail until it is back." />;
  return null;
}

export function ChatPanel() {
  const t = useChatTarget();
  const [job, setJob] = useState<{ id: string | null; title: string | null }>({ id: null, title: null });
  const [thread, setThread] = useState<string | null>(null);
  useEffect(() => { if (t.open) { setJob({ id: t.jobId, title: t.title }); setThread(null); } }, [t.nonce]);
  useLayer(t.open, closeChat);
  useReturnFocus(t.open);
  if (!t.open) return null;
  return (
    <section className="jl-chatpanel" role="dialog" aria-label="Assistant">
      <header className="jl-row" style={{ padding: '10px 12px', borderBottom: '1px solid var(--jl-line)' }}>
        <span style={{ color: '#047A52' }} aria-hidden="true"><IconSparkle size={20} /></span>
        <strong className="jl-grow" style={{ fontSize: 16 }}>Assistant</strong>
        <Tooltip title="Open full screen"><Button type="text" shape="circle" icon={<ExpandAltOutlined />} aria-label="Open the assistant full screen" onClick={() => { closeChat(); navigate(thread ? `assistant/${encodeURIComponent(thread)}` : 'assistant'); }} /></Tooltip>
        <Tooltip title="Close (Esc)"><Button type="text" shape="circle" icon={<CloseOutlined />} aria-label="Close the assistant" onClick={closeChat} /></Tooltip>
      </header>
      <Chat jobId={job.id} jobTitle={job.title} chatId={thread} draft={t.draft} onThread={setThread} onClearJob={() => setJob({ id: null, title: null })} autoFocus />
    </section>
  );
}
