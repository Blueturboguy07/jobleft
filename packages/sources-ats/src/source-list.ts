// The ATS source list: every family jobleft crawls, with evidence that its feed is public, and every family it does
// not crawl, with a reason and the date the reason was checked. Each entry has a note in docs/sources/<file>.md with
// the quotes. The server fills `enabled`, `keySet` and `status` at run time (SourceInfo).

import type { AtsId, SourceInfo } from '@jobleft/contracts';

export type AtsSourceEntry = Omit<SourceInfo, 'enabled' | 'keySet' | 'status'>;

export interface AtsSourceDetail extends AtsSourceEntry {
  /** The ATS family (or null for a job site such as LinkedIn). */
  ats: AtsId | null;
  /** The note in docs/sources/ with the quotes and the field map. */
  docsFile: string;
  /** The line of the vendor's own documentation, robots.txt or terms that the decision rests on. */
  quote: string;
  /** Where the quote comes from (a URL, or the audit that read it). */
  quoteSource: string;
}

const LANE_CHECKED = '2026-09-25';
const AUDIT_CHECKED = '2026-09-24';

export const ATS_SOURCE_DETAILS: ReadonlyArray<AtsSourceDetail> = [
  // ------------------------------------------------------------------ crawled
  {
    id: 'ats:greenhouse', ats: 'greenhouse', name: 'Greenhouse', kind: 'ats', crawled: true, reason: null,
    checkedOn: LANE_CHECKED, evidenceUrl: 'https://docs.greenhouse.io/job-board.html', needsKey: false, credit: null,
    limits: 'At most 1 request per second per host. robots.txt disallows only /embed/ (read 2026-09-24).',
    docsFile: 'docs/sources/greenhouse.md',
    quote: 'Job Board data is publicly available, so authentication is not required for any GET endpoints.',
    quoteSource: 'https://docs.greenhouse.io/job-board.html',
  },
  {
    id: 'ats:lever', ats: 'lever', name: 'Lever', kind: 'ats', crawled: true, reason: null,
    checkedOn: LANE_CHECKED, evidenceUrl: 'https://github.com/lever/postings-api', needsKey: false, credit: null,
    limits: 'robots.txt asks for Crawl-delay: 1 (api.lever.co, read 2026-09-24); jobleft sends at most 1 request per second per host. EU boards use api.eu.lever.co.',
    docsFile: 'docs/sources/lever.md',
    quote: 'Note that all job postings in the `published` state are publicly viewable.',
    quoteSource: 'https://github.com/lever/postings-api (README)',
  },
  {
    id: 'ats:ashby', ats: 'ashby', name: 'Ashby', kind: 'ats', crawled: true, reason: null,
    checkedOn: LANE_CHECKED, evidenceUrl: 'https://developers.ashbyhq.com/docs/public-job-posting-api', needsKey: false, credit: null,
    limits: 'No published rate limit; jobleft sends at most 1 request per second per host.',
    docsFile: 'docs/sources/ashby.md',
    quote: 'This API allows you to get data for all currently published Job Postings for your organization.',
    quoteSource: 'https://developers.ashbyhq.com/docs/public-job-posting-api',
  },
  {
    id: 'ats:workable', ats: 'workable', name: 'Workable', kind: 'ats', crawled: true, reason: null,
    checkedOn: LANE_CHECKED,
    evidenceUrl: 'https://help.workable.com/hc/en-us/articles/115012771647-Using-the-Workable-API-to-create-a-careers-page',
    needsKey: false, credit: null,
    limits: 'robots.txt (apply.workable.com) says "Content-Signal: search=yes, ai-input=yes, ai-train=no": jobleft never trains a model on these jobs. At most 1 request per second.',
    docsFile: 'docs/sources/workable.md',
    quote: "Alternatively, to get the list of your published jobs only, you can try in your terminal the below public endpoints: curl -L GET 'https://www.workable.com/api/accounts/{subdomain}?details=true'",
    quoteSource: 'https://help.workable.com/hc/en-us/articles/115012771647-Using-the-Workable-API-to-create-a-careers-page',
  },
  {
    id: 'ats:recruitee', ats: 'recruitee', name: 'Recruitee', kind: 'ats', crawled: true, reason: null,
    checkedOn: LANE_CHECKED, evidenceUrl: 'https://docs.recruitee.com/reference/offers', needsKey: false, credit: null,
    limits: 'Recruitee announced that the Careers Site API needs a token from 10 February 2027; after that date a board fails with that reason. At most 1 request per second per host.',
    docsFile: 'docs/sources/recruitee.md',
    quote: 'Returns a collection of published company jobs. (OpenAPI "security": [{}], server https://{yourcompany}.recruitee.com/api)',
    quoteSource: 'https://docs.recruitee.com/reference/offers',
  },
  {
    id: 'ats:personio', ats: 'personio', name: 'Personio', kind: 'ats', crawled: true, reason: null,
    checkedOn: LANE_CHECKED, evidenceUrl: 'https://developer.personio.de/docs/retrieving-open-job-positions', needsKey: false, credit: null,
    limits: 'The employer must switch the XML feed on. Boards live on <company>.jobs.personio.de or .com. At most 1 request per second per host.',
    docsFile: 'docs/sources/personio.md',
    quote: 'Current open job postings can be retrieved in XML format under myaccount.jobs.personio.de/xml.',
    quoteSource: 'https://developer.personio.de/docs/retrieving-open-job-positions',
  },
  {
    id: 'ats:teamtailor', ats: 'teamtailor', name: 'Teamtailor', kind: 'ats', crawled: true, reason: null,
    checkedOn: LANE_CHECKED, evidenceUrl: 'https://support.teamtailor.com/en/articles/11171756-rss-feed-how-to-guide', needsKey: false, credit: null,
    limits: 'robots.txt (career.teamtailor.com) says "Content-Signal: search=yes, ai-train=no, ai-input=yes": jobleft never trains a model on these jobs. 100 jobs per page; every page is read. North America boards use <company>.na.teamtailor.com.',
    docsFile: 'docs/sources/teamtailor.md',
    quote: 'Go to the main jobs page of your careers site and add ".rss" ... Note that all of the data is publicly available.',
    quoteSource: 'https://support.teamtailor.com/en/articles/11171756-rss-feed-how-to-guide',
  },
  {
    id: 'ats:gem', ats: 'gem', name: 'Gem', kind: 'ats', crawled: true, reason: null,
    checkedOn: LANE_CHECKED, evidenceUrl: 'https://api.gem.com/job_board/v0/reference', needsKey: false, credit: null,
    limits: 'Gem allows 20 requests per second per API key; jobleft sends at most 1 per second and uses no key.',
    docsFile: 'docs/sources/gem.md',
    quote: "Most endpoints in the Job Board API are public and do not require authentication — job board information can be read by anyone using your job board's vanity URL path.",
    quoteSource: 'https://api.gem.com/job_board/v0/openapi.json (the reference page loads it)',
  },
  // ------------------------------------------------------------------ not crawled (lane review)
  {
    id: 'ats:bamboohr', ats: 'bamboohr', name: 'BambooHR', kind: 'ats', crawled: false,
    reason: 'No documented public feed: every job endpoint in the BambooHR API documentation needs an authenticated caller, and the JSON behind its careers page is not documented.',
    checkedOn: LANE_CHECKED, evidenceUrl: 'https://documentation.bamboohr.com/reference/get-job-summaries', needsKey: true, credit: null, limits: null,
    docsFile: 'docs/sources/bamboohr.md',
    quote: 'Get Job Summaries: Get a list of job opening summaries. The authenticated caller must have access to ATS settings.',
    quoteSource: 'https://documentation.bamboohr.com/llms.txt',
  },
  {
    id: 'ats:breezy', ats: 'breezy', name: 'Breezy HR', kind: 'ats', crawled: false,
    reason: 'No documented public feed: the Breezy API needs a sign-in token, and the Breezy help centre documents no public job feed (a search for "json" finds no article).',
    checkedOn: LANE_CHECKED, evidenceUrl: 'https://developer.breezy.hr/', needsKey: true, credit: null, limits: null,
    docsFile: 'docs/sources/breezy.md',
    quote: 'We couldn\'t find any articles for: json',
    quoteSource: 'https://help.breezy.hr/en/?q=json',
  },
  {
    id: 'ats:jazzhr', ats: 'jazzhr', name: 'JazzHR', kind: 'ats', crawled: false,
    reason: 'No documented public feed: the JazzHR API documentation lists partner and customer APIs that need a key, and no keyless job feed.',
    checkedOn: LANE_CHECKED, evidenceUrl: 'https://apidoc.jazzhrapis.com/', needsKey: true, credit: null, limits: null,
    docsFile: 'docs/sources/jazzhr.md',
    quote: 'Apply API: Allows partners to send applications to JazzHR through a RESTful interface.',
    quoteSource: 'https://apidoc.jazzhrapis.com/',
  },
  {
    id: 'ats:rippling', ats: 'rippling', name: 'Rippling', kind: 'ats', crawled: false,
    reason: 'Terms not verified, so the owner must approve it: Rippling documents a job-board API, but says access to its APIs is governed by Developer Terms that open only inside its web app. The documented list also has no job text and no posted date.',
    checkedOn: LANE_CHECKED, evidenceUrl: 'https://developer.rippling.com/documentation/job-board-api', needsKey: false, credit: null,
    limits: 'Rippling states "Rate Limit: 100 requests every 10 minutes".',
    docsFile: 'docs/sources/rippling.md',
    quote: 'By using the Rippling development platform you acknowledge and agree that access to the Rippling APIs and app submissions for App Shop review are governed by the Rippling Developer Terms of Use.',
    quoteSource: 'https://developer.rippling.com/documentation/developer-portal/legal/terms',
  },
  {
    id: 'ats:jobvite', ats: 'jobvite', name: 'Jobvite', kind: 'ats', crawled: false,
    reason: 'The owner has not approved it: no public feed has been reviewed for Jobvite yet.',
    checkedOn: LANE_CHECKED, evidenceUrl: null, needsKey: false, credit: null, limits: null,
    docsFile: 'docs/sources/not-crawled.md',
    quote: 'Not reviewed by this lane (not in the lane list).',
    quoteSource: 'docs/sources/not-crawled.md',
  },
  // ------------------------------------------------------------------ never or held back (plan section 6)
  {
    id: 'ats:smartrecruiters', ats: 'smartrecruiters', name: 'SmartRecruiters', kind: 'ats', crawled: false,
    reason: 'robots.txt disallows the feed: api.smartrecruiters.com/robots.txt says "User-agent: * Disallow: /" (read 2026-09-24 by audit 05). The plan says never.',
    checkedOn: AUDIT_CHECKED, evidenceUrl: 'https://api.smartrecruiters.com/robots.txt', needsKey: false, credit: null, limits: null,
    docsFile: 'docs/sources/smartrecruiters.md',
    quote: 'User-agent: * Disallow: /',
    quoteSource: 'audit 05 section 1.2 (read 2026-09-24); jobleft sends no request to check it again',
  },
  {
    id: 'ats:workday', ats: 'workday', name: 'Workday', kind: 'ats', crawled: false,
    reason: 'The owner has not approved it: the Workday CXS endpoint is not a documented public API (audit 05, 2026-09-24), and the plan holds it back.',
    checkedOn: AUDIT_CHECKED, evidenceUrl: null, needsKey: false, credit: null, limits: null,
    docsFile: 'docs/sources/workday.md',
    quote: 'Not a documented API.',
    quoteSource: 'audit 05 section 1.2 (2026-09-24); plan section 6 "Ask you before any Workday crawl"',
  },
  {
    id: 'ats:icims', ats: 'icims', name: 'iCIMS', kind: 'ats', crawled: false,
    reason: 'No documented public feed (sitemaps and HTML pages only) and the owner has not approved it.',
    checkedOn: AUDIT_CHECKED, evidenceUrl: null, needsKey: false, credit: null, limits: null,
    docsFile: 'docs/sources/icims.md',
    quote: 'No JSON API. HTML parsing is fragile.',
    quoteSource: 'audit 05 section 1.2 (2026-09-24)',
  },
  {
    id: 'ats:oracle', ats: 'oracle', name: 'Oracle Recruiting', kind: 'ats', crawled: false,
    reason: 'The owner has not approved it; no public feed has been verified (audit 05 marks it UNVERIFIED, 2026-09-24).',
    checkedOn: AUDIT_CHECKED, evidenceUrl: null, needsKey: false, credit: null, limits: null,
    docsFile: 'docs/sources/oracle.md',
    quote: 'Oracle, UKG and Paycom: UNVERIFIED by me. Legal risk is higher for all of them.',
    quoteSource: 'audit 05 section 1.1 (2026-09-24)',
  },
  {
    id: 'ats:ukg', ats: 'ukg', name: 'UKG', kind: 'ats', crawled: false,
    reason: 'The owner has not approved it; no public feed has been verified (audit 05 marks it UNVERIFIED, 2026-09-24).',
    checkedOn: AUDIT_CHECKED, evidenceUrl: null, needsKey: false, credit: null, limits: null,
    docsFile: 'docs/sources/ukg.md',
    quote: 'Oracle, UKG and Paycom: UNVERIFIED by me. Legal risk is higher for all of them.',
    quoteSource: 'audit 05 section 1.1 (2026-09-24)',
  },
  {
    id: 'ats:taleo', ats: 'taleo', name: 'Taleo', kind: 'ats', crawled: false,
    reason: 'The owner has not approved it; no public feed has been verified (audit 05, 2026-09-24).',
    checkedOn: AUDIT_CHECKED, evidenceUrl: null, needsKey: false, credit: null, limits: null,
    docsFile: 'docs/sources/taleo.md',
    quote: 'Pinpoint, Jobvite, Comeet, Join, Paylocity, Paycom, UKG, Oracle Recruiting, SuccessFactors, Eightfold, Phenom, Taleo, Avature, ADP: UNVERIFIED by me.',
    quoteSource: 'audit 05 section 1.2 (2026-09-24)',
  },
  {
    id: 'site:linkedin', ats: null, name: 'LinkedIn', kind: 'job_board', crawled: false,
    reason: 'Terms forbid automated access: the LinkedIn User Agreement (8.2) bans software, scripts or robots that scrape the Services. The plan says never.',
    checkedOn: AUDIT_CHECKED, evidenceUrl: 'https://www.linkedin.com/legal/user-agreement', needsKey: false, credit: null, limits: null,
    docsFile: 'docs/sources/never-crawled-sites.md',
    quote: 'software, devices, scripts, robots or any other means ... to scrape or copy the Services',
    quoteSource: 'audit 05 section 1.8 (read 2026-09-24); jobleft sends no request to LinkedIn',
  },
  {
    id: 'site:indeed', ats: null, name: 'Indeed', kind: 'job_board', crawled: false,
    reason: 'Terms forbid automation (Indeed bans automating its apply flow outside official tooling, section A.3.5), and the plan says never.',
    checkedOn: AUDIT_CHECKED, evidenceUrl: 'https://www.indeed.com/legal', needsKey: false, credit: null, limits: null,
    docsFile: 'docs/sources/never-crawled-sites.md',
    quote: 'Terms ban automation of the Indeed Apply flow outside official tooling (section A.3.5).',
    quoteSource: 'audit 05 section 1.8 (read 2026-09-24); jobleft sends no request to Indeed',
  },
  {
    id: 'site:glassdoor', ats: null, name: 'Glassdoor', kind: 'job_board', crawled: false,
    reason: 'The plan says never. Its terms page answered HTTP 403 to the audit, so no permission could be read.',
    checkedOn: AUDIT_CHECKED, evidenceUrl: 'https://www.glassdoor.com/about/terms/', needsKey: false, credit: null, limits: null,
    docsFile: 'docs/sources/never-crawled-sites.md',
    quote: 'Terms page returned HTTP 403 to my fetch. UNVERIFIED',
    quoteSource: 'audit 05 section 1.8 (2026-09-24); jobleft sends no request to Glassdoor',
  },
];

/**
 * The ATS source list: every family jobleft crawls (with evidence that the feed is public) and every family it does
 * not (with a reason and the date the reason was checked). Status fields are filled by the server at run time.
 */
export const ATS_SOURCE_LIST: ReadonlyArray<Omit<SourceInfo, 'enabled' | 'keySet' | 'status'>> = ATS_SOURCE_DETAILS.map(
  ({ id, name, kind, crawled, reason, checkedOn, evidenceUrl, needsKey, credit, limits }) =>
    ({ id, name, kind, crawled, reason, checkedOn, evidenceUrl, needsKey, credit, limits }),
);

/** The reason a recognised ATS family is not crawled, or null when it is crawled or unknown. */
export function notCrawledReason(ats: AtsId): string | null {
  const e = ATS_SOURCE_DETAILS.find((d) => d.ats === ats);
  return e && !e.crawled ? e.reason : null;
}
