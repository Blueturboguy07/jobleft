// The one rule for the sponsor tag AND the H-1B filter (static-data O3, O8): the post's own words win; the filing
// history is used only when the post says nothing. A post that requires US citizenship or a clearance gets its own
// words, never the words of "no sponsorship", and never a history-based positive tag.

import type { H1bSummary, PostingStatements } from '@jobleft/contracts';

export type H1bTag = 'likely_by_history' | 'post_says_yes' | 'post_says_no';

export interface H1bTagResult {
  /** The contract's h1bTag value (JobListItem.h1bTag). */
  tag: H1bTag | null;
  reason: 'post_no_sponsorship' | 'post_us_citizen_only' | 'post_clearance_required' | 'post_offers_sponsorship' | 'filing_history' | null;
  /** Short text for the card and detail. Hedged; never "no H-1B" from missing data. */
  label: string | null;
}

export function h1bTagFor(statements: Pick<PostingStatements, 'sponsorship' | 'clearanceRequired' | 'usCitizenOnly'> | null | undefined, summary: Pick<H1bSummary, 'status'> | null | undefined): H1bTagResult {
  const s = statements ?? { sponsorship: null, clearanceRequired: null, usCitizenOnly: null };
  if (s.sponsorship === 'no') return { tag: 'post_says_no', reason: 'post_no_sponsorship', label: 'The post says it does not sponsor visas' };
  if (s.usCitizenOnly === true) return { tag: 'post_says_no', reason: 'post_us_citizen_only', label: 'The post says US citizenship is required' };
  if (s.clearanceRequired === true) return { tag: 'post_says_no', reason: 'post_clearance_required', label: 'The post says a security clearance is required' };
  if (s.sponsorship === 'yes') return { tag: 'post_says_yes', reason: 'post_offers_sponsorship', label: 'Visa sponsorship stated in the post' };
  if (summary?.status === 'likely') return { tag: 'likely_by_history', reason: 'filing_history', label: 'H-1B sponsor likely (past filings)' };
  return { tag: null, reason: null, label: null };
}

/** The H-1B filter keeps exactly the jobs whose tag is positive. */
export function passesH1bFilter(tag: H1bTag | null | undefined): boolean {
  return tag === 'likely_by_history' || tag === 'post_says_yes';
}
