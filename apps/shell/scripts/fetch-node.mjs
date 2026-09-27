// Fetches the official Node 24 runtime the bundle ships as its sidecar, verifies it against nodejs.org's SHASUMS256.txt,
// and puts it at src-tauri/binaries/node-<target triple>[.exe]. Safe to run again (skips when present).
// Usage: node apps/shell/scripts/fetch-node.mjs [--target darwin-arm64|win-x64]   (default: this machine)
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = 'v24.18.0';
const ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const argTarget = process.argv.indexOf('--target') >= 0 ? process.argv[process.argv.indexOf('--target') + 1] : null;
const target = argTarget ?? (process.platform === 'win32' ? 'win-x64' : 'darwin-arm64');
const spec = { 'darwin-arm64': { archive: `node-${VERSION}-darwin-arm64.tar.gz`, inner: `node-${VERSION}-darwin-arm64/bin/node`, out: 'node-aarch64-apple-darwin' }, 'win-x64': { archive: `node-${VERSION}-win-x64.zip`, inner: `node-${VERSION}-win-x64/node.exe`, out: 'node-x86_64-pc-windows-msvc.exe' } }[target];
if (!spec) throw new Error(`unknown target ${target}`);
const outDir = join(ROOT, 'apps/shell/src-tauri/binaries');
const out = join(outDir, spec.out);
if (existsSync(out)) { console.log(`present: ${out}`); process.exit(0); }
mkdirSync(outDir, { recursive: true });
const base = `https://nodejs.org/dist/${VERSION}/`;
const sums = await (await fetch(base + 'SHASUMS256.txt')).text();
const want = sums.split('\n').find((l) => l.trim().endsWith(' ' + spec.archive) || l.trim().endsWith('  ' + spec.archive))?.split(/\s+/)[0];
if (!want) throw new Error(`no checksum for ${spec.archive}`);
const buf = Buffer.from(await (await fetch(base + spec.archive)).arrayBuffer());
const got = createHash('sha256').update(buf).digest('hex');
if (got !== want) throw new Error(`checksum mismatch for ${spec.archive}: ${got} != ${want}`);
const work = join(tmpdir(), `jobleft-node-${Date.now()}`); mkdirSync(work, { recursive: true });
const archive = join(work, spec.archive); writeFileSync(archive, buf);
if (spec.archive.endsWith('.zip')) execFileSync(process.platform === 'win32' ? 'tar' : 'unzip', process.platform === 'win32' ? ['-xf', archive, '-C', work] : ['-q', archive, '-d', work]);
else execFileSync('tar', ['-xzf', archive, '-C', work]);
copyFileSync(join(work, spec.inner), out); // a copy, not a rename: the temp folder may sit on another drive (Windows runners: C: vs D:)
rmSync(work, { recursive: true, force: true });
console.log(`fetched ${spec.archive} (sha256 ok) -> ${out}`);
