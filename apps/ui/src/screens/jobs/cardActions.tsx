// What the card buttons do. Every change waits for the server to confirm before the screen shows it as done.

import { useMemo } from 'react';
import { Button } from 'antd';
import type { TrackerEntry, TrackerPatch } from '@jobleft/contracts';
import { call } from '../../app/api.ts';
import { ui } from '../../app/layers.ts';
import { navigate } from '../../app/router.ts';
import { afterTrackerChange } from '../../app/session.ts';
import { openChat } from '../../components/chatStore.ts';
import type { CardActions, CardItem } from '../../components/JobCard.tsx';

export interface ListOps {
  update: (jobId: string, patch: Partial<CardItem>) => void;
  remove?: (jobId: string) => void;
  reinsert?: (item: CardItem) => void;
}

async function patchEntry(jobId: string, body: TrackerPatch): Promise<TrackerEntry | null> {
  try {
    const e = await call('updateTracker', { params: { jobId }, body });
    afterTrackerChange();
    return e;
  } catch (e) {
    ui.message?.error((e as { message: string }).message);
    return null;
  }
}
const patch = async (jobId: string, body: TrackerPatch): Promise<boolean> => (await patchEntry(jobId, body)) !== null;

export function useCardActions(ops: ListOps): CardActions {
  return useMemo<CardActions>(() => ({
    open: (jobId) => navigate(`jobs/${encodeURIComponent(jobId)}`),
    like: async (item) => {
      const next = !item.liked;
      const e = await patchEntry(item.job.id, { liked: next });
      if (!e) return;
      ops.update(item.job.id, { liked: next });
      if (next) { ui.message?.success('Added to Liked.'); return; }
      // An unlike is one click: say what stays, and offer Undo (JL-tracker-6, JL-tracker-21).
      const key = `unlike-${item.job.id}`;
      const kept = e.notes.length > 0 || e.reminders.some((r) => !r.done);
      ui.message?.open({
        type: 'success', duration: 8, key,
        content: (
          <span>Removed from Liked.{kept ? ' Its notes and reminders stay in the Tracker.' : ''}{' '}
            <Button size="small" type="link" onClick={async () => {
              ui.message?.destroy(key);
              if (await patch(item.job.id, { liked: true })) { ops.update(item.job.id, { liked: true }); ui.message?.success('Liked again.'); }
            }}>Undo</Button>
          </span>
        ),
      });
    },
    hide: async (item) => {
      const next = !item.hidden;
      if (!(await patch(item.job.id, { hidden: next }))) return;
      if (next && ops.remove) {
        ops.remove(item.job.id);
        const key = `hide-${item.job.id}`;
        ui.message?.open({
          type: 'success', duration: 8, key,
          content: (
            <span>Hidden: {item.job.title}.{' '}
              <Button size="small" type="link" onClick={async () => {
                ui.message?.destroy(key);
                if (await patch(item.job.id, { hidden: false })) { ops.reinsert?.({ ...item, hidden: false }); ui.message?.success('Shown again.'); }
              }}>Undo</Button>
            </span>
          ),
        });
      } else ops.update(item.job.id, { hidden: next });
    },
    ask: (item) => openChat({ jobId: item.job.id, title: `${item.job.title} at ${item.job.company}` }),
    markApplied: async (item) => {
      if (await patch(item.job.id, { status: 'applied' })) {
        ops.update(item.job.id, { trackerStatus: 'applied' });
        ui.message?.success('Marked as applied. It is in Applied and in the tracker.');
      }
    },
    addProfile: () => navigate('profile'),
  }), [ops]);
}
