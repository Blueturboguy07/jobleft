#!/usr/bin/env node
// jobleft-parse: read the four facts (pay, seniority, place, work model) of job postings, offline.
//
//   node packages/parsers/src/cli.ts text [FILE|-] [--title T] [--location L] [--workplace W] [--country CC]
//   node packages/parsers/src/cli.ts board <FILE|http://127.0.0.1:PORT/PATH> [--format F] [--table|--ndjson]
//   node packages/parsers/src/cli.ts rule
//
// The library is pure. This CLI reads files and standard input, and fetches only loopback URLs (a local mock
// board): it never contacts any other host, never sends personal data and spends nothing.
import { readFileSync } from 'node:fs';
import { EXPERIENCE_LEVEL_LABELS } from '@jobleft/contracts';
import { extractFacts, type PostingFacts } from './facts.ts';
import { postingsFromBoard, type BoardFormat, type PostingInput } from './board.ts';
import { countryName } from './places.ts';
import { formatPay, PAY_FILTER_RULE } from './pay-filter.ts';
import { htmlToText } from './html.ts';

const USER_AGENT = 'jobleft-build/0.1 (research build; no personal data)';
const FORMATS: BoardFormat[] = ['greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'personio', 'jsonld'];

interface Args { _: string[]; [k: string]: string | boolean | string[] }

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--') && !['table', 'ndjson', 'json', 'html', 'help', 'compact'].includes(key)) { out[key] = next; i++; }
      else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

function usage(): string {
  return [
    'jobleft-parse: read pay, seniority, place and work model from job postings (offline).',
    '',
    'Commands:',
    '  text [FILE|-] [--title T] [--location L] [--workplace W] [--html]',
    '      One posting as plain text (or HTML with --html), from a file or standard input.',
    '      Without --title, a "Job title:" line or else the first line is the title. --country US sets the country',
    '      used to name a bare "$" or a figure with no currency.',
    '  board <FILE|URL> [--format greenhouse|lever|ashby|workable|recruitee|personio|jsonld] [--table|--ndjson]',
    '      Every posting in a job-board answer (a JSON file, or a loopback URL of a local mock board).',
    '      The format is detected when --format is not given. Output: a JSON array (default), NDJSON or a table.',
    '  rule',
    '      Prints the rule that minimum-pay filters and pay sorting use.',
    '',
    'Each fact is a value with its evidence, or null (unknown). Nothing is ever filled with a default.',
  ].join('\n');
}

function readInput(path: string | undefined): string {
  if (!path || path === '-') return readFileSync(0, 'utf8');
  return readFileSync(path, 'utf8');
}

function isLoopback(u: URL): boolean {
  const h = u.hostname.replace(/^\[|\]$/g, '');
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

async function readBoard(src: string): Promise<unknown> {
  if (/^https?:\/\//i.test(src)) {
    const u = new URL(src);
    if (!isLoopback(u)) throw new Error(`refused: ${u.hostname} is not a loopback host. This command reads only local mock boards (127.0.0.1, localhost) or files.`);
    const res = await fetch(u, { headers: { 'user-agent': USER_AGENT, accept: 'application/json, application/xml;q=0.5, */*;q=0.1' }, redirect: 'error' });
    if (!res.ok) throw new Error(`the mock board answered ${res.status} ${res.statusText}`);
    const body = await res.text();
    return parseBody(body);
  }
  return parseBody(readFileSync(src, 'utf8'));
}

function parseBody(body: string): unknown {
  const t = body.trim();
  if (t.startsWith('{') || t.startsWith('[')) return JSON.parse(t);
  // An HTML job page: its JSON-LD JobPosting blocks.
  const blocks = [...t.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const found: unknown[] = [];
  for (const b of blocks) {
    try {
      const j = JSON.parse(b);
      const list = Array.isArray(j) ? j : Array.isArray(j['@graph']) ? j['@graph'] : [j];
      for (const x of list) if (x && x['@type'] === 'JobPosting') found.push(x);
    } catch { /* not JSON */ }
  }
  if (found.length) return found;
  throw new Error('the input is neither JSON nor an HTML page with a JobPosting block');
}

/** The facts in the shape of the Job contract fields, plus short display text. */
export function factsView(f: PostingFacts, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...extra,
    pay: f.pay,
    payText: formatPay(f.pay),
    payConverted: f.pay && f.pay.period !== 'year' ? { annualMin: f.pay.annualMin, annualMax: f.pay.annualMax, note: 'converted to a year: hourly x 2,080, daily x 260, weekly x 52, monthly x 12' } : null,
    level: f.level,
    levels: f.levels,
    levelLabels: f.levels.map((l) => EXPERIENCE_LEVEL_LABELS[l]),
    yearsRequired: f.yearsRequired,
    places: f.places,
    placeCount: f.places.length,
    isUs: f.isUs,
    workModel: f.workModel,
    remoteScope: f.remoteScope,
    employmentType: f.employmentType,
    statements: f.statements,
    evidence: f.evidence,
    warnings: f.warnings,
  };
}

function placeText(f: PostingFacts): string {
  if (!f.places.length) return f.remoteScope ? `(remote: ${f.remoteScope.regions.join(',') || 'area not stated'})` : '-';
  const p = f.places[0];
  const first = [p.city, p.region, p.country ? (p.country === 'US' ? 'US' : countryName(p.country)) : null].filter(Boolean).join(', ');
  return f.places.length > 1 ? `${first} +${f.places.length - 1}` : first;
}

function table(rows: Array<{ id: string; title: string; f: PostingFacts }>): string {
  const head = ['id', 'title', 'pay', 'level', 'years', 'place', 'US', 'model'];
  const lines = rows.map(({ id, title, f }) => [
    id, title.slice(0, 40), formatPay(f.pay) ?? '-', f.levels.map((l) => EXPERIENCE_LEVEL_LABELS[l]).join(' / ') || '-',
    f.yearsRequired ? `${f.yearsRequired.min}${f.yearsRequired.max !== null && f.yearsRequired.max !== f.yearsRequired.min ? '-' + f.yearsRequired.max : '+'}` : '-',
    placeText(f), f.isUs === null ? '?' : f.isUs ? 'yes' : 'no',
    f.workModel ? f.workModel + (f.remoteScope?.regions.length ? ` (${f.remoteScope.regions.join(',')})` : '') : '-',
  ]);
  const widths = head.map((h, i) => Math.min(44, Math.max(h.length, ...lines.map((l) => String(l[i]).length))));
  const fmt = (cells: string[]) => cells.map((c, i) => String(c).slice(0, widths[i]).padEnd(widths[i])).join(' | ');
  return [fmt(head), widths.map((w) => '-'.repeat(w)).join('-|-'), ...lines.map(fmt)].join('\n');
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (!cmd || args.help || cmd === 'help') { process.stdout.write(usage() + '\n'); return cmd ? 0 : 1; }
  if (cmd === 'rule') { process.stdout.write(PAY_FILTER_RULE + '\n'); return 0; }
  if (cmd === 'text') {
    const raw = readInput(args._[1]);
    const lines = (args.html ? htmlToText(raw) : raw).split(/\r?\n/).map((l) => l.trim());
    // A "Job title:" line wins; else the first line that is not page furniture.
    const labeled = lines.map((l) => /^(?:job\s+title|title|position|role)\s*:\s*(.{2,120})$/i.exec(l)?.[1]).find(Boolean);
    const firstReal = lines.find((l) => l && !/^(?:skip\s+to|menu|home|sign\s+in|log\s+in|apply(?:\s+now)?|share|save|back\s+to|search\s+jobs|jobs?)\b/i.test(l) && l.length <= 150);
    const title = typeof args.title === 'string' ? args.title : (labeled ?? firstReal ?? '');
    const input: PostingInput = {
      title,
      location: typeof args.location === 'string' ? args.location : null,
      workplaceType: typeof args.workplace === 'string' ? args.workplace : null,
      countries: typeof args.country === 'string' ? [args.country] : [],
      ...(args.html ? { descriptionHtml: raw } : { description: raw }),
    };
    const f = extractFacts(input);
    process.stdout.write(JSON.stringify(factsView(f, { title }), null, 2) + '\n');
    return 0;
  }
  if (cmd === 'board') {
    const src = args._[1];
    if (!src) { process.stderr.write('board: give a file or a loopback URL\n'); return 2; }
    const format = typeof args.format === 'string' ? args.format as BoardFormat : undefined;
    if (format && !FORMATS.includes(format)) { process.stderr.write(`board: unknown format "${format}". Use one of: ${FORMATS.join(', ')}\n`); return 2; }
    const payload = await readBoard(src);
    const posts = postingsFromBoard(payload, format);
    const rows = posts.map((p) => ({ id: p.id, url: p.url, format: p.format, title: p.input.title, f: extractFacts(p.input) }));
    if (args.table) process.stdout.write(table(rows) + `\n${rows.length} postings\n`);
    else if (args.ndjson) for (const r of rows) process.stdout.write(JSON.stringify(factsView(r.f, { id: r.id, title: r.title, url: r.url, format: r.format })) + '\n');
    else process.stdout.write(JSON.stringify(rows.map((r) => factsView(r.f, { id: r.id, title: r.title, url: r.url, format: r.format })), null, 2) + '\n');
    return 0;
  }
  process.stderr.write(`unknown command "${cmd}"\n\n${usage()}\n`);
  return 2;
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e: unknown) => {
  process.stderr.write(`jobleft-parse: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
