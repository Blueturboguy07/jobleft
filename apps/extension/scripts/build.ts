// Builds the unpacked extension into apps/extension/dist (load it with Chrome's "Load unpacked").
//   node scripts/build.ts            -> dist/
//   node scripts/build.ts --test-host 47900 -> also grants http://127.0.0.1:47900/* (automated tests only; never shipped)
// esbuild bundles the TypeScript; nothing is minified, so the shipped code can be read.

import { build, type Plugin } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const testHost = args.includes('--test-host') ? Number(args[args.indexOf('--test-host') + 1]) : null;
const out = join(root, args.includes('--out') ? args[args.indexOf('--out') + 1] as string : 'dist');

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'icons'), { recursive: true });

/**
 * Every top-level `const X = <expression>;` of @jobleft/contracts is data (a schema, a list, a table). Wrapping each
 * in a pure-annotated arrow lets esbuild drop the ones the extension never uses, so the package ships only the
 * contracts it runs, and none of the app's other contract text. The source files are not changed.
 */
function pureConstants(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lineStart = i === 0 || src[i - 1] === '\n';
    const m = lineStart ? /^(export )?const ([A-Za-z_$][\w$]*)(: [^=]+)? = /.exec(src.slice(i, i + 400)) : null;
    if (!m) { out += src[i]; i++; continue; }
    const head = m[0];
    let j = i + head.length;
    let depth = 0;
    let q: string | null = null;
    for (; j < n; j++) {
      const c = src[j] as string;
      if (q) {
        if (c === '\\') { j++; continue; }
        if (c === q) q = null;
        continue;
      }
      if (c === '/' && src[j + 1] === '/') { const e = src.indexOf('\n', j); j = e < 0 ? n : e; continue; }
      if (c === '/' && src[j + 1] === '*') { const e = src.indexOf('*/', j + 2); j = e < 0 ? n : e + 1; continue; }
      if (c === '/') {
        // A regular expression literal (a quote or a semicolon inside it is not code): after an operator or at the
        // start of the expression. Skipped whole, escapes and character classes respected.
        const prev = src.slice(i + head.length, j).trimEnd().slice(-1);
        if (prev === '' || '=(,[:?!&|{;'.includes(prev)) {
          let k = j + 1;
          let cls = false;
          for (; k < n; k++) {
            const d = src[k] as string;
            if (d === '\\') { k++; continue; }
            if (cls) { if (d === ']') cls = false; continue; }
            if (d === '[') cls = true;
            else if (d === '/' || d === '\n') break;
          }
          j = k;
          continue;
        }
      }
      if (c === "'" || c === '"' || c === '`') { q = c; continue; }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === ';' && depth === 0) break;
    }
    const expr = src.slice(i + head.length, j);
    out += `${head}/* @__PURE__ */ (() => (${expr}))()`;
    i = j;
  }
  return out;
}

const pureContracts: Plugin = {
  name: 'pure-contracts',
  setup(b) {
    b.onLoad({ filter: /packages[\\/]contracts[\\/]src[\\/].*\.ts$/ }, (a) => ({ contents: pureConstants(readFileSync(a.path, 'utf8')), loader: 'ts' }));
  },
};

const common = { bundle: true, target: 'chrome120', minify: false, sourcemap: false, legalComments: 'inline' as const, logLevel: 'warning' as const, plugins: [pureContracts] };
await build({ ...common, entryPoints: [join(root, 'src/background.ts')], outfile: join(out, 'background.js'), format: 'esm' });
await build({ ...common, entryPoints: [join(root, 'src/content/main.ts')], outfile: join(out, 'content.js'), format: 'iife' });
await build({ ...common, entryPoints: [join(root, 'src/popup.ts')], outfile: join(out, 'popup.js'), format: 'iife' });
copyFileSync(join(root, 'static/popup.html'), join(out, 'popup.html'));
copyFileSync(join(root, 'static/popup.css'), join(out, 'popup.css'));

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as Record<string, unknown> & { host_permissions: string[]; name: string };
manifest.version = pkg.version;
if (testHost) {
  manifest.host_permissions = [...manifest.host_permissions, `http://127.0.0.1:${testHost}/*`];
  manifest.name = `${manifest.name} (TEST BUILD)`;
}
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// ---------------------------------------------------------------- icons: a teal rounded square with a white left arrow

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function png(size: number, pixel: (x: number, y: number) => [number, number, number, number]): Buffer {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function shape(u: number, v: number): 'bg' | 'mark' | 'none' {
  // u, v in [0, 1). Rounded square.
  const r = 0.22;
  const cx = Math.min(Math.max(u, r), 1 - r);
  const cy = Math.min(Math.max(v, r), 1 - r);
  if ((u - cx) ** 2 + (v - cy) ** 2 > r * r) return 'none';
  // Left arrow: a head (triangle) and a shaft.
  const head = u >= 0.2 && u <= 0.5 && Math.abs(v - 0.5) <= (u - 0.2) * 0.95;
  const shaft = u >= 0.42 && u <= 0.8 && Math.abs(v - 0.5) <= 0.085;
  return head || shaft ? 'mark' : 'bg';
}

for (const size of [16, 32, 48, 128]) {
  const ss = 4;
  const img = png(size, (x, y) => {
    let bg = 0, mk = 0;
    for (let i = 0; i < ss; i++) for (let j = 0; j < ss; j++) {
      const s = shape((x + (i + 0.5) / ss) / size, (y + (j + 0.5) / ss) / size);
      if (s === 'bg') bg++; else if (s === 'mark') mk++;
    }
    const n = ss * ss;
    const a = (bg + mk) / n;
    if (a === 0) return [0, 0, 0, 0];
    const t = mk / (bg + mk);
    const r = Math.round(15 + (255 - 15) * t), g = Math.round(118 + (255 - 118) * t), b = Math.round(110 + (255 - 110) * t);
    return [r, g, b, Math.round(a * 255)];
  });
  writeFileSync(join(out, 'icons', `${size}.png`), img);
}

console.log(`built ${out}${testHost ? ` (test build: also http://127.0.0.1:${testHost}/*)` : ''}`);
