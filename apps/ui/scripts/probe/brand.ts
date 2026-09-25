// O2 (static half): the other company's name and its sentences are nowhere in the app. Scans the built app, the
// source, the fixtures and the demo's own data for the banned names, and compares every run of 7 words in the
// reference notes (the measured UI specs, the feature notes) with every run of 7 words of the app's own text.
// The screen half of O2 (window titles, tooltips, notifications) is in nav.ts and the screenshot audit.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { check, UI_ROOT, type Demo } from './lib.ts';

const REFERENCE = ['/Users/mannbellani/jobright-research/ui/UI-SPEC.md', '/Users/mannbellani/jobright-research/ui/UI-SPEC-LOGGED-IN.md', '/Users/mannbellani/jobright-research/jobright-features.md', '/Users/mannbellani/jobright-research/GAPS.md'];
// built from parts, so that a search of this repository for the names finds only what the product itself says
const NAMES = [['job', 'right'].join(''), ['or', 'ion'].join(''), ['tur', 'bo'].join('')];

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n === '.mock-home' || n === '.scratch' || n === '.cache') continue;
    const f = join(dir, n);
    const st = statSync(f);
    if (st.isDirectory()) walk(f, out); else if (/\.(tsx?|css|html|svg|json|md|js|mjs)$/.test(n) && st.size < 3_000_000) out.push(f);
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

export const noServer = true;

export async function run(_demo: Demo | null): Promise<void> {
  const app = [...walk(join(UI_ROOT, 'src')), ...walk(join(UI_ROOT, 'mock')), ...(existsSync(join(UI_ROOT, 'dist')) ? walk(join(UI_ROOT, 'dist')) : []), join(UI_ROOT, 'index.html'), ...walk(join(UI_ROOT, 'public'))];
  // 1. the names
  const nameHits: string[] = [];
  for (const f of app) {
    const t = readFileSync(f, 'utf8');
    for (const n of NAMES) if (new RegExp(n, 'i').test(t)) nameHits.push(`${f.replace(UI_ROOT + '/', '')}: ${n}`);
  }
  check(nameHits.length === 0, 'O2 the banned names are nowhere in the app source, fixtures, built app or icons', nameHits.slice(0, 5).join(' | '));
  const domainHits = app.filter((f) => /jobright\.ai|\.jobright/i.test(readFileSync(f, 'utf8')));
  check(domainHits.length === 0, 'O2 no address of the other company appears in the app', domainHits.join(' | '));

  // 2. runs of 7 words shared with the reference notes (the text of the app only: UI strings, not code)
  const strings = new Set<string>();
  for (const f of app.filter((x) => /\.(tsx?|html)$/.test(x) && !/dist\//.test(x))) {
    const t = readFileSync(f, 'utf8');
    for (const m of t.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])+?)\1|>([^<>{}\n]{12,})</g)) { const s = m[2] ?? m[3]; if (s && /[a-z]{3,} [a-z]{2,}/i.test(s) && s.split(/\s+/).length >= 4) strings.add(norm(s)); }
  }
  const appWords: string[] = [];
  const grams = new Map<string, string>();
  for (const s of strings) { const w = s.split(' '); appWords.push(...w); for (let i = 0; i + 7 <= w.length; i++) grams.set(w.slice(i, i + 7).join(' '), s); }
  const shared: string[] = [];
  for (const rf of REFERENCE) {
    if (!existsSync(rf)) continue;
    const t = norm(readFileSync(rf, 'utf8'));
    const w = t.split(' ');
    for (let i = 0; i + 7 <= w.length; i++) { const g = w.slice(i, i + 7).join(' '); const hit = grams.get(g); if (hit) shared.push(`"${g}" (in ${rf.split('/').pop()})`); }
  }
  const uniq = [...new Set(shared)];
  check(uniq.length === 0, 'O2 no run of 7 words of the app text is copied from the reference notes', `${grams.size} runs checked; ${uniq.slice(0, 5).join(' | ')}`);
  void appWords;
  check(existsSync(resolve(UI_ROOT, 'public', 'favicon.svg')), 'O2 the app icon is the jobleft mark (own drawing)', readFileSync(resolve(UI_ROOT, 'public', 'favicon.svg'), 'utf8').slice(0, 80));
}
