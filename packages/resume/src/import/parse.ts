// Source lines -> a proposed profile. Deterministic: no AI reads the file, so nothing is invented and nothing
// leaves the laptop during import. Every section the profile has no field for is kept word for word (extraSections)
// and named in the report, so nothing is dropped silently (resume O2).

import type { EducationEntry, ExtraSection, Link, ProfileInput, ProjectEntry, SkillEntry, WorkEntry } from '@jobleft/contracts';
import { findDegrees, findLocations, findSkills, isUsState } from '../facts.ts';
import { KNOWN_OTHER_HEADINGS, ORG_WORDS, ROLE_NOUNS, SECTION_ALIASES, SENIORITY_WORDS } from '../lexicon.ts';
import { foldKey, stableId, squash } from '../text.ts';
import { findDateRange, hasDateRange } from './dates.ts';
import type { SrcLine } from './lines.ts';

export interface ParseResult {
  profile: ProfileInput;
  unreadSections: string[];
  warnings: string[];
  counts: { jobs: number; bullets: number; skills: number; education: number };
}

type Kind = 'summary' | 'experience' | 'education' | 'skills' | 'projects' | 'certifications' | 'contact' | 'custom';

interface Section { title: string; kind: Kind; lines: SrcLine[] }

const CONTACT_HEADINGS = new Set(['contact', 'contact information', 'contact info', 'contact details', 'personal details', 'personal information', 'details', 'info', 'links', 'profiles', 'social', 'online']);

function headingKey(text: string): string {
  return foldKey(text.replace(/[:：]\s*$/, '')).replace(/\//g, ' and ').replace(/\s+/g, ' ').trim();
}

function kindOfHeading(text: string): Kind | 'other' | null {
  const k = headingKey(text);
  if (!k || k.split(' ').length > 6) return null;
  if (SECTION_ALIASES[k]) return SECTION_ALIASES[k]!;
  if (CONTACT_HEADINGS.has(k)) return 'contact';
  if (KNOWN_OTHER_HEADINGS.has(k)) return 'other';
  return null;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
const URLISH = /\b(?:https?:\/\/|www\.)\S+|\b(?:linkedin\.com|github\.com|gitlab\.com|behance\.net|dribbble\.com|medium\.com)\/\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|io|dev|me|org|net|ai|app|co|tech|page|site)(?:\/\S*)?/i;
const PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])?\d{3}[\s.-]\d{3,4}(?:[\s.-]\d{2,4})?/;

function isContactLine(t: string): boolean {
  return EMAIL.test(t) || URLISH.test(t) || (PHONE.test(t) && (t.match(/\d/g)?.length ?? 0) >= 7 && !hasDateRange(t));
}

/** Decides which lines are section headings. Uses known names first, then look (size, bold, capitals). */
function markHeadings(lines: SrcLine[]): Array<{ line: SrcLine; heading: Kind | 'other' | 'unknown' | null }> {
  const sizes = lines.map((l) => l.size).filter((s) => s > 0).sort((a, b) => a - b);
  const body = sizes.length ? sizes[Math.floor(sizes.length / 2)]! : 0;
  return lines.map((line, i) => {
    const t = line.text.trim();
    if (!t || line.bullet) return { line, heading: null };
    const known = kindOfHeading(t);
    const words = t.replace(/[:：]$/, '').split(/\s+/);
    const shortish = words.length <= 5 && t.length <= 48 && !/[.!?]$/.test(t) && !/\d/.test(t) && !isContactLine(t);
    if (known && shortish) return { line, heading: known };
    if (!shortish || i === 0) return { line, heading: null };
    const styled = line.style !== null && /^(?:heading|title|sectiontitle)/i.test(line.style);
    const letters = t.replace(/[^\p{L}]/gu, '');
    // All capitals marks a heading ("PUBLICATIONS"), but not a skill written in capitals ("AWS", "SQL").
    const isTerm = findSkills(t).some((m) => m.text.length >= t.replace(/[:：]$/, '').trim().length - 1) || /^[A-Z]{2,4}$/.test(t);
    const caps = letters.length >= 4 && letters === letters.toUpperCase() && words.length <= 4 && !isTerm;
    const bigger = body > 0 && line.size >= body * 1.08 && (line.bold || line.size >= body * 1.15);
    if (styled || caps || bigger) {
      // An entry heading (an employer, school or job title, often in capitals) sits right above its dates, or names
      // an organisation or a role; a section heading does not.
      const near = lines.slice(i + 1, i + 3).map((l) => l.text);
      if (!styled && near.some((x) => hasDateRange(x))) return { line, heading: null };
      if (hasDateRange(t) || findDateRange(t)) return { line, heading: null };
      if (!styled && (orgScore(t) > 0 || titleScore(t) >= 2)) return { line, heading: null };
      return { line, heading: 'unknown' };
    }
    return { line, heading: null };
  });
}

// ------------------------------------------------------------------------------------------------ contact block

interface Contact { name: string | null; email: string | null; phone: string | null; city: string | null; region: string | null; links: Link[]; unread: string[] }

function linkLabel(url: string): string {
  const h = url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').toLowerCase();
  if (h.startsWith('linkedin.com')) return 'LinkedIn';
  if (h.startsWith('github.com')) return 'GitHub';
  if (h.startsWith('gitlab.com')) return 'GitLab';
  return 'Website';
}

function looksLikeName(t: string): boolean {
  const w = t.trim().split(/\s+/);
  if (w.length < 2 || w.length > 5) return false;
  if (/[\d@/|:]/.test(t)) return false;
  return w.every((x) => /^[\p{Lu}][\p{L}'’.-]*$/u.test(x) || /^(?:de|da|del|van|von|der|den|la|le|di|du|bin|al)$/i.test(x));
}

function parseContact(lines: SrcLine[]): Contact {
  const c: Contact = { name: null, email: null, phone: null, city: null, region: null, links: [], unread: [] };
  // Join a link that was broken over two lines ("https://github.com/jordan-" + "testwell-example").
  const texts: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let t = lines[i]!.text.trim();
    const next = lines[i + 1]?.text.trim();
    if (URLISH.test(t) && /[-/_.]$/.test(t) && next && /^[\w\-./~%?=&#]+$/.test(next) && !EMAIL.test(next) && !/^(?:19|20)\d\d$/.test(next)) {
      t += next;
      i++;
    }
    texts.push(t);
  }
  for (const t of texts) {
    let rest = t;
    const em = rest.match(new RegExp(EMAIL.source, 'g'));
    if (em) { if (!c.email) c.email = em[0]!; for (const e of em) rest = rest.replace(e, ' '); }
    const urls = rest.match(new RegExp(URLISH.source, 'gi')) ?? [];
    for (const u0 of urls) {
      const u = u0.replace(/[),.;]+$/, '');
      rest = rest.replace(u0, ' ');
      const url = /^https?:\/\//i.test(u) ? u : `https://${u}`;
      try { new URL(url); } catch { continue; }
      if (!c.links.some((l) => l.url === url)) c.links.push({ label: linkLabel(url), url });
    }
    const ph = PHONE.exec(rest);
    if (ph && (ph[0].match(/\d/g)?.length ?? 0) >= 7 && !hasDateRange(ph[0])) {
      if (!c.phone) c.phone = ph[0].trim();
      rest = rest.replace(ph[0], ' ');
    }
    const loc = /([\p{Lu}][\p{L}.'-]+(?:\s+[\p{Lu}][\p{L}.'-]+){0,2}),\s*([A-Z]{2}|[\p{Lu}][\p{L}]+(?:\s+[\p{Lu}][\p{L}]+)?)\b/u.exec(rest);
    if (loc && !c.city && (isUsState(loc[2]!) || /^(?:USA|US|UK|Canada|India|Germany|France|Remote)$/.test(loc[2]!) || /^[\p{Lu}][\p{L}]+$/u.test(loc[2]!))) {
      if (!looksLikeName(rest.trim()) || rest.trim() !== `${loc[1]}, ${loc[2]}`) {
        c.city = loc[1]!;
        c.region = loc[2]!;
        rest = rest.replace(loc[0], ' ');
      }
    }
    rest = rest.replace(/[|•·,;]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!rest) continue;
    if (!c.name && looksLikeName(rest)) { c.name = rest; continue; }
    if (!c.name && !isContactLine(rest) && rest.split(' ').length <= 4 && /^[\p{Lu}]/u.test(rest)) { c.name = rest; continue; }
    c.unread.push(rest);
  }
  return c;
}

// ------------------------------------------------------------------------------------------------ entries

interface Entry { head: SrcLine[]; bullets: string[]; hasDate: boolean; lastBulletLine: SrcLine | null }

function isHeaderLike(t: string): boolean {
  const words = t.split(/\s+/).length;
  return words <= 14 && !/[.!?]$/.test(t.trim());
}

/** Lines are bullets when marked, or when indented past the section's left edge (PDFs often draw the dot as a shape). */
function bulletFlags(lines: SrcLine[]): boolean[] {
  const xs = lines.filter((l) => !l.bullet).map((l) => l.x);
  const base = xs.length ? Math.min(...xs) : 0;
  const indentStep = lines.some((l) => l.size > 0) ? 6 : 2;
  return lines.map((l) => l.bullet || (l.x - base >= indentStep && !hasDateRange(l.text) && lines.some((o) => o.x - base < indentStep)));
}

function continuation(prev: SrcLine | null, prevText: string, line: SrcLine, flaggedBullet: boolean): boolean {
  if (!prev) return false;
  if (line.bullet) return false; // a real mark always starts a new bullet
  const t = line.text.trim();
  if (/^[a-z(,;&]/.test(t)) return true;
  if (/[-–,;/(&]$/.test(prevText.trim()) || /\b(?:and|or|of|the|to|for|with|in|on|a|an)$/i.test(prevText.trim())) return true;
  // Unmarked bullets: a line that follows a line which ran to the right edge and did not end a sentence.
  if (flaggedBullet && prev.xEnd > 0 && line.xEnd > 0 && Math.abs(line.x - prev.x) < 2 && !/[.!?:]$/.test(prevText.trim())) {
    return prev.xEnd >= Math.max(line.xEnd, prev.xEnd) * 0.8 && prevText.length > 40;
  }
  return false;
}

function groupEntries(lines: SrcLine[], opts: { dated: boolean }): { entries: Entry[]; orphans: number } {
  const flags = bulletFlags(lines);
  const entries: Entry[] = [];
  let cur: Entry | null = null;
  let orphans = 0;
  const lookaheadDate = (i: number) => {
    for (let k = i + 1; k <= i + 3 && k < lines.length; k++) {
      if (flags[k]) return false;
      if (hasDateRange(lines[k]!.text) || (opts.dated && findDateRange(lines[k]!.text))) return true;
    }
    return false;
  };
  lines.forEach((line, i) => {
    const t = line.text.trim();
    if (!t) return;
    const isB = flags[i]!;
    if (isB) {
      if (!cur) { cur = { head: [], bullets: [], hasDate: false, lastBulletLine: null }; entries.push(cur); orphans++; }
      const prevText = cur.bullets[cur.bullets.length - 1];
      if (prevText !== undefined && continuation(cur.lastBulletLine, prevText, line, !line.bullet)) {
        cur.bullets[cur.bullets.length - 1] = joinWrapped(prevText, t);
      } else cur.bullets.push(t);
      cur.lastBulletLine = line;
      return;
    }
    const dated = hasDateRange(t) || (opts.dated && !!findDateRange(t));
    if (cur && cur.bullets.length === 0 && cur.head.length < 4 && !(dated && cur.hasDate)) {
      cur.head.push(line);
      if (dated) cur.hasDate = true;
      return;
    }
    if (cur && cur.bullets.length > 0 && !dated && !(isHeaderLike(t) && lookaheadDate(i))) {
      const prevText = cur.bullets[cur.bullets.length - 1]!;
      if (continuation(cur.lastBulletLine, prevText, line, false)) cur.bullets[cur.bullets.length - 1] = joinWrapped(prevText, t);
      else if (!isHeaderLike(t) || line.gapAbove < 0.6) cur.bullets.push(t);
      else { cur = { head: [line], bullets: [], hasDate: dated, lastBulletLine: null }; entries.push(cur); return; }
      cur.lastBulletLine = line;
      return;
    }
    cur = { head: [line], bullets: [], hasDate: dated, lastBulletLine: null };
    entries.push(cur);
  });
  return { entries, orphans };
}

function joinWrapped(a: string, b: string): string {
  if (/[A-Za-z]-$/.test(a) && /^[a-z]/.test(b)) return a.slice(0, -1) + b; // "devel-" + "opment"
  if (/[/-]$/.test(a)) return a + b;
  return `${a} ${b}`;
}

const SEP = /\s{2,}|\s+[|•·]\s+|\s+[—–]\s+|\s+-\s+|\t|\s*\|\s*/;

function splitParts(text: string): string[] {
  return text.split(SEP).map((p) => p.replace(/^[,;:\s]+|[,;:\s]+$/g, '').trim()).filter(Boolean);
}

const ROLE_SET = new Set(ROLE_NOUNS);
const SENIOR_SET = new Set(SENIORITY_WORDS.map((w) => w.replace(/\.$/, '')));
const ORG_SET = new Set(ORG_WORDS.map((w) => w.replace(/\.$/, '')));

function titleScore(t: string): number {
  const ws = foldKey(t).split(' ');
  let s = 0;
  for (const w of ws) {
    if (ROLE_SET.has(w) || ROLE_SET.has(w.replace(/s$/, ''))) s += 2;
    if (SENIOR_SET.has(w)) s += 1;
    if (['software', 'data', 'product', 'marketing', 'sales', 'research', 'teaching', 'nursing', 'backend', 'frontend', 'full', 'stack', 'web'].includes(w)) s += 0.3;
  }
  if (/\bintern(ship)?\b/i.test(t)) s += 2;
  return s;
}

function orgScore(t: string): number {
  const ws = foldKey(t).split(' ');
  let s = 0;
  for (const w of ws) if (ORG_SET.has(w)) s += 2;
  if (/\b(?:Inc|LLC|Ltd|Corp|GmbH|PLC|LLP)\b\.?/.test(t)) s += 3;
  if (/[&]/.test(t)) s += 0.5;
  return s;
}

function extractLocation(text: string): { location: string | null; rest: string } {
  const remote = /\b(Remote|Hybrid|On-?site)(?:\s*\((?:US|USA|United States)\))?\b/.exec(text);
  const locs = findLocations(text);
  if (locs.length) {
    const l = locs[locs.length - 1]!;
    return { location: l.text, rest: text.slice(0, l.start) + '  ' + text.slice(l.end) };
  }
  const intl = /,\s*([\p{Lu}][\p{L}]+(?:\s+[\p{Lu}][\p{L}]+)?),\s*(USA|United States|Canada|UK|United Kingdom|India|Germany|France|Australia|Mexico|Brazil|Spain|Netherlands|Ireland|Singapore|Japan)\b/u.exec(text);
  if (intl) return { location: `${intl[1]}, ${intl[2]}`, rest: text.replace(intl[0], ' ') };
  if (remote) return { location: remote[0], rest: text.replace(remote[0], ' ') };
  return { location: null, rest: text };
}

function parseWorkEntry(e: Entry, index: number, warnings: string[]): WorkEntry {
  const headText = e.head.map((l) => l.text).join('  ');
  const dr = findDateRange(headText);
  let rest = dr ? headText.replace(dr.raw, '  ') : headText;
  const loc = extractLocation(rest);
  rest = loc.rest;
  let title: string | null = null;
  let company: string | null = null;
  const at = /^(.+?)\s+(?:at|@)\s+(.+)$/i.exec(rest.trim().split(SEP)[0] ?? '');
  let parts = splitParts(rest);
  // Work type words ("Full-time", "Contract") are a field of their own, not a title, employer or bullet.
  let employmentType: WorkEntry['employmentType'] = null;
  const TYPE: Record<string, NonNullable<WorkEntry['employmentType']>> = { 'full time': 'full_time', 'full-time': 'full_time', 'part time': 'part_time', 'part-time': 'part_time', contract: 'contract', contractor: 'contract', internship: 'internship', temporary: 'temporary', freelance: 'contract' };
  parts = parts.filter((p) => {
    const k = p.toLowerCase().replace(/[()]/g, '').trim();
    if (TYPE[k]) { employmentType = TYPE[k]!; return false; }
    return !/^(?:remote|hybrid|on-?site)$/i.test(k);
  });
  if (at && titleScore(at[1]!) > 0) {
    title = at[1]!.trim();
    company = at[2]!.trim();
    parts = parts.slice(1);
  } else {
    // Split "Software Engineer, Northwind Labs" on commas when neither side has a strong separator.
    parts = parts.flatMap((p) => (p.includes(',') && parts.length < 2 ? p.split(/\s*,\s*/) : [p])).filter(Boolean);
    const scored = parts.map((p, i) => ({ p, i, t: titleScore(p), o: orgScore(p) }));
    const byTitle = [...scored].sort((a, b) => b.t - a.t || a.i - b.i);
    if (byTitle[0] && byTitle[0].t > 0 && byTitle[0].t > byTitle[0].o) title = byTitle[0].p;
    const others = scored.filter((s) => s.p !== title);
    const byOrg = [...others].sort((a, b) => b.o - a.o || a.i - b.i);
    if (byOrg[0]) company = byOrg[0].p;
    if (!title && others.length > 1) title = others.find((s) => s.p !== company)?.p ?? null;
    // With two plain parts and no signal, a bold first line is the title (the common "Title / Company" layout).
    if (!title && company && parts.length >= 2) {
      const boldFirst = e.head[0]?.bold;
      if (boldFirst) { title = parts[0]!; company = parts[1]!; }
    }
    parts = parts.filter((p) => p !== title && p !== company);
  }
  if (!title || !company) warnings.push(`Experience entry ${index + 1}: could not tell the job title from the employer in "${squash(headText)}". Check this entry.`);
  if (!dr) warnings.push(`Experience entry ${index + 1} (${company ?? title ?? 'no name'}): no dates were found.`);
  const extra = parts.filter(Boolean);
  const start = dr?.start ?? (dr && !dr.current ? dr.end : null);
  const end = dr?.current ? null : dr?.end ?? null;
  return {
    id: stableId('w', company ?? '', title ?? '', start ?? '', String(index)),
    company: company ?? extra.shift() ?? '(employer not read)',
    title: title ?? extra.shift() ?? '(title not read)',
    employmentType: employmentType ?? (/\bintern(ship)?\b/i.test(title ?? '') ? 'internship' : null),
    location: loc.location,
    startDate: start,
    endDate: dr && !dr.current ? (end ?? start) : null,
    current: !!dr?.current,
    summary: extra.length ? extra.join(' — ') : null,
    bullets: e.bullets,
  };
}

function parseEducationEntry(e: Entry, index: number, warnings: string[]): EducationEntry {
  const all = [...e.head.map((l) => l.text), ...e.bullets];
  const headText = e.head.map((l) => l.text).join('  ');
  const dr = findDateRange(headText);
  let rest = dr ? headText.replace(dr.raw, '  ') : headText;
  let gpa: string | null = null;
  const achievements: string[] = [];
  const coursework: string[] = [];
  const gpaRe = /\bGPA\s*[:\-]?\s*(\d(?:\.\d{1,2})?(?:\s*\/\s*\d(?:\.\d{1,2})?)?)/i;
  const g = gpaRe.exec(rest);
  if (g) { gpa = g[1]!.replace(/\s+/g, ''); rest = rest.replace(g[0], ' '); }
  for (const b of e.bullets) {
    const gb = gpaRe.exec(b);
    if (gb && b.replace(gb[0], '').trim().length < 3 && !gpa) { gpa = gb[1]!.replace(/\s+/g, ''); continue; }
    const cw = /^(?:relevant\s+)?coursework\s*[:\-]\s*(.+)$/i.exec(b);
    if (cw) { coursework.push(...cw[1]!.split(/\s*[,;]\s*/).filter(Boolean)); continue; }
    achievements.push(b);
  }
  rest = extractLocation(rest).rest;
  const parts = splitParts(rest).flatMap((p) => p.split(/\s*,\s*(?=[A-Z])/));
  let school: string | null = null;
  let degree: string | null = null;
  let major: string | null = null;
  for (const p of parts) {
    if (!school && /\b(?:University|College|Institute|School|Academy|Polytechnic|Universidad|Université)\b/.test(p)) { school = p; continue; }
    const d = findDegrees(p)[0];
    if (!degree && d) {
      const deg = p.slice(d.start, d.end);
      degree = deg.replace(/\s+in$/, '');
      const after = p.slice(d.end).replace(/^\s*(?:,|in|of)\s*/i, '').trim();
      const ofm = /^(Bachelor|Master|Associate|Doctor) of ([A-Z][a-z]+(?: [A-Z][a-z]+)?)(?: in (.+))?$/i.exec(p);
      if (ofm) { degree = `${ofm[1]} of ${ofm[2]}`; major = ofm[3] ?? null; } else if (after) major = after;
      continue;
    }
    if (!major && degree && /^[A-Z]/.test(p) && p.split(' ').length <= 6 && !/\d/.test(p)) { major = p; continue; }
  }
  if (!school) school = parts.find((p) => p !== degree && p !== major && !findDegrees(p).length) ?? null;
  if (!degree && !major) {
    const alt = parts.find((p) => p !== school);
    if (alt) degree = alt;
  }
  if (!school) warnings.push(`Education entry ${index + 1}: the school name was not found in "${squash(all.join(' '))}".`);
  return {
    id: stableId('e', school ?? '', degree ?? '', String(index)),
    school: school ?? '(school not read)',
    degree, major: major ? major.replace(/[.,]$/, '') : null, gpa,
    startDate: dr?.start ?? null,
    endDate: dr?.current ? null : dr?.end ?? null,
    current: !!dr?.current,
    achievements, coursework,
  };
}

function parseProjectEntry(e: Entry, index: number): ProjectEntry {
  const headText = e.head.map((l) => l.text).join('  ');
  const dr = findDateRange(headText);
  let rest = dr ? headText.replace(dr.raw, '  ') : headText;
  let url: string | null = null;
  const u = new RegExp(URLISH.source, 'i').exec(rest);
  if (u) { const raw = u[0].replace(/[),.;]+$/, ''); url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`; rest = rest.replace(u[0], ' '); try { new URL(url); } catch { url = null; } }
  const parts = splitParts(rest);
  const bullets = [...e.bullets];
  let description = parts.slice(1).join(' — ') || null;
  if (!description && bullets.length && e.bullets.length && !bullets[0]!.match(/^[A-Z][a-z]+ed\b/)) description = null;
  return {
    id: stableId('p', parts[0] ?? '', String(index)),
    name: parts[0] ?? '(project name not read)',
    description, url,
    startDate: dr?.start ?? null, endDate: dr?.current ? null : dr?.end ?? null,
    bullets,
  };
}

function splitList(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if (depth === 0 && /[,;|•·]/.test(ch)) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.flatMap((p) => p.split(/\s{2,}/)).map((p) => p.trim().replace(/\.$/, '').trim()).filter(Boolean);
}

function parseSkills(lines: SrcLine[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const l of lines) {
    let t = l.text.trim();
    t = t.replace(/^[^:,]{2,40}:\s+(?=\S)/, (m) => (m.split(' ').length <= 5 ? '' : m));
    for (const piece of splitList(t)) {
      const words = piece.split(/\s+/).length;
      const values = words >= 6 ? findSkills(piece).map((m) => m.text) : [piece];
      for (const v of values) {
        const k = v.toLowerCase();
        if (seen.has(k) || !v) continue;
        seen.add(k);
        out.push(v);
      }
    }
  }
  return out;
}

function parseCerts(lines: SrcLine[]): ProfileInput['certifications'] {
  const out: ProfileInput['certifications'] = [];
  for (const l of lines) {
    let t = l.text.trim();
    if (!t) continue;
    const dr = findDateRange(t);
    let date: string | null = null;
    if (dr) { date = dr.end ?? dr.start; t = t.replace(dr.raw, ' '); }
    const parts = splitParts(t).flatMap((p) => p.split(/\s*,\s*(?=[A-Z])|\s+(?:by|from|issued by)\s+/));
    if (!parts.length) continue;
    out.push({ name: parts[0]!.replace(/[,(]+$/, '').trim(), issuer: parts[1]?.replace(/[()]/g, '').trim() || null, date });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ main

export function parseLines(lines: SrcLine[], _opts: { source: 'pdf' | 'docx' | 'text' }): ParseResult {
  const warnings: string[] = [];
  const unreadSections: string[] = [];
  const marked = markHeadings(lines);
  const sections: Section[] = [];
  const headerLines: SrcLine[] = [];
  let cur: Section | null = null;
  for (const { line, heading } of marked) {
    if (heading) {
      const title = line.text.trim().replace(/[:：]\s*$/, '');
      const kind: Kind = heading === 'other' || heading === 'unknown' ? 'custom' : heading;
      cur = { title, kind, lines: [] };
      sections.push(cur);
      continue;
    }
    // "Skills: Python, SQL" on one line: a heading with its content.
    const inline = /^([A-Za-z &/]{3,40}):\s+(.+)$/.exec(line.text.trim());
    if (inline && !line.bullet) {
      const k = kindOfHeading(inline[1]!);
      if (k && k !== 'other' && k !== 'contact' && (!cur || cur.kind !== k)) {
        cur = { title: inline[1]!.trim(), kind: k, lines: [{ ...line, text: inline[2]! }] };
        sections.push(cur);
        continue;
      }
    }
    if (line.fromHeaderPart || !cur) headerLines.push(line);
    else cur.lines.push(line);
  }

  // Contact details: the lines above the first heading, plus any "Contact" section.
  const contactLines = [...headerLines, ...sections.filter((s) => s.kind === 'contact').flatMap((s) => s.lines)];
  const contact = parseContact(contactLines);
  for (const u of contact.unread) warnings.push(`A line near your name was not read into the profile: "${u}".`);
  if (!contact.name) warnings.push('Your name was not found at the top of the file. Type it in your profile.');
  if (!contact.email) warnings.push('No email address was found.');

  const work: WorkEntry[] = [];
  const education: EducationEntry[] = [];
  const projects: ProjectEntry[] = [];
  const certifications: ProfileInput['certifications'] = [];
  const skills: SkillEntry[] = [];
  const extraSections: ExtraSection[] = [];
  const summaries: string[] = [];
  let sourceBullets = 0;

  for (const s of sections) {
    const nonEmpty = s.lines.filter((l) => l.text.trim());
    switch (s.kind) {
      case 'contact':
        break;
      case 'summary': {
        const flags = bulletFlags(nonEmpty);
        const paras: string[] = [];
        nonEmpty.forEach((l, i) => {
          if (paras.length && !flags[i] && !l.bullet && l.gapAbove < 0.6) paras[paras.length - 1] = joinWrapped(paras[paras.length - 1]!, l.text.trim());
          else paras.push(l.text.trim());
        });
        summaries.push(paras.join(' '));
        break;
      }
      case 'experience': {
        const { entries, orphans } = groupEntries(nonEmpty, { dated: true });
        sourceBullets += entries.reduce((n, e) => n + e.bullets.length, 0);
        if (orphans) warnings.push(`${s.title}: ${orphans === 1 ? 'some bullets were' : 'some bullets were'} found before any job heading; they are kept in the first entry. Check them.`);
        entries.forEach((e) => work.push(parseWorkEntry(e, work.length, warnings)));
        break;
      }
      case 'education': {
        const { entries } = groupEntries(nonEmpty, { dated: true });
        // A school on one line and the degree on the next, with no bullets, is one entry, not two.
        const merged: Entry[] = [];
        for (const e of entries) {
          const prev = merged[merged.length - 1];
          const txt = e.head.map((l) => l.text).join(' ');
          const prevTxt = prev?.head.map((l) => l.text).join(' ') ?? '';
          const prevHasSchool = /\b(?:University|College|Institute|School|Academy)\b/.test(prevTxt);
          const thisHasSchool = /\b(?:University|College|Institute|School|Academy)\b/.test(txt);
          if (prev && !prev.bullets.length && (prevHasSchool !== thisHasSchool) && !(prev.hasDate && e.hasDate)) {
            prev.head.push(...e.head); prev.bullets.push(...e.bullets); prev.hasDate ||= e.hasDate;
          } else merged.push(e);
        }
        sourceBullets += merged.reduce((n, e) => n + e.bullets.length, 0);
        merged.forEach((e) => education.push(parseEducationEntry(e, education.length, warnings)));
        break;
      }
      case 'skills':
        for (const n of parseSkills(nonEmpty)) if (!skills.some((x) => x.name.toLowerCase() === n.toLowerCase())) skills.push({ name: n, years: null, source: 'resume' });
        break;
      case 'projects': {
        const { entries } = groupEntries(nonEmpty, { dated: false });
        // Projects rarely have dates: each non-bullet line after bullets starts a new project.
        sourceBullets += entries.reduce((n, e) => n + e.bullets.length, 0);
        entries.forEach((e) => projects.push(parseProjectEntry(e, projects.length)));
        break;
      }
      case 'certifications':
        certifications.push(...parseCerts(nonEmpty));
        break;
      default: {
        unreadSections.push(s.title);
        const linesOut = nonEmpty.map((l) => l.text.trim());
        if (linesOut.length) extraSections.push({ id: stableId('x', s.title), title: s.title, lines: linesOut });
      }
    }
  }
  if (unreadSections.length) warnings.push(`jobleft has no profile field for: ${unreadSections.join(', ')}. ${unreadSections.length === 1 ? 'It is' : 'They are'} kept word for word as ${unreadSections.length === 1 ? 'a section' : 'sections'} of your resume. Check ${unreadSections.length === 1 ? 'it' : 'them'} in your profile.`);
  if (!work.length) warnings.push('No work history was found. If the file has jobs, their section heading was not recognised: add them in your profile.');
  if (!education.length) warnings.push('No education was found.');
  if (!skills.length) warnings.push('No skills section was found.');
  for (const w of work) if (w.startDate && w.endDate && w.endDate < w.startDate) warnings.push(`${w.company}: the end date is before the start date. Check the dates.`);

  const profile: ProfileInput = {
    personal: {
      firstName: null, middleName: null, lastName: null, email: contact.email, phone: contact.phone, addressLine: null,
      city: contact.city, region: contact.region, postalCode: null, country: contact.region && isUsState(contact.region) ? 'US' : null, links: contact.links,
    },
    summary: summaries.length ? summaries.join('\n\n') : null,
    education, work, projects, certifications, skills,
    preferences: {
      jobFunctions: [], targetTitles: [], employmentTypes: [], workModels: [], levels: [], countries: [], places: [], minAnnualPayUsd: null,
      industries: [], companyStages: [], roleTypes: [], excludedCompanies: [],
    },
    workAuthorization: { usAuthorized: null, needsSponsorship: null, usCitizen: null, hasSecurityClearance: null, authorizedCountries: [] },
    eeo: { disability: null, veteran: null, gender: null, lgbtq: null, race: null, hispanicOrLatino: null, sexualOrientation: [], pronouns: null },
    extraSections,
  };
  if (contact.name) {
    const parts = contact.name.split(/\s+/);
    profile.personal.firstName = parts[0]!;
    if (parts.length > 1) profile.personal.lastName = parts[parts.length - 1]!;
    if (parts.length > 2) profile.personal.middleName = parts.slice(1, -1).join(' ');
  }
  // Bullets as the file shows them (under jobs, degrees and projects; a "GPA: 3.7" bullet counts too).
  const bullets = sourceBullets;
  return { profile, unreadSections, warnings, counts: { jobs: work.length, bullets, skills: skills.length, education: education.length } };
}
