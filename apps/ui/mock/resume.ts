// The mock's resume steps (the real ones are @jobleft/resume): import a PDF or Word file into a document and a
// proposed profile (only facts the file states), build a resume from the profile, export, check one-page fit,
// grade readability, and keyword gaps. Nothing here invents a fact.

import type {
  AtsReport, ImportReport, Job, KeywordGapReport, Profile, ProfileInput, ResumeDocument, ResumeItem, ResumeSection,
} from '@jobleft/contracts';
import { resolveCity } from './cities.ts';
import { docxText, makeDocx, makePdf, pdfText, type PdfLine } from './docs.ts';
import { SKILLS } from './fixtures.ts';
import { skillsIn } from './jobs.ts';
import { newId, sha256 } from './util.ts';

export const MAX_RESUME_BYTES = 10 * 1_048_576;

const HEADINGS: Record<string, ResumeSection['kind']> = {
  summary: 'summary', profile: 'summary', 'professional summary': 'summary', about: 'summary',
  experience: 'experience', 'work experience': 'experience', employment: 'experience', 'professional experience': 'experience',
  education: 'education', skills: 'skills', 'technical skills': 'skills', projects: 'projects', certifications: 'certifications',
};

const MONTHS: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

function ym(text: string): string | null {
  const t = text.trim().toLowerCase();
  let m = /^(\d{4})-(\d{2})$/.exec(t);
  if (m) return `${m[1]}-${m[2]}`;
  m = /^([a-z]{3})[a-z]*\.?\s+(\d{4})$/.exec(t);
  if (m && MONTHS[m[1]!]) return `${m[2]}-${MONTHS[m[1]!]}`;
  m = /^(\d{4})$/.exec(t);
  if (m) return m[1]!;
  return null;
}

function dateRange(line: string): { start: string | null; end: string | null; current: boolean } | null {
  const m = /^(.+?)\s*(?:-|–|—|to|->)\s*(.+)$/.exec(line.trim());
  if (!m) return null;
  const start = ym(m[1]!);
  const endText = m[2]!.trim();
  const current = /^(present|current|now)$/i.test(endText);
  const end = current ? null : ym(endText);
  if (!start || (!current && !end)) return null;
  return { start, end, current };
}

export interface Imported {
  document: ResumeDocument;
  report: ImportReport;
  proposedProfile: ProfileInput;
}

export function emptyProfileInput(): ProfileInput {
  return {
    personal: { firstName: null, middleName: null, lastName: null, email: null, phone: null, addressLine: null, city: null, region: null, postalCode: null, country: null, links: [] },
    summary: null, education: [], work: [], projects: [], certifications: [], skills: [],
    preferences: { jobFunctions: [], targetTitles: [], employmentTypes: [], workModels: [], levels: [], countries: [], places: [], minAnnualPayUsd: null, industries: [], companyStages: [], roleTypes: [], excludedCompanies: [] },
    workAuthorization: { usAuthorized: null, needsSponsorship: null, usCitizen: null, hasSecurityClearance: null, authorizedCountries: [] },
    eeo: { disability: null, veteran: null, gender: null, lgbtq: null, race: null, hispanicOrLatino: null, sexualOrientation: [], pronouns: null },
  };
}

function failed(failure: ImportReport['failure'], warning: string): Imported {
  return {
    document: { header: { name: '', email: null, phone: null, city: null, links: [] }, sections: [] },
    report: { counts: { jobs: 0, bullets: 0, skills: 0, education: 0 }, unreadSections: [], warnings: [warning], outcome: 'failed', failure },
    proposedProfile: emptyProfileInput(),
  };
}

/** Reads a resume file. The proposed profile holds only what the file states; the person confirms it. */
export function importResumeBytes(bytes: Uint8Array, fileName: string, mime: string, base: ProfileInput | null): Imported {
  if (bytes.length === 0) return failed('empty_file', 'The file is empty.');
  if (bytes.length > MAX_RESUME_BYTES) return failed('too_large', 'The file is larger than 10 MB.');
  let lines: string[] | null = null;
  if (mime === 'application/pdf' || /\.pdf$/i.test(fileName)) {
    if (Buffer.from(bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') return failed('corrupt', 'The file does not look like a PDF.');
    const t = pdfText(bytes);
    if (t.encrypted) return failed('password_protected', 'The PDF is protected with a password.');
    lines = t.lines;
    if (!lines.length) return failed('image_only', 'jobleft found no text in this PDF. It may be a scanned image. Try a Word file or a PDF with selectable text.');
  } else if (/wordprocessingml/.test(mime) || /\.docx$/i.test(fileName)) {
    lines = docxText(bytes);
    if (!lines) return failed('corrupt', 'The Word file could not be opened.');
    if (!lines.length) return failed('empty_file', 'The Word file has no text.');
  } else {
    return failed('unsupported_type', 'Use a PDF or a Word (.docx) file.');
  }

  const warnings: string[] = [];
  const unread: string[] = [];
  const header = { name: '', email: null as string | null, phone: null as string | null, city: null as string | null, links: [] as Array<{ label: string; url: string }> };
  const sections: ResumeSection[] = [];
  let cur: ResumeSection | null = null;
  let item: ResumeItem | null = null;
  let skipping = false;
  let i = 0;
  // header: lines before the first known heading
  for (; i < lines.length; i++) {
    const l = lines[i]!;
    if (HEADINGS[l.toLowerCase().replace(/:$/, '')]) break;
    if (!header.name && /^[\p{L}'. -]{3,60}$/u.test(l) && l.split(/\s+/).length <= 5) { header.name = l; continue; }
    for (const part of l.split(/\s*[|·•]\s*/)) {
      const email = /[\w.+-]+@[\w-]+(\.[\w-]+)+/.exec(part);
      if (email && !header.email) { header.email = email[0]; continue; }
      const phone = /\+?\d[\d ().-]{6,}\d/.exec(part);
      if (phone && !header.phone) { header.phone = phone[0].trim(); continue; }
      const url = /https?:\/\/\S+/.exec(part);
      if (url) { header.links.push({ label: new URL(url[0]).hostname, url: url[0] }); continue; }
      if (!header.city && resolveCity(part).length) header.city = part.trim();
    }
  }
  for (; i < lines.length; i++) {
    const l: string = lines[i]!;
    const key = l.toLowerCase().replace(/:$/, '');
    if (HEADINGS[key] !== undefined) {
      cur = { id: newId('sec'), kind: HEADINGS[key]!, title: l.replace(/:$/, ''), text: null, items: [] };
      sections.push(cur);
      item = null;
      skipping = false;
      continue;
    }
    if (/^[A-Z][A-Z &]{3,}$/.test(l) && !HEADINGS[key]) {
      unread.push(l);
      skipping = true;
      continue;
    }
    if (skipping || !cur) continue;
    if (cur.kind === 'summary') { cur.text = cur.text ? `${cur.text} ${l}` : l; continue; }
    if (cur.kind === 'skills') {
      const names = l.split(/\s*[,;|•]\s*/).map((s: string) => s.trim()).filter(Boolean);
      if (!cur.items.length) cur.items.push({ id: newId('it'), heading: null, subheading: null, location: null, startDate: null, endDate: null, current: false, bullets: [], tags: [] });
      cur.items[0]!.tags.push(...names);
      continue;
    }
    if (/^[-•*]\s+/.test(l)) {
      if (item) item.bullets.push(l.replace(/^[-•*]\s+/, ''));
      continue;
    }
    const range = dateRange(l);
    if (range && item) { item.startDate = range.start; item.endDate = range.end; item.current = range.current; continue; }
    // a new entry: "Title, Company" / "Company | Title" / "School, Degree in Major"
    const [a, b] = l.split(/\s*[,|—–]\s*/, 2);
    item = { id: newId('it'), heading: (cur.kind === 'experience' ? b ?? a : a) ?? l, subheading: cur.kind === 'experience' ? (b ? a! : null) : b ?? null, location: null, startDate: null, endDate: null, current: false, bullets: [], tags: [] };
    cur.items.push(item);
  }
  if (!header.name) warnings.push('jobleft could not find your name at the top of the file. Add it in your profile.');
  if (!header.email) warnings.push('No email address was found.');
  if (unread.length) warnings.push(`Sections jobleft does not map yet were kept aside: ${unread.join(', ')}.`);

  const exp = sections.filter((s) => s.kind === 'experience').flatMap((s) => s.items);
  const edu = sections.filter((s) => s.kind === 'education').flatMap((s) => s.items);
  const skillNames = [...new Set(sections.filter((s) => s.kind === 'skills').flatMap((s) => s.items.flatMap((x) => x.tags)))];
  const bullets = exp.reduce((n, x) => n + x.bullets.length, 0);

  const p = base ? structuredClone(base) : emptyProfileInput();
  const [first, ...rest] = header.name.split(/\s+/);
  if (header.name) { p.personal.firstName = first ?? null; p.personal.lastName = rest.length ? rest.join(' ') : null; }
  if (header.email) p.personal.email = header.email;
  if (header.phone) p.personal.phone = header.phone;
  if (header.city) {
    const c = resolveCity(header.city)[0];
    if (c) { p.personal.city = c.city; p.personal.region = c.region; p.personal.country = c.country as never; }
  }
  if (header.links.length) p.personal.links = header.links;
  const summary = sections.find((s) => s.kind === 'summary')?.text ?? null;
  if (summary) p.summary = summary;
  if (exp.length) p.work = exp.map((x) => ({ id: newId('w'), company: x.heading ?? '', title: x.subheading ?? '', employmentType: null, location: x.location, startDate: x.startDate, endDate: x.endDate, current: x.current, summary: null, bullets: x.bullets }));
  if (edu.length) p.education = edu.map((x) => {
    const deg = /^(.*?)\s+in\s+(.*)$/.exec(x.subheading ?? '');
    return { id: newId('e'), school: x.heading ?? '', degree: deg ? deg[1]! : x.subheading, major: deg ? deg[2]! : null, gpa: null, startDate: x.startDate, endDate: x.endDate, current: x.current, achievements: x.bullets, coursework: [] };
  });
  if (skillNames.length) p.skills = skillNames.map((name) => ({ name: SKILLS.find((s) => s.toLowerCase() === name.toLowerCase()) ?? name, years: null, source: 'resume' as const }));

  const outcome: ImportReport['outcome'] = unread.length || !header.name ? 'partial' : 'ok';
  return {
    document: { header, sections },
    report: { counts: { jobs: exp.length, bullets, skills: skillNames.length, education: edu.length }, unreadSections: unread, warnings, outcome, failure: null },
    proposedProfile: p,
  };
}

/** A base resume document from the profile. The header is copied character for character. */
export function documentFromProfile(p: ProfileInput): ResumeDocument {
  const name = [p.personal.firstName, p.personal.middleName, p.personal.lastName].filter(Boolean).join(' ');
  const sections: ResumeSection[] = [];
  if (p.summary) sections.push({ id: newId('sec'), kind: 'summary', title: 'Summary', text: p.summary, items: [] });
  if (p.work.length) sections.push({ id: newId('sec'), kind: 'experience', title: 'Experience', text: null, items: p.work.map((w) => ({ id: newId('it'), heading: w.company, subheading: w.title, location: w.location, startDate: w.startDate, endDate: w.endDate, current: w.current, bullets: [...w.bullets], tags: [] })) });
  if (p.education.length) sections.push({ id: newId('sec'), kind: 'education', title: 'Education', text: null, items: p.education.map((e) => ({ id: newId('it'), heading: e.school, subheading: [e.degree, e.major].filter(Boolean).join(' in ') || null, location: null, startDate: e.startDate, endDate: e.endDate, current: e.current, bullets: [...e.achievements], tags: [] })) });
  if (p.skills.length) sections.push({ id: newId('sec'), kind: 'skills', title: 'Skills', text: null, items: [{ id: newId('it'), heading: null, subheading: null, location: null, startDate: null, endDate: null, current: false, bullets: [], tags: p.skills.map((s) => s.name) }] });
  return {
    header: { name, email: p.personal.email, phone: p.personal.phone, city: p.personal.city ? [p.personal.city, p.personal.region].filter(Boolean).join(', ') : null, links: p.personal.links },
    sections,
  };
}

function fmtDate(d: string | null): string {
  if (!d) return '';
  const [y, m] = d.split('-');
  return m ? `${Object.keys(MONTHS)[Number(m) - 1]!.replace(/^./, (c) => c.toUpperCase())} ${y}` : y!;
}

export function docLines(doc: ResumeDocument): PdfLine[] {
  const out: PdfLine[] = [{ text: doc.header.name || 'Name not set', size: 18, bold: true }];
  const contact = [doc.header.email, doc.header.phone, doc.header.city, ...doc.header.links.map((l) => l.url)].filter(Boolean).join(' | ');
  if (contact) out.push({ text: contact, size: 9.5 });
  for (const s of doc.sections) {
    out.push({ text: s.title.toUpperCase(), size: 11, bold: true, gapBefore: 8 });
    if (s.text) out.push({ text: s.text });
    for (const it of s.items) {
      if (s.kind === 'skills') { out.push({ text: it.tags.join(', ') }); continue; }
      const head = [it.subheading, it.heading].filter(Boolean).join(', ');
      const dates = it.startDate ? `${fmtDate(it.startDate)} - ${it.current ? 'Present' : fmtDate(it.endDate)}` : '';
      if (head || dates) out.push({ text: [head, dates].filter(Boolean).join('   '), bold: true, gapBefore: 3 });
      for (const b of it.bullets) out.push({ text: `- ${b}` });
    }
  }
  return out;
}

export function renderPdf(doc: ResumeDocument): { bytes: Uint8Array; pages: number } {
  const r = makePdf(docLines(doc));
  return { bytes: r.bytes, pages: r.pages };
}

export function renderDocx(doc: ResumeDocument): Uint8Array {
  return makeDocx(docLines(doc).map((l) => ({ text: l.text, bold: l.bold, size: l.size })));
}

export function fitCheck(doc: ResumeDocument): { fitsOnePage: boolean; leftOut: string[] } {
  const lines = docLines(doc);
  const onePage = makePdf(lines, { maxPages: 1 });
  if (!onePage.leftOut) return { fitsOnePage: true, leftOut: [] };
  // name the last items that do not fit
  const leftOut: string[] = [];
  let over = onePage.leftOut;
  for (let i = lines.length - 1; i >= 0 && over > 0; i--, over--) leftOut.unshift(lines[i]!.text.slice(0, 80));
  return { fitsOnePage: false, leftOut: leftOut.slice(-8) };
}

/** A readability grade of the exported PDF (same file, same report). */
export function atsCheck(doc: ResumeDocument, now: string): AtsReport {
  const pdf = renderPdf(doc);
  const findings: AtsReport['findings'] = [];
  const bullets = doc.sections.flatMap((s) => s.items.flatMap((i) => i.bullets));
  const withNumbers = bullets.filter((b) => /\d/.test(b)).length;
  if (!doc.header.email) findings.push({ id: 'contact-email', rule: 'Contact email', severity: 'urgent', message: 'Add an email address at the top so employers can reach you.', evidence: 'No email in the header.' });
  if (!doc.header.phone) findings.push({ id: 'contact-phone', rule: 'Contact phone', severity: 'critical', message: 'Add a phone number at the top.', evidence: 'No phone in the header.' });
  if (!doc.sections.some((s) => s.kind === 'experience')) findings.push({ id: 'section-experience', rule: 'Experience section', severity: 'urgent', message: 'Add an Experience section with your jobs.', evidence: 'No section titled Experience.' });
  if (!doc.sections.some((s) => s.kind === 'skills')) findings.push({ id: 'section-skills', rule: 'Skills section', severity: 'critical', message: 'Add a Skills section so readers and screening software find your skills.', evidence: 'No section titled Skills.' });
  if (!doc.sections.some((s) => s.kind === 'summary')) findings.push({ id: 'section-summary', rule: 'Summary', severity: 'optional', message: 'A two-line summary at the top helps readers.', evidence: 'No summary section.' });
  if (bullets.length && withNumbers / bullets.length < 0.3) findings.push({ id: 'bullets-results', rule: 'Measured results', severity: 'critical', message: 'Fewer than a third of your bullets state a number. Add measured results where they are true.', evidence: `${withNumbers} of ${bullets.length} bullets have a number.` });
  for (const b of bullets) if (b.split(/\s+/).length < 5) { findings.push({ id: `bullet-short-${findings.length}`, rule: 'Bullet length', severity: 'optional', message: 'This bullet is very short. Say what you did and what happened.', evidence: b.slice(0, 120) }); break; }
  if (pdf.pages > 1) findings.push({ id: 'length', rule: 'Length', severity: 'critical', message: `The exported file is ${pdf.pages} pages. One page is easier to read.`, evidence: `${pdf.pages} pages.` });
  const score = Math.max(0, 100 - findings.reduce((s, f) => s + (f.severity === 'urgent' ? 20 : f.severity === 'critical' ? 10 : 3), 0));
  const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 65 ? 'C' : score >= 50 ? 'D' : 'F';
  return { grade, score, findings, fileSha256: sha256(pdf.bytes), checkedAt: now };
}

export function keywordGaps(job: Job, doc: ResumeDocument, profile: ProfileInput, resumeId: string): KeywordGapReport {
  const terms = job.skills;
  const resumeText = JSON.stringify(doc.sections);
  const inResume = new Set(skillsIn(resumeText).map((s) => s.toLowerCase()));
  const inProfile = new Set(profile.skills.map((s) => s.name.toLowerCase()));
  return {
    jobId: job.id,
    resumeId,
    requirementsFound: terms.length > 0,
    terms: terms.map((t) => ({
      term: t,
      status: inResume.has(t.toLowerCase()) ? 'covered' : inProfile.has(t.toLowerCase()) ? 'in_profile_not_resume' : 'not_in_profile',
      matchedAs: inResume.has(t.toLowerCase()) ? t : null,
    })),
  };
}
