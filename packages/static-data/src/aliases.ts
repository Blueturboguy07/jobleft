// The reviewed brand-to-filer alias table (data/company-aliases.json). Never built from a similarity score.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { companyKey } from './company-key.ts';
import { DATA_DIR } from './paths.ts';

export interface AliasEntry {
  group: string;
  names: string[];
  filers: string[];
  basis: string;
}

export interface AliasTable {
  format: string;
  reviewed: string;
  reviewedBy: string;
  entries: AliasEntry[];
}

/** Brand to legal filer names that are known to be the same company (a reviewed alias table, never a guess). */
export interface CompanyAliases {
  /** The keys of every name known for this company, including the input's own key. */
  keysFor(name: string): string[];
}

export interface AliasIndex extends CompanyAliases {
  /** The entry whose names include this key, or null. */
  entryForKey(key: string): (AliasEntry & { filerKeys: string[] }) | null;
  readonly table: AliasTable;
}

export const ALIAS_FILE = 'company-aliases.json';

let cached: { path: string; index: AliasIndex } | null = null;

export function buildAliasIndex(table: AliasTable): AliasIndex {
  const byKey = new Map<string, AliasEntry & { filerKeys: string[] }>();
  const groupKeys = new Map<string, Set<string>>();
  for (const e of table.entries) {
    const filerKeys = [...new Set(e.filers.map(companyKey).filter(Boolean))];
    const entry = { ...e, filerKeys };
    let g = groupKeys.get(e.group);
    if (!g) { g = new Set(); groupKeys.set(e.group, g); }
    for (const n of e.names) {
      const k = companyKey(n);
      if (!k) continue;
      if (byKey.has(k) && byKey.get(k)!.group !== e.group) {
        throw new Error(`${ALIAS_FILE}: the name "${n}" is in two groups (${byKey.get(k)!.group} and ${e.group})`);
      }
      if (!byKey.has(k)) byKey.set(k, entry);
      g.add(k);
    }
    for (const k of filerKeys) g.add(k);
  }
  return {
    table,
    entryForKey: (key) => byKey.get(key) ?? null,
    keysFor(name: string): string[] {
      const k = companyKey(name);
      if (!k) return [];
      const e = byKey.get(k);
      const out = new Set<string>([k]);
      if (e) for (const x of groupKeys.get(e.group) ?? []) out.add(x);
      else {
        // A legal filer name listed in an entry belongs to that entry's group too.
        for (const [group, keys] of groupKeys) {
          if (keys.has(k)) { for (const x of groupKeys.get(group)!) out.add(x); break; }
        }
      }
      return [...out];
    },
  };
}

/** Loads the reviewed alias table that ships in this package's data/ folder. */
export function loadAliasIndex(dataDir: string = DATA_DIR): AliasIndex {
  const path = join(dataDir, ALIAS_FILE);
  if (cached && cached.path === path) return cached.index;
  const table = JSON.parse(readFileSync(path, 'utf8')) as AliasTable;
  if (table.format !== 'jobleft-company-aliases/1' || !Array.isArray(table.entries)) throw new Error(`${path}: not a jobleft alias table`);
  const index = buildAliasIndex(table);
  cached = { path, index };
  return index;
}
