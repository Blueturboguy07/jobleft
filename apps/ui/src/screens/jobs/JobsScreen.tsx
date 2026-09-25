// The Jobs screen: the four tabs (Recommended, Liked, Applied, External) plus Hidden, and the job detail opened
// over them. The tab below stays mounted (inert while the detail is open), so closing the detail returns to the
// same list, filters and scroll position, and focus goes back to the card that opened it.

import { useEffect, useLayoutEffect, useRef } from 'react';
import { navigate } from '../../app/router.ts';
import { ErrorBoundary } from '../../components/States.tsx';
import { JobDetail } from '../detail/JobDetail.tsx';
import { Feed } from './Feed.tsx';
import { AppliedTab, ExternalTab, HiddenTab, LikedTab } from './TrackerTabs.tsx';

export type JobsTab = 'recommended' | 'liked' | 'applied' | 'external' | 'hidden';
export const JOB_TABS: JobsTab[] = ['recommended', 'liked', 'applied', 'external', 'hidden'];

let lastTab: JobsTab = 'recommended';
export function backgroundTab(): JobsTab {
  return lastTab;
}

export function JobsScreen({ tab, detailId }: { tab: JobsTab | null; detailId: string | null }) {
  const current: JobsTab = tab ?? lastTab;
  if (tab) lastTab = tab;
  const underRef = useRef<HTMLDivElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const el = underRef.current;
    if (!el) return;
    if (detailId) {
      if (!opener.current) opener.current = document.activeElement as HTMLElement | null;
      el.setAttribute('inert', '');
      el.setAttribute('aria-hidden', 'true');
    } else {
      el.removeAttribute('inert');
      el.removeAttribute('aria-hidden');
    }
  }, [detailId]);

  useEffect(() => {
    if (detailId) return;
    const o = opener.current;
    opener.current = null;
    if (o && document.contains(o)) o.focus({ preventScroll: true });
  }, [detailId]);

  const close = () => navigate(current === 'recommended' ? 'jobs' : `jobs/${current}`);

  return (
    <div className="jl-content" style={{ flex: 1 }}>
      <div ref={underRef} style={{ display: 'flex', flex: 1, minWidth: 0 }} id="jl-jobs-under">
        <ErrorBoundary label="This list stopped working" resetKey={current}>
          {current === 'recommended' && <Feed />}
          {current === 'liked' && <LikedTab />}
          {current === 'applied' && <AppliedTab />}
          {current === 'external' && <ExternalTab />}
          {current === 'hidden' && <HiddenTab />}
        </ErrorBoundary>
      </div>
      {detailId && (
        <div className="jl-overlay">
          <ErrorBoundary label="This job could not be shown" resetKey={detailId}>
            <JobDetail id={detailId} onClose={close} />
          </ErrorBoundary>
        </div>
      )}
    </div>
  );
}
