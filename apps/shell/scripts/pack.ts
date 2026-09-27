// Builds the sidecar tree the Tauri bundle ships (docs/INTERFACES.md section 5.2):
//   src-tauri/resources/server/  the server (src, ui-fallback, package.json) with one flat copy of every
//                                @jobleft package it needs under node_modules/@jobleft/<name> (no third-party code:
//                                the server has none; node:sqlite is built into Node). Every .ts file is transpiled
//                                to .js on the way (esbuild, file by file, same tree): Node never strips types
//                                inside node_modules, and workers and import.meta.url paths stay valid.
//   src-tauri/resources/ui/      the built UI (apps/ui/dist)
//   src-tauri/binaries/node-<target>  the Node 24 runtime (put there by hand or by scripts/fetch-node.sh; verified
//                                against nodejs.org's SHASUMS256.txt)
// Usage: node apps/shell/scripts/pack.ts [--target darwin-arm64|win-x64]   (run from the repository root; safe to run again)
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
// esbuild comes with the UI's Vite; it is used here only as a TypeScript-to-JavaScript transform, one file at a time.
// Found through Vite's real folder (Node's own resolution), so pnpm's store may live anywhere.
const require = createRequire(import.meta.url);
const viteDir = realpathSync(dirname(require.resolve('vite/package.json', { paths: [join(ROOT, 'apps/ui')] })));
const esbuildMain = require.resolve('esbuild/lib/main.js', { paths: [viteDir] });
type Transform = (code: string, opts: Record<string, unknown>) => { code: string };
const { transformSync } = (await import(pathToFileURL(esbuildMain).href)) as { transformSync: Transform };
/** Relative specifiers and URL literals that end in .ts point at the transpiled .js next to them. */
const relinkSpecifiers = (code: string) => code.replace(/(['"])(\.{1,2}\/[^'"\n]+?)\.ts\1/g, '$1$2.js$1');
const argTarget = process.argv.indexOf('--target') >= 0 ? process.argv[process.argv.indexOf('--target') + 1] : null;
const TARGET = argTarget ?? (process.platform === 'win32' ? 'win-x64' : 'darwin-arm64');
const ONNX = { 'darwin-arm64': ['darwin', 'arm64'], 'win-x64': ['win32', 'x64'] }[TARGET] ?? ['darwin', 'arm64'];
const OUT = join(ROOT, 'apps/shell/src-tauri/resources');
const SKIP = new Set(['node_modules', 'test', 'tests', 'testkit', 'scripts', 'docs', 'fixtures', 'jobsync', 'README.md', 'tsconfig.json', '.DS_Store', 'reports', 'dev', 'dist-placeholder', 'public', 'manifest.json', 'vite.config.ts']);

function deps(pkgDir: string): string[] {
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  return Object.keys(pkg.dependencies ?? {}).filter((d) => d.startsWith('@jobleft/')).map((d) => d.slice('@jobleft/'.length));
}

let transpiled = 0;
function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    if (SKIP.has(name) || name.endsWith('.test.ts') || name.endsWith('.d.ts')) continue;
    const src = join(from, name);
    if (statSync(src).isDirectory()) { copyTree(src, join(to, name)); continue; }
    if (name.endsWith('.ts')) {
      const out = transformSync(readFileSync(src, 'utf8'), { loader: 'ts', format: 'esm', target: 'node24', sourcefile: src, tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } } });
      writeFileSync(join(to, name.slice(0, -3) + '.js'), relinkSpecifiers(out.code));
      transpiled++;
    } else if (name === 'package.json') {
      writeFileSync(join(to, name), readFileSync(src, 'utf8').replace(/\.ts"/g, '.js"'));
    } else cpSync(src, join(to, name));
  }
}
const copyPackage = copyTree;

rmSync(OUT, { recursive: true, force: true });
const serverOut = join(OUT, 'server');
copyPackage(join(ROOT, 'apps/server'), serverOut);
const seen = new Set<string>();
const queue = deps(join(ROOT, 'apps/server'));
while (queue.length) {
  const name = queue.shift()!;
  if (seen.has(name)) continue;
  seen.add(name);
  // Workspace packages live under packages/; the server also uses the extension's answer engine (apps/extension).
  const from = [join(ROOT, 'packages', name), join(ROOT, 'apps', name)].find((d) => existsSync(join(d, 'package.json')));
  if (!from) throw new Error(`package not found: ${name}`);
  copyPackage(from, join(serverOut, 'node_modules/@jobleft', name));
  queue.push(...deps(from));
}
// Third-party runtime packages: every non-workspace dependency (dependencies + optionalDependencies, never dev) of
// every workspace package the server uses, found the way Node finds them (walking up from the package's own real
// folder), then their dependencies, and so on. Each package is copied once, flat, under node_modules/<name>; a second
// version of a name stops the build (the flat layout needs one). This works with any pnpm layout (the virtual store
// may sit outside the workspace, as on Windows runners). onnxruntime-node ships binaries for every platform; only
// the target's stay.
function findPackage(name: string, from: string): string | null {
  let dir = from;
  for (;;) {
    const cand = join(dir, 'node_modules', name);
    if (existsSync(join(cand, 'package.json'))) return realpathSync(cand);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
const third: string[] = [];
const seenNames = new Map<string, string>();
function runtimeDeps(pkgDir: string): string[] {
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
  return [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})];
}
function copyThirdParty(name: string, from: string, wantedBy: string): void {
  if (name.startsWith('@jobleft/')) return;
  const src = findPackage(name, from);
  if (!src) throw new Error(`${name} (needed by ${wantedBy}) not found from ${from}`);
  const version = (JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')) as { version?: string }).version ?? '?';
  const before = seenNames.get(name);
  if (before !== undefined) { if (before !== version) throw new Error(`two versions of ${name}: ${before} and ${version}; the flat layout needs one`); return; }
  seenNames.set(name, version);
  cpSync(src, join(serverOut, 'node_modules', name), { recursive: true, dereference: true, filter: (p) => !/[\\/](test|tests|docs|examples|\.github)([\\/]|$)/.test(p.slice(src.length)) && !/[\\/]node_modules([\\/]|$)/.test(p.slice(src.length)) });
  third.push(`${name}@${version}`);
  for (const dep of runtimeDeps(src)) copyThirdParty(dep, src, name);
}
for (const name of ['server', ...seen]) {
  const from = name === 'server' ? join(ROOT, 'apps/server') : [join(ROOT, 'packages', name), join(ROOT, 'apps', name)].find((d) => existsSync(join(d, 'package.json')))!;
  for (const dep of runtimeDeps(from)) copyThirdParty(dep, from, name);
}
third.sort();
const onnxBin = join(serverOut, 'node_modules/onnxruntime-node/bin/napi-v6');
if (existsSync(onnxBin)) for (const os of readdirSync(onnxBin)) {
  if (os !== ONNX[0]) { rmSync(join(onnxBin, os), { recursive: true, force: true }); continue; }
  for (const arch of readdirSync(join(onnxBin, os))) if (arch !== ONNX[1]) rmSync(join(onnxBin, os, arch), { recursive: true, force: true });
}
const ui = join(ROOT, 'apps/ui/dist');
if (!existsSync(join(ui, 'index.html'))) throw new Error('build the UI first: pnpm --filter @jobleft/ui build');
cpSync(ui, join(OUT, 'ui'), { recursive: true });
// The public publik app token (CONTRACT section 7) from JOBLEFT_PUBLIK_APP_TOKEN or apps/shell/publik-app-token.local
// (git-ignored). Without one, the bundle refuses "Connect to publik" in plain words and everything else works.
const localTok = join(ROOT, 'apps/shell/publik-app-token.local');
const tok = (process.env.JOBLEFT_PUBLIK_APP_TOKEN ?? (existsSync(localTok) ? readFileSync(localTok, 'utf8') : '')).trim();
writeFileSync(join(OUT, 'publik-app-token.txt'), /^pat_jobleft_[A-Za-z0-9]+$/.test(tok) ? tok + '\n' : '');
const node = join(ROOT, 'apps/shell/src-tauri/binaries', TARGET === 'win-x64' ? 'node-x86_64-pc-windows-msvc.exe' : 'node-aarch64-apple-darwin');
const size = (dir: string): number => readdirSync(dir).reduce((n, f) => { const p = join(dir, f); const s = statSync(p); return n + (s.isDirectory() ? size(p) : s.size); }, 0);
console.log(`target ${TARGET}; third-party: ${third.join(', ')}\nserver tree: ${[...seen].sort().join(', ')}; ${transpiled} files transpiled (${(size(serverOut) / 1e6).toFixed(1)} MB); ui: ${(size(join(OUT, 'ui')) / 1e6).toFixed(1)} MB; node runtime: ${existsSync(node) ? `${(statSync(node).size / 1e6).toFixed(0)} MB` : 'MISSING (apps/shell/README.md says how to fetch it)'}; publik app token: ${tok ? 'shipped' : 'none (Connect to publik stays off)'}`);
