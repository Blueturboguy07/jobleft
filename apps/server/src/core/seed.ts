// First-run board choice (i-core). When the person finishes the preference step and has no boards yet, jobleft adds
// a starting set of employer boards and starts the first crawl at once. Every board below is a row of the boards
// lane's directory with status "live" (checked against the provider), except medcarepediatric and lifestance
// (directory status "unverified"; both answered with open postings on 2026-09-25). The set spans fields (health care, education,
// retail and food, finance, operations and trades, sales, software), so people outside software find their field.
// Boards of the field the person picked come first, so their jobs arrive first.
//
// JOBLEFT_SEED_BOARDS: `none` = add nothing (mock runs); a path to a JSON file `[{ ats, board, company?, region? }]`
// = use exactly those boards (a stranger's mock boards). JOBLEFT_SEED_LIMIT: how many boards (default 120, at most 400).
// After the curated lists, the set is filled from the board directory's "live" rows (checked against the provider),
// spread evenly across providers, in a fixed order, so the first feed draws on more employers than a few large ones
// (the founder's review on 2026-09-27 found 39 employers and one of them with 1,799 of 11,893 jobs).
//
// Country lists (SEED_BY_COUNTRY): the curated lists and the directory are almost all US employers. A person whose
// places are only countries with a list of their own gets just that list (US boards would bury the local jobs). A
// person who also names other places gets the country list first, then the same set as before. Anyone else, the same
// set as before.

import { readFileSync } from 'node:fs';
import type { CrawlAtsId, JobPreferences } from '@jobleft/contracts';
import { loadActiveDirectory } from '@jobleft/boards';

export type Field = 'health' | 'education' | 'retail' | 'finance' | 'operations' | 'sales' | 'software';
export interface SeedBoard { ats: CrawlAtsId; board: string; company: string; region?: string }

const g = (board: string, company: string): SeedBoard => ({ ats: 'greenhouse', board, company });
const l = (board: string, company: string): SeedBoard => ({ ats: 'lever', board, company });
const a = (board: string, company: string): SeedBoard => ({ ats: 'ashby', board, company });
const r = (board: string, company: string): SeedBoard => ({ ats: 'recruitee', board, company });
const p = (board: string, company: string): SeedBoard => ({ ats: 'personio', board, company });

/**
 * Employer boards with open jobs in the country, checked against each provider's public API on 2026-10-10 (every
 * board listed jobs located in the country that day). Security companies first, then tech and finance.
 */
export const SEED_BY_COUNTRY: Record<string, SeedBoard[]> = {
  NL: [
    a('eye-security', 'Eye Security'), r('northwave', 'Northwave'), r('on2it', 'ON2IT'), r('nomios', 'Nomios'), r('tesorion', 'Tesorion'),
    g('sentinellabs', 'SentinelOne'), g('wizinc', 'Wiz'), g('netskope', 'Netskope'), r('intigriti', 'Intigriti'), g('elastic', 'Elastic'),
    a('snyk', 'Snyk'), g('kaseya', 'Kaseya'),
    g('nebius', 'Nebius'), g('adyen', 'Adyen'), g('imc', 'IMC Trading'), g('catawiki', 'Catawiki'), g('bolcom', 'bol'), a('mollie', 'Mollie'),
    g('flowtraders', 'Flow Traders'), r('cmcom', 'CM.com'), r('bunq', 'bunq'), { ats: 'lever', board: 'tomtom', company: 'TomTom', region: 'eu' },
    g('celonis', 'Celonis'), r('effectory', 'Effectory'), r('nmbrs', 'Nmbrs'), r('channable', 'Channable'), l('bloomon', 'Bloomon'),
    p('ohpen', 'Ohpen'), a('polarsteps', 'Polarsteps'), g('ebury', 'Ebury'), g('grafanalabs', 'Grafana Labs'), a('miro', 'Miro'),
    g('mongodb', 'MongoDB'), a('sentry', 'Sentry'), g('workato', 'Workato'),
    // US companies with large Dutch offices (they also list jobs in the Netherlands).
    g('databricks', 'Databricks'), g('datadog', 'Datadog'), g('flexport', 'Flexport'), g('gitlab', 'GitLab'),
  ],
};

/** A place named in words: the country it is in, when it has a list (cities and the country's own names). */
const PLACE_COUNTRY: Array<[string, RegExp]> = [
  ['NL', /netherlands|nederland|holland|amsterdam|rotterdam|utrecht|den haag|the hague|eindhoven|groningen|leiden|delft|haarlem|nijmegen|arnhem|breda|tilburg|zwolle|amersfoort/i],
];

/** The countries a person's places point at: the country codes, and the countries of places named in words. */
export function countriesFor(prefs: Pick<JobPreferences, 'countries' | 'places'>): { codes: string[]; onlyListed: boolean } {
  const codes = new Set(prefs.countries.map((c) => c.toUpperCase()));
  let unknownPlace = false;
  for (const pl of prefs.places) {
    const hit = PLACE_COUNTRY.find(([, re]) => re.test(pl.text));
    if (hit) codes.add(hit[0]); else unknownPlace = true;
  }
  const list = [...codes];
  return { codes: list, onlyListed: list.length > 0 && !unknownPlace && list.every((c) => SEED_BY_COUNTRY[c]) };
}

export const SEED: Record<Field, SeedBoard[]> = {
  health: [
    l('medcarepediatric', 'MedCare Pediatric'), g('careaccess', 'Care Access'), g('ecpcareers', 'Eye Care Partners'), l('lifestance', 'LifeStance Health'),
    g('cortica', 'Cortica'), g('evergreennephrology', 'Evergreen Nephrology'), g('charliehealthbehavioralhealthoperations', 'Charlie Health'),
    g('amwell', 'Amwell'), g('hopscotchprimarycare', 'Hopscotch Primary Care'), l('lunaphysicaltherapy', 'Luna Physical Therapy'),
    l('ppfa', 'Planned Parenthood Federation of America'), l('paramedicservices', 'Paramedic Services of Illinois'),
    g('cloverhealth', 'Clover Health'), g('bouldercare', 'Boulder Care'), l('everlywell', 'Everlywell'), g('daybreakhealth', 'Daybreak Health'),
    g('galileo', 'Galileo'),
  ],
  education: [
    g('guidepostmontessori', 'Guidepost Montessori'), g('brookecharterschools', 'Brooke Charter Schools'), g('appletreeprep', 'AppleTree Prep'),
    l('riverdale', 'Riverdale Country School'), l('intrepidcollegeprep', 'Intrepid College Prep Schools'), l('lionheartkid', 'Lionheart Children\'s Academy'),
    a('ignite-reading', 'Ignite Reading'), g('edmentum', 'Edmentum'), g('coursera', 'Coursera'),
  ],
  retail: [
    l('bluebottlecoffee', 'Blue Bottle Coffee'), g('blankstreet', 'Blank Street'), g('everlane', 'Everlane'), g('aloyoga', 'ALO'),
    g('glossier', 'Glossier'), g('gymshark', 'Gymshark'), g('bombas', 'Bombas'), g('hondasantamonica', 'Honda Santa Monica'),
    g('breezeairways', 'Breeze Airways'), g('bozzuto', 'Bozzuto'), g('cottonwoodresidential', 'Cottonwood Residential'),
  ],
  finance: [
    l('bannerbank', 'Banner Bank'), g('robinhood', 'Robinhood'), g('chime', 'Chime'), g('affirm', 'Affirm'), g('betterment', 'Betterment'),
    g('gcmgrosvenor', 'GCM Grosvenor'), g('btig27', 'BTIG'), g('hippo70', 'Hippo Insurance'), g('cottinghambutlerinsuranceservicesinc', 'Cottingham & Butler'),
    g('carta', 'Carta'),
  ],
  operations: [
    g('equipmentsharecom', 'EquipmentShare'), g('carvana', 'Carvana'), g('doordashusa', 'DoorDash'), g('cityoffortworth', 'The City of Fort Worth'),
    g('buildops', 'BuildOps'), g('housecall', 'Housecall Pro'), g('flexport', 'Flexport'), l('loadsmart', 'Loadsmart'), g('instacart', 'Instacart'),
    g('ergeon', 'Ergeon'), a('traba', 'Traba'), g('evolvevacationrental', 'Evolve'),
  ],
  sales: [
    g('apolloio', 'Apollo.io'), g('gongio', 'Gong'), g('exactsales', 'Exact Sales'), g('braze', 'Braze'), g('attentive', 'Attentive'),
    g('forbes', 'Forbes'), g('axios', 'Axios'),
  ],
  software: [
    g('stripe', 'Stripe'), g('airbnb', 'Airbnb'), g('datadog', 'Datadog'), g('databricks', 'Databricks'), g('cloudflare', 'Cloudflare'),
    g('gitlab', 'GitLab'), g('figma', 'Figma'), g('discord', 'Discord'), g('dropbox', 'Dropbox'), g('okta', 'Okta'), g('pinterest', 'Pinterest'),
    g('vercel', 'Vercel'), a('zapier', 'Zapier'), a('vanta', 'Vanta'), l('palantir', 'Palantir Technologies'), g('coinbase', 'Coinbase'),
  ],
};

const FIELD_WORDS: Array<[Field, RegExp]> = [
  ['health', /nurs|\brn\b|\blpn\b|health|medical|clinic|therap|pharm|physician|dental|care|patient|hospice|caregiver/i],
  ['education', /teach|educat|tutor|school|instruct|academ|professor|curriculum/i],
  ['retail', /retail|store|barista|restaurant|hospitality|cashier|merchandis|food|hotel|guest/i],
  ['finance', /financ|account|bank|audit|tax|insur|underwrit|invest|analyst|treasur|credit/i],
  ['operations', /operat|logistic|warehouse|driver|technician|electric|mechanic|construct|supply|trade|plumb|hvac|field|facilit/i],
  ['sales', /sales|account exec|business develop|marketing|customer success|recruit/i],
  ['software', /software|engineer|developer|backend|back-end|frontend|full.?stack|data|devops|\bswe\b|product|design|security|it\b/i],
];

/** The fields a person's preference words point at, most specific first. */
export function fieldsFor(prefs: Pick<JobPreferences, 'jobFunctions' | 'targetTitles'>): Field[] {
  const words = [...prefs.jobFunctions, ...prefs.targetTitles].join(' ; ');
  const out: Field[] = [];
  for (const [f, re] of FIELD_WORDS) if (re.test(words) && !out.includes(f)) out.push(f);
  return out;
}

/**
 * The starting boards: every board of the person's fields first (at most 60% of the limit), then the other fields in
 * turn, so the set always spans several fields and at least 25 employers.
 */
export function seedBoards(prefs: Pick<JobPreferences, 'jobFunctions' | 'targetTitles'> & Partial<Pick<JobPreferences, 'countries' | 'places'>>, env: NodeJS.ProcessEnv = process.env): SeedBoard[] {
  const spec = (env.JOBLEFT_SEED_BOARDS ?? '').trim();
  if (spec === 'none') return [];
  if (spec) {
    const list = JSON.parse(readFileSync(spec, 'utf8')) as Array<Partial<SeedBoard>>;
    return list.filter((b) => typeof b.ats === 'string' && typeof b.board === 'string')
      .map((b) => ({ ats: b.ats as CrawlAtsId, board: b.board!, company: b.company || b.board!, ...(b.region ? { region: b.region } : {}) }));
  }
  const limit = Math.max(1, Math.min(400, Number.parseInt(env.JOBLEFT_SEED_LIMIT ?? '', 10) || 120));
  const preferred = fieldsFor(prefs);
  const out: SeedBoard[] = [];
  const seen = new Set<string>();
  const push = (b: SeedBoard) => { const k = `${b.ats}:${b.board}`; if (!seen.has(k) && out.length < limit) { seen.add(k); out.push(b); } };
  // The person's countries with a list of their own come first.
  const where = countriesFor({ countries: prefs.countries ?? [], places: prefs.places ?? [] });
  for (const c of where.codes) for (const b of SEED_BY_COUNTRY[c] ?? []) push(b);
  // Only listed countries: nothing more (the field lists and the directory are US employers).
  if (where.onlyListed) return out;
  const firstShare = Math.max(out.length, Math.floor(limit * 0.6));
  // Preferred fields, interleaved, up to 60% of the set.
  const prefLists = preferred.map((f) => [...SEED[f]]);
  while (out.length < firstShare && prefLists.some((x) => x.length)) for (const x of prefLists) { const b = x.shift(); if (b && out.length < firstShare) push(b); }
  // Then every field in turn.
  const rest = (Object.keys(SEED) as Field[]).map((f) => SEED[f].filter((b) => !seen.has(`${b.ats}:${b.board}`)));
  while (out.length < limit && rest.some((x) => x.length)) for (const x of rest) { const b = x.shift(); if (b) push(b); }
  // Then the directory's live boards, one provider at a time, in slug order (the same set on every fresh install).
  if (out.length < limit) {
    let entries: Array<{ ats: string; board: string; company: string; region?: string | null; status: string }> = [];
    try { entries = loadActiveDirectory({ home: env.JOBLEFT_HOME ?? null, env }).entries; } catch { entries = []; }
    const byAts = new Map<string, SeedBoard[]>();
    for (const e of entries) {
      if (e.status !== 'live' || seen.has(`${e.ats}:${e.board}`)) continue;
      const list = byAts.get(e.ats) ?? [];
      list.push({ ats: e.ats as CrawlAtsId, board: e.board, company: e.company, ...(e.region ? { region: e.region } : {}) });
      byAts.set(e.ats, list);
    }
    const lists = [...byAts.keys()].sort().map((k) => byAts.get(k)!.sort((x, y) => x.board.localeCompare(y.board)));
    while (out.length < limit && lists.some((x) => x.length)) for (const x of lists) { const b = x.shift(); if (b) push(b); }
  }
  return out;
}
