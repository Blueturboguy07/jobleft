// Regenerates the GENERATED blocks of docs/INTERFACES.md from the code:
//   <!-- BEGIN GENERATED: routes --> ... <!-- END GENERATED: routes -->     the LOCAL API table (from LOCAL_API)
//   <!-- BEGIN GENERATED: sig:<package dir> --> ... <!-- END ... -->        a package's public declarations (tsc)
// Run after any interface change:  node scripts/gen-interfaces.ts
// Prose outside the blocks is hand-written and is kept as it is.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_API, type JsonSchema, type RouteSpec } from '../packages/contracts/src/index.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const docPath = join(root, 'docs', 'INTERFACES.md');

function shape(s: JsonSchema | undefined): string {
  if (!s) return '—';
  if (s.title) return `\`${s.title}\``;
  if (s.type === 'array') return s.items ? `${shape(s.items).replace(/`$/, '[]`')}` : '`array`';
  if (s.type === 'object' && s.properties) {
    const req = new Set(s.required ?? []);
    const keys = Object.keys(s.properties).map((k) => (req.has(k) ? k : `${k}?`));
    return keys.length ? `\`{ ${keys.join(', ')} }\`` : '`{}`';
  }
  if (s.type === 'object' && s.additionalProperties) return '`{ [key]: … }`';
  return `\`${s.type ?? 'any'}\``;
}

function routesTable(): string {
  const lines = [
    '| Name | Method | Path | Auth | Owner | Query | Body | Response | What |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const [name, r] of Object.entries(LOCAL_API) as Array<[string, RouteSpec]>) {
    const body = r.body === undefined ? '—' : 'raw' in r.body ? `raw: ${(r.body as { raw: readonly string[] }).raw.join(', ')}` : shape(r.body as JsonSchema);
    const resp = r.response === 'sse' ? 'SSE `ChatStreamEvent`' : r.response === 'file' ? 'file' : shape(r.response);
    const q = r.query ? shape(r.query) : '—';
    lines.push(`| \`${name}\` | ${r.method} | \`${r.path}\` | ${r.auth} | ${r.owner} | ${q} | ${body} | ${resp} | ${r.summary}${r.devOnly ? ' (JOBLEFT_DEV=1 only)' : ''} |`);
  }
  return lines.join('\n');
}

function signatures(dir: string): string {
  const out = mkdtempSync(join(tmpdir(), 'jobleft-dts-'));
  try {
    const pkg = join(root, dir);
    execFileSync(join(root, 'node_modules', '.bin', 'tsc'), [
      '-p', join(pkg, 'tsconfig.json'), '--noEmit', 'false', '--declaration', '--emitDeclarationOnly',
      '--outDir', out, '--rootDir', pkg,
    ], { stdio: 'pipe' });
    const dts = readFileSync(join(out, 'src', 'index.d.ts'), 'utf8')
      .split('\n')
      .filter((l) => !/^export declare const PACKAGE_NAME/.test(l))
      .join('\n')
      .trim();
    return '```ts\n' + dts + '\n```';
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

let doc = readFileSync(docPath, 'utf8');
doc = doc.replace(/(<!-- BEGIN GENERATED: ([^ ]+) -->)[\s\S]*?(<!-- END GENERATED: \2 -->)/g, (_m, open: string, key: string, close: string) => {
  if (key === 'routes') return `${open}\n${routesTable()}\n${close}`;
  if (key.startsWith('sig:')) return `${open}\n${signatures(key.slice(4))}\n${close}`;
  throw new Error(`unknown generated block: ${key}`);
});
writeFileSync(docPath, doc);
console.log(`updated ${docPath}`);
