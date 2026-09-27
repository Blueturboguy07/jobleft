// What a posting says about visa sponsorship, read once for the whole detail page (JL-tracker-3). The sponsorship
// chip (h1bTag) says "no" when the posting says it does not sponsor, requires US citizenship, or requires a security
// clearance; the match reads the posting's own sentence too. The "Visa sponsorship" section uses the same facts, so
// it never says "nothing about visa sponsorship" next to a chip that says "no sponsorship".

import type { Job } from '@jobleft/contracts';

export interface PostingSponsorship {
  says: 'yes' | 'no' | null;
  /** Why the posting rules sponsorship out: it says so, or it is open only to US citizens or clearance holders. */
  because: 'sponsorship' | 'citizenship' | 'clearance' | null;
  quote: string | null;
  /** One plain sentence for "What the posting says: ...". */
  text: string;
}

type MatchFacts = { jobFacts?: { sponsorship?: { value: string | null; quote: string | null } } } | null | undefined;

export function postingSponsorship(job: Pick<Job, 'statements' | 'evidence'>, match: MatchFacts): PostingSponsorship {
  const st = job.statements;
  const ev = job.evidence ?? {};
  const read = match?.jobFacts?.sponsorship;
  if (st.sponsorship === 'no' || (!st.sponsorship && read?.value === 'does not sponsor')) {
    return { says: 'no', because: 'sponsorship', quote: st.sponsorship === 'no' ? ev.sponsorship?.text ?? read?.quote ?? null : read?.quote ?? null, text: 'it cannot sponsor a visa for this role.' };
  }
  if (st.sponsorship === 'yes' || (!st.sponsorship && read?.value === 'sponsors')) {
    return { says: 'yes', because: 'sponsorship', quote: st.sponsorship === 'yes' ? ev.sponsorship?.text ?? read?.quote ?? null : read?.quote ?? null, text: 'it offers visa sponsorship.' };
  }
  if (st.usCitizenOnly === true) {
    return { says: 'no', because: 'citizenship', quote: ev.usCitizenOnly?.text ?? null, text: 'it is open only to US citizens, so it will not sponsor a visa.' };
  }
  if (st.clearanceRequired === true) {
    return { says: 'no', because: 'clearance', quote: ev.clearanceRequired?.text ?? null, text: 'it requires a security clearance. Clearances are for US citizens, so the posting rules out visa sponsorship.' };
  }
  return { says: null, because: null, quote: null, text: 'nothing about visa sponsorship.' };
}
