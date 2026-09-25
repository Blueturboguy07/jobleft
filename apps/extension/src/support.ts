// Where the extension works. Decided from the page address first (no page read at all), then, only after the
// person clicks the jobleft button, from a few markers in the page (never its text).

import type { AtsId } from '@jobleft/contracts';

export type SupportLevel = 'supported' | 'partial' | 'not_supported' | 'never' | 'not_a_page';

export interface SupportInfo {
  level: SupportLevel;
  /** The system, when known. */
  ats: AtsId | null;
  /** The system's name in words ("Greenhouse"). */
  name: string | null;
  /** One plain sentence for the popup. */
  message: string;
}

/**
 * Hosts where the extension never reads, fills or adds anything: LinkedIn, Indeed and Glassdoor, with every country
 * domain and subdomain (uk.linkedin.com, indeed.co.uk, glassdoor.de, de.indeed.com), and their short and media hosts.
 */
export function isNeverHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  const labels = h.split('.');
  if (labels.some((l) => l === 'linkedin' || l === 'indeed' || l === 'glassdoor' || l === 'glassdoor-inc')) return true;
  return /(^|\.)(lnkd\.in|licdn\.com|indeedjobs\.com|indeed-static\.com|glassdoor\.[a-z.]+)$/.test(h);
}

export const ATS_NAMES: Readonly<Partial<Record<AtsId, string>>> = {
  greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', workable: 'Workable', workday: 'Workday', icims: 'iCIMS',
};

/**
 * Support levels (O13). Supported = tested on saved real pages and hand-made forms. Workday is partial: one visible
 * step at a time, no work or education rows added, never "Next". iCIMS is partial: its forms were not available
 * to test (no live iCIMS requests were allowed), so jobleft uses its general mode there.
 */
export const SUPPORT: Readonly<Partial<Record<AtsId, 'supported' | 'partial'>>> = {
  greenhouse: 'supported', lever: 'supported', ashby: 'supported', workable: 'supported', icims: 'partial', workday: 'partial',
};

const PARTIAL_WHY: Readonly<Partial<Record<AtsId, string>>> = {
  workday: 'Workday support is partial: jobleft fills the step you can see, does not add work or education rows, and never presses Next or Save.',
  icims: 'iCIMS support is partial: jobleft uses its general mode here and was not tested on iCIMS forms.',
};

/** The ATS a page address belongs to, or null. Pure string work. */
export function atsFromUrl(url: URL): AtsId | null {
  const h = url.hostname.toLowerCase();
  if (/(^|\.)greenhouse\.io$/.test(h) || url.searchParams.has('gh_jid')) return 'greenhouse';
  if (/(^|\.)lever\.co$/.test(h)) return 'lever';
  if (/(^|\.)ashbyhq\.com$/.test(h) || url.searchParams.has('ashby_jid')) return 'ashby';
  if (/(^|\.)workable\.com$/.test(h)) return 'workable';
  if (/(^|\.)(myworkdayjobs\.com|myworkdaysite\.com|myworkday\.com|workday\.com)$/.test(h)) return 'workday';
  if (/(^|\.)icims\.com$/.test(h)) return 'icims';
  return null;
}

export function supportFor(ats: AtsId | null, how: 'address' | 'page' = 'address'): SupportInfo {
  if (!ats) {
    return {
      level: 'not_supported', ats: null, name: null,
      message: 'This site is not on the supported list. jobleft can still try, and you must check every field.',
    };
  }
  const name = ATS_NAMES[ats] ?? ats;
  const level = SUPPORT[ats];
  if (level === 'supported') {
    return { level, ats, name, message: how === 'page' ? `${name} form (found in the page): supported.` : `${name}: supported.` };
  }
  if (level === 'partial') return { level, ats, name, message: PARTIAL_WHY[ats] ?? `${name}: partial support.` };
  return { level: 'not_supported', ats, name, message: `${name} is not on the supported list. jobleft can still try, and you must check every field.` };
}

/** The first answer, from the address alone. */
export function supportFromUrl(raw: string | null | undefined): SupportInfo {
  let url: URL;
  try {
    url = new URL(raw ?? '');
  } catch {
    return { level: 'not_a_page', ats: null, name: null, message: 'jobleft works only on web pages.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { level: 'not_a_page', ats: null, name: null, message: 'jobleft works only on web pages (http and https).' };
  }
  if (isNeverHost(url.hostname)) {
    return {
      level: 'never', ats: null, name: null,
      message: 'jobleft does not work on LinkedIn, Indeed or Glassdoor. It reads and fills nothing here.',
    };
  }
  return supportFor(atsFromUrl(url));
}
