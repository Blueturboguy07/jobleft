// The app root: routes (see SCREENS in src/index.ts), the shell, the first-run onboarding, and the window title.

import { useEffect, useRef } from 'react';
import { Button } from 'antd';
import { Art, LogoMark, Wordmark } from '../components/Art.tsx';
import { ChatPanel, ConnectionBanner, Rail, TopBar, type ScreenId } from '../components/Shell.tsx';
import { ErrorBoundary } from '../components/States.tsx';
import { AssistantScreen } from '../screens/Assistant.tsx';
import { Dashboard } from '../screens/Dashboard.tsx';
import { InterviewScreen } from '../screens/Interview.tsx';
import { JOB_TABS, JobsScreen, backgroundTab, type JobsTab } from '../screens/jobs/JobsScreen.tsx';
import { NetworkScreen } from '../screens/Network.tsx';
import { Notifications } from '../screens/Notifications.tsx';
import { Onboarding, onboardingSkipped } from '../screens/Onboarding.tsx';
import { ProfileScreen } from '../screens/Profile.tsx';
import { ResumeEditor } from '../screens/ResumeEditor.tsx';
import { ResumeScreen } from '../screens/Resume.tsx';
import { SettingsScreen } from '../screens/Settings.tsx';
import { TrackerScreen } from '../screens/Tracker.tsx';
import { call, hasToken } from './api.ts';
import { navigate, useRoute } from './router.ts';
import { useCrawlWatcher, useOnboarding, useProfile } from './session.ts';
import { setupPending } from '../lib/onboarding.ts';

function NoToken() {
  return (
    <main className="jl-onboard" style={{ justifyContent: 'center' }}>
      <section className="jl-state" aria-labelledby="nt-h">
        <LogoMark size={56} />
        <h1 id="nt-h" style={{ fontSize: 22 }}>Open <Wordmark size={22} /> from its launcher</h1>
        <p>This window has no key to talk to jobleft on this Mac. Close it and open jobleft again, or use the address the launcher printed.</p>
      </section>
    </main>
  );
}

const WINDOW_TITLES: Record<ScreenId, string> = {
  jobs: 'Jobs', tracker: 'Tracker', dashboard: 'Dashboard', resume: 'Resume', profile: 'Profile', network: 'Network', interview: 'Interview',
  assistant: 'Assistant', settings: 'Settings', notifications: 'Alerts',
};

export function App() {
  const route = useRoute();
  const profile = useProfile();
  const setup = useOnboarding();
  useCrawlWatcher();
  const gateChecked = useRef(false);

  // At launch, a setup that was never finished or skipped opens again, on the step the person was on
  // (JL-onboarding-11: a saved preference alone never counts as a finished setup).
  useEffect(() => {
    if (gateChecked.current || !profile.data || !setup.data) return;
    gateChecked.current = true;
    const legacy = onboardingSkipped();
    if (setup.data.status === 'new' && legacy) {
      // carried over from jobleft 0.1.2, which kept "skipped" only in this browser
      void call('putOnboarding', { body: { ...setup.data, status: 'skipped' } }).then(() => undefined, () => undefined);
    }
    if (setupPending(setup.data, legacy) && route[0] !== 'onboarding') navigate('onboarding', { replace: true });
  }, [profile.data, setup.data]);

  if (!hasToken()) return <NoToken />;
  if (route[0] === 'onboarding') {
    document.title = 'Welcome · jobleft';
    return <ErrorBoundary label="Setup stopped working"><Onboarding /></ErrorBoundary>;
  }

  const head = (route[0] ?? 'jobs') as string;
  let screen: ScreenId = 'jobs';
  let body;
  let jobsTab: JobsTab | null = null;
  switch (head) {
    case 'jobs': {
      const second = route[1] ?? null;
      const isTab = second === null || (JOB_TABS as string[]).includes(second);
      jobsTab = isTab ? ((second ?? 'recommended') as JobsTab) : null;
      body = <JobsScreen tab={jobsTab} detailId={isTab ? null : second} />;
      if (!isTab) jobsTab = backgroundTab();
      break;
    }
    case 'tracker': screen = 'tracker'; body = <TrackerScreen />; break;
    case 'dashboard': screen = 'dashboard'; body = <Dashboard />; break;
    case 'resume': screen = 'resume'; body = route[1] ? <ResumeEditor id={route[1]} /> : <ResumeScreen />; break;
    case 'profile': screen = 'profile'; body = <ProfileScreen />; break;
    case 'network': screen = 'network'; body = <NetworkScreen tab={route[1] ?? null} />; break;
    case 'interview': screen = 'interview'; body = <InterviewScreen />; break;
    case 'assistant': screen = 'assistant'; body = <AssistantScreen chatId={route[1] ?? null} />; break;
    case 'settings': case 'boards': screen = 'settings'; body = <SettingsScreen tab={head === 'boards' ? 'sources' : route[1] ?? null} />; break;
    case 'notifications': screen = 'notifications'; body = <Notifications />; break;
    default:
      body = (
        <section className="jl-state" style={{ marginTop: 48 }}>
          <Art kind="box" />
          <h2>This page does not exist</h2>
          <Button type="primary" shape="round" onClick={() => navigate('jobs')}>Go to jobs</Button>
        </section>
      );
  }
  if (head === 'jobs' || !['tracker', 'dashboard', 'resume', 'profile', 'network', 'interview', 'assistant', 'settings', 'boards', 'notifications'].includes(head)) screen = 'jobs';
  document.title = `${WINDOW_TITLES[screen]} · jobleft`;

  return (
    <div className="jl-shell">
      <a className="jl-skip" href="#jl-main" onClick={(e) => { e.preventDefault(); document.getElementById('jl-main')?.focus(); }}>Skip to content</a>
      <Rail active={screen} />
      <div className="jl-main">
        <TopBar screen={screen} jobsTab={jobsTab} />
        <ConnectionBanner />
        <main id="jl-main" className="jl-content" tabIndex={-1} style={{ outline: 'none' }}>
          <ErrorBoundary label="This screen stopped working" resetKey={route.join('/')}>{body}</ErrorBoundary>
        </main>
      </div>
      <ChatPanel />
    </div>
  );
}
