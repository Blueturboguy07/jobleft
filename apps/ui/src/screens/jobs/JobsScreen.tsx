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
  const openerJob = useRef<string | null>(null);

  useLayoutEffect(() => {
    const el = underRef.current;
    if (!el) return;
    if (detailId) {
      if (!openerJob.current) { opener.current = document.activeElement as HTMLElement | null; openerJob.current = detailId; }
      el.setAttribute('inert', '');
      el.setAttribute('aria-hidden', 'true');
    } else {
      el.removeAttribute('inert');
      el.removeAttribute('aria-hidden');
    }
  }, [detailId]);

  // Closing the detail puts the keyboard focus back where it was: on the card that was opened. A virtual list may
  // have made that card's element again, so it is found again by its job id; without a card, focus goes to the main area.
  useEffect(() => {
    if (detailId) return;
    const o = opener.current;
    const id = openerJob.current;
    opener.current = null;
    openerJob.current = null;
    if (!o && !id) return;
    const again = id ? document.querySelector<HTMLElement>(`[data-job-id="${CSS.escape(id)}"] .jl-card-title a, [data-job-id="${CSS.escape(id)}"] a`) : null;
    const target = o && o !== document.body && document.contains(o) ? o : again;
    if (target) target.focus({ preventScroll: true });
    else document.getElementById('jl-main')?.focus({ preventScroll: true });
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
