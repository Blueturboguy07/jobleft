// @jobleft/sources-ats: ATS adapters beyond the crawler's built-ins (Greenhouse, Lever, Ashby), the ATS source
// list (crawled or not, why, checked when), and ATS detection from any URL.
// Built: Workable, Recruitee, Personio, Teamtailor and Gem. Reviewed and NOT built: BambooHR, Breezy, JazzHR (no
// documented public feed) and Rippling (terms not verifiable). Never: SmartRecruiters, LinkedIn, Indeed, Glassdoor.
// Never without the owner's approval: Workday, iCIMS, Oracle, UKG, Taleo.
// Interface: docs/INTERFACES.md, section "@jobleft/sources-ats". Evidence per source: docs/sources/<ats>.md.

export const PACKAGE_NAME = '@jobleft/sources-ats';

// Registry
export { ATS_SOURCES, allSources, BUILTIN_SOURCES, crawledAtsIds } from './registry.ts';
export { ashbyOverallPay, greenhouseUrlFor, GREENHOUSE_EU_HOST } from './adapters/builtins.ts';
export { parseEuropeanPay } from './pay-text.ts';
export { cleanDescription, descriptionText, statedPay, textField } from './util.ts';
export { decodeEntitiesFull, stripControls } from './entities.ts';
export { polishRaw, polishSource } from './polish.ts';

// Detection from a URL (pure string work, sends nothing)
export { atsName, classifyUrl, detectAts, neverContactHost } from './detect.ts';
export type { AtsDetection, UrlClassification, UrlVerdict } from './detect.ts';

// Hosts
export { atsHost, boardHost, normalRegion, SUBDOMAIN_FAMILIES } from './hosts.ts';

// Source list
export { ATS_SOURCE_DETAILS, ATS_SOURCE_LIST, notCrawledReason } from './source-list.ts';
export type { AtsSourceDetail, AtsSourceEntry } from './source-list.ts';

// Adapters and their pure mappers (for tests and tools)
export { gem, gemUrl, mapGem } from './adapters/gem.ts';
export { mapPersonio, personio, personioBody, personioUrl } from './adapters/personio.ts';
export { mapRecruitee, recruitee, recruiteePay, recruiteeUrl } from './adapters/recruitee.ts';
export {
  mapTeamtailorItem, teamtailor, TEAMTAILOR_MAX_PAGES, TEAMTAILOR_PAGE_SIZE, teamtailorJobId, teamtailorPageUrl,
} from './adapters/teamtailor.ts';
export { mapWorkable, workable, workableUrl } from './adapters/workable.ts';

// Errors (the crawl report shows `${name}: ${message}`)
export { BoardTokenError, FeedFormatError, PagingError, SourceChangedError } from './errors.ts';

// XML reader used by the Personio and Teamtailor adapters
export { child, childText, children, decodeXmlEntities, parseXml, text } from './xml.ts';
export type { XmlElement, XmlNode } from './xml.ts';

// Crawl support for the CLI and the server: plain reasons, polite fetch, health report
export { plainReason } from './report.ts';
export { buildHealthReport } from './report.ts';
export type { AtsHealth, BoardHealth, HealthReport } from './report.ts';
export { politeFetch } from './polite-fetch.ts';
export type { PoliteFetchOptions } from './polite-fetch.ts';
