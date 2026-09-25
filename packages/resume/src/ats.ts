// The readability check (resume O11): grades the exact PDF bytes the person downloads, the way another system
// would read them. Deterministic: the same file always gets the same score and findings. Each finding names its
// evidence. Scoring (jobleft's own rules, in the spirit of reactive-resume's ats-pdf): five parts with weights
// (text 35, layout 20, sections 20, contact 15, dates 10); an "urgent" finding costs its part 60 points and caps
// the total; a "critical" one costs 15; an "optional" one is advice and costs nothing.

import { createHash } from 'node:crypto';
import type { AtsReport } from '@jobleft/contracts';
import { nowIso } from '@jobleft/contracts';
import { findDateRange } from './import/dates.ts';
import { dropPageFurniture, findGutterForPage, pdfPageLines, type SrcLine } from './import/lines.ts';
import { parseLines } from './import/parse.ts';
import { PdfReadError, readPdf, type PdfRead } from './pdf-read.ts';
import { SECTION_ALIASES } from './lexicon.ts';
import { foldKey } from './text.ts';

type Severity = 'urgent' | 'critical' | 'optional';
type Part = 'text' | 'layout' | 'sections' | 'contact' | 'dates';
interface Finding { id: string; rule: string; severity: Severity; message: string; evidence: string; part: Part; cap?: number }

const WEIGHTS: Record<Part, number> = { text: 35, layout: 20, sections: 20, contact: 15, dates: 10 };
const COST: Record<Severity, number> = { urgent: 60, critical: 15, optional: 0 };

function grade(score: number): AtsReport['grade'] {
  return score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';
}

function scoreOf(findings: Finding[]): number {
  const part: Record<Part, number> = { text: 100, layout: 100, sections: 100, contact: 100, dates: 100 };
  const seen = new Set<string>();
  for (const f of findings) {
    if (seen.has(f.rule)) continue;
    seen.add(f.rule);
    part[f.part] = Math.max(0, part[f.part] - COST[f.severity]);
  }
  let total = 0;
  for (const p of Object.keys(WEIGHTS) as Part[]) total += (WEIGHTS[p] * part[p]) / 100;
  let score = Math.round(total);
  for (const f of findings) if (f.cap !== undefined) score = Math.min(score, f.cap);
  return Math.max(0, Math.min(100, score));
}

function report(bytes: Uint8Array, findings: Finding[]): AtsReport {
  const score = scoreOf(findings);
  const order: Record<Severity, number> = { urgent: 0, critical: 1, optional: 2 };
  const sorted = [...findings].sort((a, b) => order[a.severity] - order[b.severity] || a.id.localeCompare(b.id));
  return {
    grade: grade(score),
    score,
    findings: sorted.map(({ id, rule, severity, message, evidence }) => ({ id, rule, severity, message, evidence })),
    fileSha256: createHash('sha256').update(bytes).digest('hex'),
    checkedAt: nowIso(),
  };
}

const q = (s: string, n = 60) => `"${s.length > n ? s.slice(0, n - 1) + '…' : s}"`;

/** Grades the exact PDF bytes (same file, same score and findings). */
export async function atsCheckPdf(bytes: Uint8Array): Promise<AtsReport> {
  const findings: Finding[] = [];
  const add = (f: Finding) => { if (!findings.some((x) => x.id === f.id)) findings.push(f); };
  if (bytes.byteLength === 0) {
    add({ id: 'file-empty', rule: 'file_empty', severity: 'urgent', part: 'text', cap: 0, message: 'The file is empty.', evidence: '0 bytes' });
    return report(bytes, findings);
  }
  let read: PdfRead;
  try {
    read = await readPdf(bytes, { maxPages: 20 });
  } catch (e) {
    const pw = e instanceof PdfReadError && e.reason === 'password';
    add(pw
      ? { id: 'file-encrypted', rule: 'encrypted', severity: 'urgent', part: 'text', cap: 5, message: 'The PDF needs a password to open, so other systems cannot read it.', evidence: 'The file asks for a password (standard security handler).' }
      : { id: 'file-unreadable', rule: 'not_a_pdf', severity: 'urgent', part: 'text', cap: 0, message: 'The file could not be read as a PDF.', evidence: 'PDF structure could not be parsed.' });
    return report(bytes, findings);
  }

  // ---- text layer
  const pages = read.pages;
  const chars = pages.map((p) => p.items.reduce((n, i) => n + i.text.trim().length, 0));
  const totalChars = chars.reduce((a, b) => a + b, 0);
  const images = pages.reduce((n, p) => n + p.images, 0);
  if (totalChars === 0) {
    add({ id: 'text-none', rule: 'no_text_layer', severity: 'urgent', part: 'text', cap: 10, message: 'The PDF has no text layer: it is a picture of a resume. Other systems read nothing from it.', evidence: `${pages.length} page${pages.length === 1 ? '' : 's'}, 0 characters of text, ${images} image${images === 1 ? '' : 's'}.` });
    return report(bytes, findings);
  }
  const blank = pages.filter((_, i) => chars[i] === 0).map((p) => p.index + 1);
  if (blank.length) add({ id: 'text-image-pages', rule: 'pages_without_text', severity: 'critical', part: 'text', message: 'Some pages have no text (they look scanned). Their content is lost to other systems.', evidence: `Pages without text: ${blank.join(', ')}.` });
  if (read.encrypted) add({ id: 'file-restricted', rule: 'encrypted', severity: 'critical', part: 'text', message: 'The PDF is encrypted (it opens, but some systems refuse encrypted files).', evidence: 'The file has an encryption dictionary.' });
  const inv = pages.reduce((n, p) => n + p.hiddenOps.invisible, 0);
  const white = pages.reduce((n, p) => n + p.hiddenOps.white, 0);
  if (inv) add({ id: 'text-invisible', rule: 'invisible_text', severity: 'urgent', part: 'text', cap: 40, message: 'The PDF holds invisible text. Systems read it but people do not see it; it can look like keyword stuffing.', evidence: `${inv} text drawing operation${inv === 1 ? '' : 's'} with render mode 3 (invisible).` });
  if (white) add({ id: 'text-white', rule: 'white_text', severity: 'urgent', part: 'text', cap: 40, message: 'The PDF holds white text on a white page. It can look like keyword stuffing.', evidence: `${white} text drawing operation${white === 1 ? '' : 's'} in white fill.` });
  const allText = pages.flatMap((p) => p.items.map((i) => i.text)).join(' ');
  const lig = allText.match(/[ﬀ-ﬆ]/g) ?? [];
  const pua = allText.match(/[-�]/g) ?? [];
  if (lig.length) add({ id: 'text-ligatures', rule: 'ligatures', severity: 'critical', part: 'text', message: 'Letter pairs such as "fi" are stored as one ligature symbol, so some systems read "certied" for "certified".', evidence: `${lig.length} ligature character${lig.length === 1 ? '' : 's'} (for example U+${lig[0]!.codePointAt(0)!.toString(16).toUpperCase()}).` });
  if (pua.length > 3) add({ id: 'text-odd-chars', rule: 'unmapped_characters', severity: 'critical', part: 'text', message: 'Some characters have no readable meaning in the text layer (icon fonts or broken encodings).', evidence: `${pua.length} unreadable characters.` });
  const words = allText.split(/\s+/).filter((w) => /[A-Za-z]{3,}/.test(w));
  const noVowel = words.filter((w) => !/[aeiouyAEIOUY]/.test(w) && !/^[A-Z0-9&+#./-]+$/.test(w));
  if (words.length > 30 && noVowel.length / words.length > 0.3) add({ id: 'text-garbled', rule: 'garbled_text', severity: 'urgent', part: 'text', cap: 20, message: 'The text layer looks garbled (wrong character encoding).', evidence: `${noVowel.length} of ${words.length} words have no vowels, for example ${q(noVowel.slice(0, 3).join(' '))}.` });
  const tiny = pages.flatMap((p) => p.items).filter((i) => i.text.trim() && i.size > 0 && i.size < 6.5);
  if (tiny.length > 2) add({ id: 'text-tiny', rule: 'tiny_text', severity: 'critical', part: 'text', message: 'Some text is smaller than 6.5 pt; systems and people may miss it.', evidence: `${tiny.length} text runs under 6.5 pt, for example ${q(tiny[0]!.text)} at ${tiny[0]!.size.toFixed(1)} pt.` });
  const outside = pages.flatMap((p) => p.items.filter((i) => i.text.trim() && (i.x < -1 || i.y < -1 || i.x > p.width + 1 || i.y > p.height + 1)));
  if (outside.length) add({ id: 'text-off-page', rule: 'text_off_page', severity: 'urgent', part: 'text', cap: 40, message: 'Some text sits outside the page, where people cannot see it.', evidence: `${outside.length} text runs outside the page box, for example ${q(outside[0]!.text)}.` });
  if (bytes.byteLength > 2 * 1048576) add({ id: 'file-large', rule: 'file_size', severity: 'optional', part: 'text', message: 'The file is large; some upload forms refuse files over 2 MB.', evidence: `${(bytes.byteLength / 1048576).toFixed(1)} MB.` });

  // ---- layout
  for (const p of pages) {
    const g = findGutterForPage(p);
    if (g) add({ id: `layout-columns-p${p.index + 1}`, rule: 'multi_column', severity: 'urgent', part: 'layout', cap: 60, message: 'Text is laid out in two columns (or a table). Many systems read straight across both columns and mix the lines up.', evidence: `Page ${p.index + 1}: a gap at x = ${Math.round(g.x)} pt splits ${g.left} lines on the left from ${g.right} lines on the right.` });
  }
  if (pages.length > 2) add({ id: 'layout-pages', rule: 'page_count', severity: 'critical', part: 'layout', message: 'The resume runs to more than two pages.', evidence: `${pages.length} pages.` });
  else if (pages.length === 2) add({ id: 'layout-pages', rule: 'page_count', severity: 'optional', part: 'layout', message: 'The resume is two pages; one page is easier to read for most roles.', evidence: '2 pages.' });
  if (images) add({ id: 'layout-images', rule: 'images', severity: 'optional', part: 'layout', message: 'The PDF has pictures. Text inside pictures is not read.', evidence: `${images} image${images === 1 ? '' : 's'}.` });

  // ---- structure, as another system reads it (the same reader jobleft's import uses)
  let lines: SrcLine[] = [];
  for (const p of pages) lines.push(...pdfPageLines(p));
  lines = dropPageFurniture(lines, pages.length);
  const parsed = parseLines(lines, { source: 'pdf' });
  const headings = lines.filter((l) => {
    const k = foldKey(l.text.replace(/[:：]$/, ''));
    return !!SECTION_ALIASES[k];
  }).map((l) => ({ text: l.text.trim(), kind: SECTION_ALIASES[foldKey(l.text.replace(/[:：]$/, ''))]! }));
  const kinds = new Set(headings.map((h) => h.kind));
  const seenHeads = headings.map((h) => q(h.text, 30)).join(', ') || 'none';
  if (!kinds.has('experience')) add({ id: 'sections-experience', rule: 'missing_experience_heading', severity: 'critical', part: 'sections', message: 'No standard "Experience" heading was found, so systems may not find your work history.', evidence: `Headings found: ${seenHeads}.` });
  if (!kinds.has('education')) add({ id: 'sections-education', rule: 'missing_education_heading', severity: 'critical', part: 'sections', message: 'No standard "Education" heading was found.', evidence: `Headings found: ${seenHeads}.` });
  if (!kinds.has('skills')) add({ id: 'sections-skills', rule: 'missing_skills_heading', severity: 'critical', part: 'sections', message: 'No standard "Skills" heading was found.', evidence: `Headings found: ${seenHeads}.` });
  if (parsed.unreadSections.length) add({ id: 'sections-nonstandard', rule: 'nonstandard_headings', severity: 'optional', part: 'sections', message: 'Some headings are not standard names; systems may file their content under "other".', evidence: `Headings: ${parsed.unreadSections.map((s) => q(s, 30)).join(', ')}.` });
  if (kinds.has('experience') && parsed.counts.jobs === 0) add({ id: 'sections-no-jobs', rule: 'no_jobs_read', severity: 'critical', part: 'sections', message: 'An experience heading is there, but no job could be read under it.', evidence: 'Jobs read: 0.' });

  // ---- contact
  const pr = parsed.profile.personal;
  const top = lines.slice(0, 4).map((l) => l.text).join(' | ');
  if (!pr.firstName) add({ id: 'contact-name', rule: 'missing_name', severity: 'critical', part: 'contact', message: 'No name was found at the top of the page.', evidence: `First lines: ${q(top, 90)}.` });
  if (!pr.email) add({ id: 'contact-email', rule: 'missing_email', severity: 'critical', part: 'contact', message: 'No email address was found.', evidence: 'No text matched an email address.' });
  if (!pr.phone) add({ id: 'contact-phone', rule: 'missing_phone', severity: 'optional', part: 'contact', message: 'No phone number was found.', evidence: 'No text matched a phone number.' });
  const firstPage = pages[0]!;
  const edge = firstPage.items.filter((i) => i.text.trim() && (i.y > firstPage.height - 30 || i.y < 30) && /@|\d{3}[\s.-]\d{3,4}/.test(i.text));
  if (edge.length) add({ id: 'contact-edge', rule: 'contact_in_margin', severity: 'optional', part: 'contact', message: 'Contact details sit in the page margin, where some systems treat text as a header or footer and skip it.', evidence: `${q(edge[0]!.text)} at ${Math.round(edge[0]!.y)} pt from the bottom.` });

  // ---- dates
  const work = parsed.profile.work;
  if (work.length && work.every((w) => !w.startDate && !w.endDate)) add({ id: 'dates-none', rule: 'no_dates', severity: 'critical', part: 'dates', message: 'No job has dates that systems can read.', evidence: `${work.length} job${work.length === 1 ? '' : 's'}, none with a readable date.` });
  else {
    const missing = work.filter((w) => !w.startDate && !w.endDate);
    if (missing.length) add({ id: 'dates-missing', rule: 'jobs_without_dates', severity: 'critical', part: 'dates', message: 'Some jobs have no dates that systems can read.', evidence: `${missing.map((w) => q(w.company, 30)).join(', ')}.` });
  }
  const reversed = work.filter((w) => w.startDate && w.endDate && w.endDate < w.startDate);
  if (reversed.length) add({ id: 'dates-reversed', rule: 'end_before_start', severity: 'critical', part: 'dates', message: 'A job ends before it starts.', evidence: reversed.map((w) => `${w.company}: ${w.startDate} to ${w.endDate}`).join('; ') });
  const dateLines = lines.map((l) => findDateRange(l.text)?.raw).filter((x): x is string => !!x);
  const styles = new Set(dateLines.map((d) => (/[A-Za-z]{3}/.test(d) ? 'month-name' : /\d{1,2}\/\d{4}/.test(d) ? 'numeric' : 'year')));
  if (styles.size > 1) add({ id: 'dates-mixed', rule: 'mixed_date_formats', severity: 'optional', part: 'dates', message: 'Dates are written in more than one style.', evidence: `Styles: ${[...styles].join(', ')}.` });

  return report(bytes, findings);
}
