// Host policy for every board action (paste, directory load, refresh, re-check).
//
//   * FORBIDDEN hosts get no request, ever: LinkedIn, Indeed, Glassdoor, SmartRecruiters, and the providers the plan
//     holds back until the owner approves them (Workday, iCIMS, Oracle, UKG, Taleo). The crawler's own deny-list
//     (packages/crawler/src/http.ts) covers part of this; this list is the superset the boards lane enforces itself,
//     before any request and again inside the fetch wrapper (src/http.ts), so a redirect cannot reach them either.
//   * UNSUPPORTED providers are recognised so the person gets a plain "not supported" instead of a guess.
//   * JOB SITES (aggregators) are not an employer's board; jobleft does not read boards from them.

/** One forbidden family: the name shown to the person and the registrable domains it owns. */
interface HostFamily { name: string; domains: RegExp }

const FORBIDDEN: HostFamily[] = [
  { name: 'LinkedIn', domains: /(^|\.)(linkedin\.com|licdn\.com|lnkd\.in)$/ },
  // Indeed and Glassdoor run country sites on many top-level domains (indeed.co.uk, glassdoor.ca, ...).
  { name: 'Indeed', domains: /(^|\.)indeed(jobs)?\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/ },
  { name: 'Glassdoor', domains: /(^|\.)glassdoor\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/ },
  { name: 'SmartRecruiters', domains: /(^|\.)(smartrecruiters\.com|smrtr\.io)$/ },
  { name: 'Workday', domains: /(^|\.)(myworkdayjobs\.com|myworkdaysite\.com|workday\.com|workdayjobs\.com)$/ },
  { name: 'iCIMS', domains: /(^|\.)icims\.com$/ },
  { name: 'Oracle', domains: /(^|\.)(oraclecloud\.com|oracle\.com)$/ },
  { name: 'Taleo', domains: /(^|\.)taleo\.net$/ },
  { name: 'UKG', domains: /(^|\.)(ultipro\.com|ukg\.com|ukg\.net|ukgpro\.com)$/ },
];

const UNSUPPORTED: HostFamily[] = [
  { name: 'BambooHR', domains: /(^|\.)bamboohr\.com$/ },
  { name: 'Jobvite', domains: /(^|\.)jobvite\.com$/ },
  { name: 'Teamtailor', domains: /(^|\.)teamtailor\.com$/ },
  { name: 'Breezy HR', domains: /(^|\.)breezy\.hr$/ },
  { name: 'JazzHR', domains: /(^|\.)(applytojob\.com|jazzhr\.com)$/ },
  { name: 'Rippling', domains: /(^|\.)(rippling\.com|rippling-ats\.com)$/ },
  { name: 'Gem', domains: /^jobs\.gem\.com$/ },
  { name: 'Pinpoint', domains: /(^|\.)pinpointhq\.com$/ },
  { name: 'Paylocity', domains: /(^|\.)paylocity\.com$/ },
  { name: 'Paycom', domains: /(^|\.)(paycomonline\.net|paycomonline\.com)$/ },
  { name: 'ADP', domains: /(^|\.)(adp\.com)$/ },
  { name: 'SAP SuccessFactors', domains: /(^|\.)(successfactors\.com|successfactors\.eu|sapsf\.com|sapsf\.eu)$/ },
  { name: 'Eightfold', domains: /(^|\.)eightfold\.ai$/ },
  { name: 'Phenom', domains: /(^|\.)phenompeople\.com$/ },
  { name: 'Avature', domains: /(^|\.)avature\.net$/ },
  { name: 'Dayforce', domains: /(^|\.)dayforcehcm\.com$/ },
  { name: 'Comeet', domains: /(^|\.)comeet\.(com|co)$/ },
  { name: 'JOIN', domains: /(^|\.)join\.com$/ },
  { name: 'Homerun', domains: /(^|\.)homerun\.co$/ },
  { name: 'Polymer', domains: /(^|\.)polymer\.co$/ },
  { name: 'Dover', domains: /(^|\.)dover\.(com|io)$/ },
  { name: 'Freshteam', domains: /(^|\.)freshteam\.com$/ },
  { name: 'Zoho Recruit', domains: /(^|\.)zohorecruit\.(com|eu|in)$/ },
  { name: 'Workable job search', domains: /^jobs\.workable\.com$/ },
];

const JOB_SITES: HostFamily[] = [
  { name: 'ZipRecruiter', domains: /(^|\.)ziprecruiter\.(com|co\.uk|ca)$/ },
  { name: 'Monster', domains: /(^|\.)monster\.(com|[a-z]{2}|co\.uk)$/ },
  { name: 'CareerBuilder', domains: /(^|\.)careerbuilder\.com$/ },
  { name: 'SimplyHired', domains: /(^|\.)simplyhired\.com$/ },
  { name: 'Dice', domains: /(^|\.)dice\.com$/ },
  { name: 'Built In', domains: /(^|\.)builtin\.com$/ },
  { name: 'Wellfound', domains: /(^|\.)(wellfound\.com|angel\.co)$/ },
  { name: 'Y Combinator', domains: /(^|\.)(ycombinator\.com|workatastartup\.com)$/ },
  { name: 'Handshake', domains: /(^|\.)joinhandshake\.com$/ },
  { name: 'USAJOBS', domains: /(^|\.)usajobs\.gov$/ },
  { name: 'Google', domains: /(^|\.)google\.com$/ },
];

function familyOf(list: HostFamily[], hostname: string): string | null {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  for (const f of list) if (f.domains.test(h)) return f.name;
  return null;
}

/** The forbidden provider a host belongs to, or null. Never send a request to a host that returns non-null. */
export function forbiddenProvider(hostname: string): string | null { return familyOf(FORBIDDEN, hostname); }
/** A job-board provider jobleft recognises but cannot read, or null. */
export function unsupportedProvider(hostname: string): string | null { return familyOf(UNSUPPORTED, hostname); }
/** A job search site (not one employer's board), or null. */
export function jobSite(hostname: string): string | null { return familyOf(JOB_SITES, hostname); }

/** true for a host that is on the forbidden list. */
export function isForbiddenHost(hostname: string): boolean { return forbiddenProvider(hostname) !== null; }

/** Loopback hosts (local test servers). */
export function isLoopbackHost(hostname: string): boolean {
  return /^(127\.\d+\.\d+\.\d+|localhost|\[::1\]|::1)$/i.test(hostname);
}

/** A literal IP address (v4 or v6), so there is no domain to compare a board name with. */
export function isIpHost(hostname: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.startsWith('[') || hostname.includes(':');
}
