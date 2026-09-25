// RawJob (what an adapter read) -> Job (what the store keeps). No IT-only gate anywhere in this file.
import { annualize, htmlToText, isRemoteText, isUsLocation, levelFromDescription, levelFromTitle, parsePayFromText } from '@jobleft/parsers';
import { canonicalizeUrl, cleanText, contentHash, dedupHash, normalizeCompany } from './normalize.ts';
import type { BoardRef, Job, RawJob } from './types.ts';

/** Returns null when the posting cannot be persisted (no id, no title or no usable URL). */
export function normalizeJob(board: BoardRef, raw: RawJob): Job | null {
  const title = cleanText(raw.title);
  const jobId = String(raw.externalId ?? '').trim();
  if (!jobId || !title) return null;
  const canonicalUrl = canonicalizeUrl(raw.url || raw.applyUrl);
  if (!canonicalUrl) return null;
  const applyUrl = (raw.applyUrl || raw.url).trim();
  const company = cleanText(raw.company) || board.company;
  const location = cleanText(raw.location);
  const description = htmlToText(raw.descriptionHtml);

  let level = levelFromTitle(title);
  let levelSource: Job['levelSource'] = level ? 'title' : null;
  if (!level) {
    level = levelFromDescription(description);
    levelSource = level ? 'description' : null;
  }

  let payMin: number | null = null, payMax: number | null = null;
  let payCurrency: string | null = null;
  let payPeriod: Job['payPeriod'] = null;
  let paySource: Job['paySource'] = null;
  if (raw.pay) {
    ({ min: payMin, max: payMax, currency: payCurrency, period: payPeriod } = raw.pay);
    paySource = 'api';
  } else {
    const p = parsePayFromText(description);
    if (p) {
      payMin = p.min; payMax = p.max; payCurrency = p.currency; payPeriod = p.period;
      paySource = 'text';
    }
  }

  const remote = raw.remote || raw.workMode === 'remote' || isRemoteText(location);
  const job: Job = {
    ats: board.ats,
    board: board.board,
    jobId,
    applyUrl,
    canonicalUrl,
    dedupHash: dedupHash(company, title),
    title,
    company,
    companySlug: normalizeCompany(company),
    location,
    remote,
    workMode: raw.workMode,
    isUs: isUsLocation(location, raw.countries),
    level,
    levelSource,
    payMin, payMax, payCurrency, payPeriod,
    payMinAnnual: payPeriod ? annualize(payMin, payPeriod) : null,
    payMaxAnnual: payPeriod ? annualize(payMax, payPeriod) : null,
    paySource,
    postedAt: raw.postedAt,
    employmentType: raw.employmentType,
    department: cleanText(raw.department),
    description,
    contentHash: '',
  };
  job.contentHash = contentHash([
    job.title, job.company, job.location, job.remote, job.workMode, job.level, job.payMin, job.payMax,
    job.payCurrency, job.payPeriod, job.postedAt, job.employmentType, job.department, job.applyUrl, job.description,
  ]);
  return job;
}
