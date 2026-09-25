// Hacker News "Ask HN: Who is hiring?" through the public HN Search API by Algolia.
//   1. search_by_date for stories by the "whoishiring" account; keep only titles "Ask HN: Who is hiring? (Month Year)"
//      (never "Who wants to be hired?", which holds job seekers' personal data)
//   2. items/<story id>: the whole thread in one answer; each top-level comment is one posting
// A comment is a posting only when its first line is split by "|" (the format the thread asks for). Facts come from
// that line; anything it does not say stays unknown. Notes and the terms question: docs/sources/hn-whoishiring.md.

import type { EmploymentType, Place, WorkModel } from '@jobleft/contracts';
import { decodeEntities, htmlToText } from '@jobleft/parsers';
import type { FeedContext, FeedPosting, FeedResult, JobFeed } from '../types.ts';
import { FeedError, parseJsonBody, shapeError } from '../http.ts';
import { clip, countryCode, employmentTypeOf, parseRemoteScope, payFromText, placeFromText, safeHttpUrl, scopeOpenToUs } from '../text.ts';
import { HOUR, arr, countriesOf, creditFor, emptyFacts, ev, isoFrom, obj, rawJob, result, str } from './common.ts';

export const HN_SEARCH_URL = 'https://hn.algolia.com/api/v1/search_by_date?tags=story%2Cauthor_whoishiring&hitsPerPage=10';
export const hnItemUrl = (id: string | number): string => `https://hn.algolia.com/api/v1/items/${encodeURIComponent(String(id))}`;
export const hnPostUrl = (id: string | number): string => `https://news.ycombinator.com/item?id=${encodeURIComponent(String(id))}`;
export const HN_TITLE = /^Ask HN: Who is hiring\? \(([A-Z][a-z]+) (\d{4})\)$/;
export const HN_CREDIT = creditFor('From the monthly "Ask HN: Who is hiring?" thread on Hacker News', 'https://news.ycombinator.com/submitted?id=whoishiring');

export interface HnThreadRef { id: string; title: string; createdAt: string | null }

/** The newest "Ask HN: Who is hiring? (Month Year)" story in a search answer, or null. */
export function pickHiringThread(data: unknown): HnThreadRef | null {
  const hits = arr(obj(data)?.hits);
  if (!hits) throw shapeError('the search answer has no "hits" list');
  let best: { ref: HnThreadRef; t: number } | null = null;
  for (const h of hits) {
    const o = obj(h);
    if (!o) continue;
    const title = str(o.title).trim();
    if (str(o.author) !== 'whoishiring' || !HN_TITLE.test(title)) continue;
    const id = str(o.objectID ?? o.story_id).trim();
    if (!/^\d+$/.test(id)) continue;
    const t = typeof o.created_at_i === 'number' ? o.created_at_i * 1000 : Date.parse(str(o.created_at));
    if (!best || (Number.isFinite(t) && t > best.t)) best = { ref: { id, title, createdAt: Number.isFinite(t) ? new Date(t).toISOString() : null }, t: Number.isFinite(t) ? t : 0 };
  }
  return best?.ref ?? null;
}

const ROLE = /\b(engineers?|engineering|developers?|devs?|swes?|sres?|devops|scientists?|research(ers?)?|designers?|design|managers?|director|lead|head of|architects?|analysts?|administrators?|specialists?|consultants?|operators?|operations|product|pm|marketing|sales|account executives?|recruiters?|writers?|interns?|internships?|staff|mts|founding|cto|vp|roles?|positions?|openings?|technicians?|support|success|counsel|accountants?|nurses?|coordinators?|associates?|programmers?|ml|machine learning|data|security|qa|testers?|full[- ]?stack|front[- ]?end|back[- ]?end|mobile|ios|android|hardware|firmware|embedded|robotics|co-?founder|ceo|cfo|coo)\b/i;
const WORK = /\b(remote|remotely|onsite|on-site|on site|in[- ]office|in[- ]person|hybrid|office)\b/i;
const TYPE = /\b(full[- ]?time|part[- ]?time|contract|contractor|intern(ship)?s?|freelance|permanent|temporary)\b/i;
const PAY = /[$€£]\s?\d|\b\d+(\.\d+)?\s?[kK]\b|\b(usd|eur|gbp|cad|salary|equity)\b/i;
const VISA = /\bvisa\b|sponsor/i;
const URLISH = /https?:\/\/|^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i;
const PLACE_HINT = /,|\b(sf|nyc|ny|la|bay area|london|berlin|paris|amsterdam|toronto|vancouver|montreal|seattle|boston|austin|chicago|denver|boulder|miami|atlanta|dallas|houston|portland|san francisco|new york|los angeles|san diego|palo alto|mountain view|menlo park|sunnyvale|oakland|brooklyn|dublin|munich|zurich|stockholm|copenhagen|oslo|helsinki|madrid|barcelona|lisbon|warsaw|prague|vienna|tel aviv|singapore|tokyo|sydney|melbourne|bangalore|bengaluru|remote)\b/i;

function plain(html: string): string {
  return decodeEntities(html.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function linksOf(html: string): string[] {
  const out: string[] = [];
  const re = /href\s*=\s*"([^"]+)"|href\s*=\s*'([^']+)'/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const u = safeHttpUrl(decodeEntities(m[1] ?? m[2] ?? ''));
    if (u && !out.includes(u)) out.push(u);
  }
  return out;
}

const APPLY_HINT = /(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|recruitee\.com|personio\.(de|com)|breezy\.hr|bamboohr\.com|teamtailor\.com|jobs\.|careers?\.|\/careers?\b|\/jobs?\b|\/join\b|\/hiring\b|\/positions?\b|\/openings?\b|\/apply\b|work-?with-?us|workatastartup\.com)/i;

function cleanCompany(seg: string): string {
  return seg
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\((?:[^)]*\b(?:YC|yc|Series|series|seed|Seed|funded|backed|acquired)\b[^)]*|https?:[^)]*|[a-z0-9-]+(?:\.[a-z0-9-]+)+[^)]*)\)/g, ' ')
    .replace(/^[*_\s]+|[*_\s,:;.-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function placesOf(seg: string): Place[] {
  const out: Place[] = [];
  const s = seg.replace(/\((?:[^()]*)\)/g, (m) => (/[A-Z][a-z]|,/.test(m) ? ` ; ${m.slice(1, -1)} ; ` : ' '));
  for (const part of s.split(/\s\/\s|\/(?=\s*[A-Z])|;|\bor\b|\band\b|\s\+\s/)) {
    const p = placeFromText(part.replace(/\b(onsite|on-site|on site|hybrid|in[- ]office|in[- ]person|preferred|preferably|only|office|offices|required|metros?|area)\b/gi, ' ').replace(/[-–—]\s*$/,'').trim());
    if (p && p.text.length >= 2 && p.text.length <= 80 && !ROLE.test(p.text) && !TYPE.test(p.text) && !PAY.test(p.text)) out.push(p);
  }
  return out;
}

/** Facts of one top-level comment, or null when it is not a posting by the thread's format. Pure. */
export function parseHnComment(c: Record<string, unknown>, thread: HnThreadRef, now: number): FeedPosting | null {
  const id = str(c.id).trim();
  const html = str(c.text);
  if (!/^\d+$/.test(id) || !html.trim()) return null;
  const firstHtml = html.split(/<p>/i)[0] ?? '';
  const header = plain(firstHtml);
  const segs = header.split('|').map((s) => s.trim()).filter(Boolean);
  if (segs.length < 2) return null;
  const company = cleanCompany(segs[0]!);
  // A first segment that is a sentence ("We're building ...") is not a company name.
  if (!company || company.length > 80 || /^(we|we're|we are|i|i'm|our|hi|hello)\b/i.test(company)) return null;
  const facts = emptyFacts();
  let title: string | null = null;
  let remote = false, hybrid = false, onsite = false;
  const workSegs: string[] = [];
  const places: Place[] = [];
  let et: EmploymentType | null = null;
  for (const seg of segs.slice(1)) {
    const noUrl = seg.replace(/https?:\/\/\S+/g, ' ').trim();
    if (!noUrl || URLISH.test(seg.trim())) continue;
    if (WORK.test(noUrl)) {
      workSegs.push(noUrl);
      if (/\bremote(ly)?\b/i.test(noUrl)) remote = true;
      if (/\bhybrid\b/i.test(noUrl)) hybrid = true;
      if (/\b(onsite|on-site|on site|in[- ]office|in[- ]person)\b/i.test(noUrl)) onsite = true;
      places.push(...placesOf(noUrl));
      continue;
    }
    if (!et && TYPE.test(noUrl) && !ROLE.test(noUrl.replace(TYPE, ''))) { et = employmentTypeOf(noUrl); continue; }
    if (!title && ROLE.test(noUrl) && !PAY.test(noUrl.replace(/\b(data|ml)\b/gi, '')) && !VISA.test(noUrl)) { title = clip(noUrl, 150); continue; }
    if (PAY.test(noUrl) || VISA.test(noUrl)) continue;
    if (PLACE_HINT.test(noUrl) || countryCode(noUrl)) places.push(...placesOf(noUrl));
  }
  let workModel: WorkModel | null = null;
  if (remote && !hybrid && !onsite) workModel = 'remote';
  else if (hybrid && !remote) workModel = 'hybrid';
  else if (onsite && !remote && !hybrid) workModel = 'onsite';
  facts.workModel = workModel;
  if (workSegs.length) facts.evidence.workModel = ev('description', workSegs.join(' | '));
  if (remote) {
    const words = workSegs.filter((s) => /\bremote/i.test(s)).join('; ');
    const scope = parseRemoteScope(words);
    if (scope) { facts.remoteScope = scope; facts.evidence.remoteScope = ev('description', words); }
  }
  facts.places = places;
  if (places.length) facts.evidence.places = ev('description', header);
  const countries = places.map((p) => p.country).filter((x): x is string => Boolean(x));
  const scopeUs = scopeOpenToUs(facts.remoteScope);
  facts.isUs = scopeUs === true || countries.includes('US') ? true : scopeUs === false || (countries.length > 0 && countries.length === places.length) ? false : null;
  if (et) { facts.employmentType = et; facts.evidence.employmentType = ev('description', header); }
  const pay = payFromText(header) ?? payFromText(htmlToText(html));
  if (pay) { facts.pay = pay; facts.evidence.pay = ev('description', header); }
  facts.postedAt = isoFrom(c.created_at, now) ?? isoFrom(c.created_at_i, now);
  const apply = linksOf(html).find((u) => APPLY_HINT.test(u) && !/news\.ycombinator\.com/i.test(u)) ?? null;
  const url = hnPostUrl(id);
  return {
    sourceUrl: url,
    facts,
    credit: creditFor(`Posted in "${thread.title}" on Hacker News`, hnPostUrl(thread.id)),
    raw: rawJob({
      externalId: id, url, applyUrl: apply ?? '', title: title ?? `Open roles at ${company}`, company,
      location: places.map((p) => p.text).join('; ') || (facts.remoteScope?.text ?? ''), descriptionHtml: html,
      remote: workModel === 'remote', workMode: workModel ?? '', countries: countriesOf(facts), postedAt: facts.postedAt,
      employmentType: et ?? '',
    }),
  };
}

/** Maps a thread answer (items/<id>). Pure. */
export function parseHnThread(data: unknown, thread: HnThreadRef, now: number): FeedResult {
  const root = obj(data);
  const children = root ? arr(root.children) : null;
  if (!root || !children) throw shapeError('the thread answer has no "children" list');
  const title = str(root.title).trim();
  if (str(root.id) !== thread.id || !HN_TITLE.test(title)) throw shapeError('the thread answer is not the "Who is hiring?" story that was asked for');
  const postings: FeedPosting[] = [];
  let skipped = 0;
  for (const ch of children) {
    const c = obj(ch);
    if (!c) { skipped++; continue; }
    const p = parseHnComment(c, { ...thread, title }, now);
    if (p) postings.push(p); else skipped++;
  }
  return result(postings, { complete: true, skipped, notes: [`thread "${title}": ${postings.length} postings in the "Company | Role | Place" format, ${skipped} other comments skipped`] });
}

export const hnWhoIsHiring: JobFeed = {
  id: 'hn-whoishiring',
  info: {
    id: 'hn-whoishiring',
    name: 'Hacker News: Who is hiring?',
    kind: 'community',
    crawled: true,
    reason: null,
    checkedOn: '2026-09-25',
    evidenceUrl: 'https://github.com/HackerNews/API',
    needsKey: false,
    credit: HN_CREDIT,
    limits: 'The newest monthly thread only; at most 2 refreshes a day, at least 6 hours apart, 2 requests each',
  },
  credit: HN_CREDIT,
  limits: { minIntervalMs: 6 * HOUR, maxPerDay: 2 },
  storable: true,
  hosts: ['hn.algolia.com'],
  requestLimits: { perRun: 6, perDay: 12 },
  async fetch(ctx: FeedContext): Promise<FeedResult> {
    const thread = pickHiringThread(parseJsonBody(await ctx.http.getText(HN_SEARCH_URL, 'application/json'), 'hn.algolia.com'));
    if (!thread) throw new FeedError('shape', 'the data format changed: no "Ask HN: Who is hiring?" thread was found');
    const body = await ctx.http.getText(hnItemUrl(thread.id), 'application/json');
    return parseHnThread(parseJsonBody(body, 'hn.algolia.com'), thread, ctx.now);
  },
};
