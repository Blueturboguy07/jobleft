#!/usr/bin/env node
// The version of jobleft in the six files a release bump changes (the 0.1.8 and 0.1.9 bumps changed exactly these).
// Node 18+, no packages. Used by scripts/publik-release.sh.
//
//   node apps/shell/scripts/release-version.mjs              prints "<file> <version>" per file; exit 0 when all agree
//                                                            (the last line is "version <v>"), 1 when they differ
//   node apps/shell/scripts/release-version.mjs --set 0.1.10 writes 0.1.10 into all six, then reads them back
//   node apps/shell/scripts/release-version.mjs --newer 0.1.10 0.1.9   exit 0 when the first is higher (semver core)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SEMVER = /^\d+\.\d+\.\d+$/;
const files = [
  { path: "package.json", kind: "json" },
  { path: "apps/server/package.json", kind: "json" },
  { path: "apps/shell/package.json", kind: "json" },
  { path: "apps/shell/src-tauri/tauri.conf.json", kind: "json" },
  { path: "apps/shell/src-tauri/Cargo.toml", kind: "toml" },
  { path: "apps/shell/src-tauri/Cargo.lock", kind: "lock" },
];
// The first `"version": "..."`, the [package] `version = "..."` (line 3 of Cargo.toml), and the jobleft-shell entry
// of Cargo.lock. Each pattern must match exactly once where it is used.
const patterns = {
  json: /^(\s*"version":\s*")([^"]+)(")/m,
  toml: /^(\[package\]\nname = "jobleft-shell"\nversion = ")([^"]+)(")/m,
  lock: /^(name = "jobleft-shell"\nversion = ")([^"]+)(")/m,
};

function read(f) {
  const text = readFileSync(join(root, f.path), "utf8");
  const m = text.match(patterns[f.kind]);
  if (!m) die(`${f.path}: no version found`);
  if (f.kind === "json" && JSON.parse(text).version !== m[2]) die(`${f.path}: the first "version" is not the top-level one`);
  return { text, version: m[2] };
}

function newer(a, b) {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

function die(msg) { console.error(`release-version: ${msg}`); process.exit(2); }

const [cmd, a, b] = process.argv.slice(2);
if (cmd === "--newer") {
  if (!SEMVER.test(a ?? "") || !SEMVER.test(b ?? "")) die("--newer needs two x.y.z versions");
  process.exit(newer(a, b) ? 0 : 1);
}
if (cmd === "--set") {
  if (!SEMVER.test(a ?? "")) die("--set needs an x.y.z version");
  for (const f of files) {
    const { text } = read(f);
    writeFileSync(join(root, f.path), text.replace(patterns[f.kind], `$1${a}$3`));
  }
}
const seen = new Set();
for (const f of files) {
  const { version } = read(f);
  seen.add(version);
  console.log(`${f.path} ${version}`);
}
if (seen.size !== 1) { console.error("release-version: the files do not agree"); process.exit(1); }
if (cmd === "--set" && !seen.has(a)) die(`wrote ${a} but read back ${[...seen].join(", ")}`);
console.log(`version ${[...seen][0]}`);
