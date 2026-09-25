// What the card buttons do. Every change waits for the server to confirm before the screen shows it as done.

import { useMemo } from 'react';
import { Button } from 'antd';
import type { TrackerPatch } from '@jobleft/contracts';
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

async function patch(jobId: string, body: TrackerPatch): Promise<boolean> {
  try {
    await call('updateTracker', { params: { jobId }, body });
    afterTrackerChange();
    return true;
  } catch (e) {
    ui.message?.error((e as { message: string }).message);
    return false;
  }
}

export function useCardActions(ops: ListOps): CardActions {
  return useMemo<CardActions>(() => ({
    open: (jobId) => navigate(`jobs/${encodeURIComponent(jobId)}`),
    like: async (item) => {
      const next = !item.liked;
      if (await patch(item.job.id, { liked: next })) {
        ops.update(item.job.id, { liked: next });
        ui.message?.success(next ? 'Added to Liked.' : 'Removed from Liked.');
      }
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
