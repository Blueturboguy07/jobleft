// Plain-text output of the CLI. The JSON output (--json) is the full record; this is the readable view.

import type { DatasetInfo, PlaceLookup } from '@jobleft/contracts';
import { humanDate, type H1bLookupDetail } from './h1b/index.ts';

export function formatH1b(r: H1bLookupDetail, ds: DatasetInfo): string {
  const lines: string[] = [];
  lines.push(`${r.input}  ->  company key "${r.companyKey ?? ''}"`);
  if (r.status !== 'found' || !r.summary) {
    lines.push(`Status: unknown. ${r.reason ?? ''}`.trim());
    lines.push(`Data: ${ds.name}, version ${ds.version}${ds.dataThrough ? `, filings through ${humanDate(ds.dataThrough)}` : ''}.`);
    if (ds.lastUpdateError) lines.push(`Warning: ${ds.lastUpdateError}`);
    return lines.join('\n');
  }
  const s = r.summary;
  lines.push(`Status: found. Tag: "${s.label}" (${s.status})`);
  lines.push(`  ${s.certifiedFilings.toLocaleString('en-US')} certified H-1B filings from ${humanDate(s.window.from)} to ${humanDate(s.window.to)} (data through ${humanDate(s.dataThrough)})`);
  lines.push(`  Newest 12 months of the data (${humanDate(s.recentWindow.from)} to ${humanDate(s.recentWindow.to)}): ${s.recentFilings.toLocaleString('en-US')}`);
  lines.push(`  New hires or transfers: ${s.newHireFilings.toLocaleString('en-US')}. Filings at a client's site: ${Math.round(s.clientSiteShare * 100)}%`);
  lines.push(`  By US federal fiscal year (Oct 1 to Sep 30): ${s.byYear.map((y) => `FY${y.year} ${y.count.toLocaleString('en-US')}${y.partial ? ' (partial year: data ends before Sep 30)' : ''}`).join('; ')}`);
  if (s.roleFamily) lines.push(`  Similar roles (${s.roleFamily}): ${Math.round((s.similarRoleShare ?? 0) * 100)}% of these filings`);
  lines.push(`  Legal filers behind these numbers (EMPLOYER_NAME and FEIN in the public file):`);
  for (const e of s.entities) {
    lines.push(`    ${String(e.certifiedFilings).padStart(6)}  ${e.name}  [FEIN ${e.fein ?? 'none'}]  ${[e.city, e.state].filter(Boolean).join(', ')}`);
    lines.push(`            per file: ${e.byFile.map((f) => `${f.file.replace(/^LCA_Disclosure_Data_|\.xlsx$/g, '')} ${f.count}`).join(', ')}`);
  }
  if (s.excludedEntities.length) {
    lines.push(`  Left out (same name, different company):`);
    for (const e of s.excludedEntities) lines.push(`    ${String(e.certifiedFilings).padStart(6)}  ${e.name}  [FEIN ${e.fein ?? 'none'}]  ${[e.city, e.state].filter(Boolean).join(', ')}`);
  }
  lines.push(`  Matched by: ${s.matchedBy === 'alias' ? `reviewed alias (${s.aliasBasis})` : s.matchedBy === 'trade_name' ? 'a trade name ("doing business as") in the filings' : 'the legal employer name'}`);
  lines.push(`  Counting: ${s.counting}`);
  lines.push(`  Rule: ${s.statusRule}`);
  lines.push(`  Source: ${s.source} (${s.sourceUrl})`);
  lines.push(`  Note: ${s.note}`);
  if (ds.lastUpdateError) lines.push(`Warning: ${ds.lastUpdateError}`);
  return lines.join('\n');
}

export function formatDatasets(list: DatasetInfo[]): string {
  const lines: string[] = [];
  for (const d of list) {
    lines.push(`${d.name}`);
    lines.push(`  id ${d.id}, version ${d.version}${d.dataThrough ? `, data through ${d.dataThrough}` : ''}, ${d.bytes.toLocaleString('en-US')} bytes, updated ${d.updatedAt}`);
    lines.push(`  licence: ${d.licence}`);
    if (d.attribution) lines.push(`  attribution: ${d.attribution}`);
    if (d.sourceUrl) lines.push(`  source: ${d.sourceUrl}`);
    if (d.lastUpdateError) lines.push(`  LAST UPDATE ERROR: ${d.lastUpdateError}`);
  }
  return lines.join('\n');
}

export function formatPlace(r: PlaceLookup & { notes?: string[] }): string {
  const lines: string[] = [`${r.input}`];
  const fmt = (p: PlaceLookup['places'][number]) => {
    const where = [p.city, p.region, p.country].filter(Boolean).join(', ') || '(no place)';
    const coords = p.lat !== undefined && p.lon !== undefined ? `  (${p.lat.toFixed(4)}, ${p.lon.toFixed(4)})` : '';
    return `${where}  [placeId ${p.placeId ?? 'none'}]${coords}  from "${p.text}"`;
  };
  if (r.places.length === 0) lines.push('  resolved: nothing (shown as written)');
  for (const p of r.places) lines.push(`  place: ${fmt(p)}`);
  for (const p of r.ambiguous) lines.push(`  could also mean: ${fmt(p)}`);
  lines.push(`  notACity: ${r.notACity}`);
  for (const n of r.notes ?? []) lines.push(`  note: ${n}`);
  return lines.join('\n');
}

export function formatCompany(c: import('./facts/company-facts.ts').CompanyDetail, requests: number): string {
  const lines: string[] = [`${c.name}  (company key "${c.key}")`];
  const f = c.facts as Record<string, { value: unknown; source: { name: string; url: string | null; retrievedAt: string } } | undefined>;
  const order = ['description', 'founded', 'headquarters', 'size', 'industries', 'website', 'stage', 'totalFundingUsd', 'investors', 'leaders', 'news'];
  const show = (v: unknown): string => {
    if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' && x ? Object.values(x as Record<string, unknown>).filter(Boolean).join(', ') : String(x))).join('; ');
    if (typeof v === 'number' && v > 100000) return `$${v.toLocaleString('en-US')}`;
    return String(v);
  };
  for (const k of order) {
    const fact = f[k];
    lines.push(fact ? `  ${k.padEnd(16)} ${show(fact.value)}\n  ${''.padEnd(16)} source: ${fact.source.name}${fact.source.url ? ` <${fact.source.url}>` : ''}, read ${fact.source.retrievedAt}` : `  ${k.padEnd(16)} not found`);
  }
  lines.push(`  H-1B: ${c.h1b ? `${c.h1b.status === 'likely' ? 'H-1B sponsor likely' : 'Some H-1B history'}, ${c.h1b.certifiedFilings.toLocaleString('en-US')} certified filings through ${c.h1b.dataThrough}` : 'unknown (not found in the filing data; not ruled out)'}`);
  lines.push(`  Staffing agency: ${c.isStaffingAgency === true ? 'yes (most H-1B filings place workers at client sites)' : 'unknown'}`);
  lines.push(`  Kept until: ${c.factsFreshUntil ?? 'nothing kept yet'}; last read: ${c.factsStatus.fetchedAt ?? 'never'}${c.factsStatus.lastError ? `\n  Last error: ${c.factsStatus.lastError}` : ''}`);
  for (const s of c.factsStatus.sources) lines.push(`  source ${s.name}: ${s.status} (${s.note})`);
  if (c.paidLookup) lines.push(`  Paid lookup: ${c.paidLookup.lastCostText} on ${c.paidLookup.at}${c.paidLookup.note ? ` (${c.paidLookup.note})` : ''}`);
  lines.push(`  Requests sent by this command: ${requests}`);
  return lines.join('\n');
}
