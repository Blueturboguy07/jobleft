#!/usr/bin/env node
// Prints the version resource of a Windows executable (the NSIS installer or jobleft.exe), read on any OS without
// running it. Node 18+, no packages. Used by scripts/publik-release.sh to check that the installer is the version
// the feed announces.
//
//   node apps/shell/scripts/pe-version.mjs <file.exe>
//   -> ProductVersion=0.1.10
//      FileVersion=0.1.10.0        (VS_FIXEDFILEINFO, the numeric version)
//      ProductName=jobleft
// It walks the PE resource table to RT_VERSION (16), so it reads the executable's own version and never bytes inside a
// compressed payload. Exit 1 when the file has no version resource.
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) die("usage: pe-version.mjs <file.exe>");
const b = readFileSync(file);

if (b.readUInt16LE(0) !== 0x5a4d) die("not an MZ executable");
const pe = b.readUInt32LE(0x3c);
if (b.readUInt32LE(pe) !== 0x4550) die("no PE signature");
const sections = b.readUInt16LE(pe + 6);
const optSize = b.readUInt16LE(pe + 20);
const opt = pe + 24;
const magic = b.readUInt16LE(opt);
const dirs = opt + (magic === 0x20b ? 112 : 96);
const rsrcRva = b.readUInt32LE(dirs + 2 * 8);
if (!rsrcRva) die("no resource table");
const secTable = opt + optSize;
function rvaToOffset(rva) {
  for (let i = 0; i < sections; i++) {
    const s = secTable + i * 40;
    const va = b.readUInt32LE(s + 12), vsize = Math.max(b.readUInt32LE(s + 8), b.readUInt32LE(s + 16)), raw = b.readUInt32LE(s + 20);
    if (rva >= va && rva < va + vsize) return raw + (rva - va);
  }
  die(`RVA 0x${rva.toString(16)} is in no section`);
}
const base = rvaToOffset(rsrcRva);
// IMAGE_RESOURCE_DIRECTORY: 16 bytes, then (named + id) entries of 8 bytes each.
function entries(dirOffset) {
  const n = b.readUInt16LE(dirOffset + 12) + b.readUInt16LE(dirOffset + 14);
  const out = [];
  for (let i = 0; i < n; i++) {
    const e = dirOffset + 16 + i * 8;
    const name = b.readUInt32LE(e), target = b.readUInt32LE(e + 4);
    out.push({ id: name & 0x80000000 ? null : name, dir: (target & 0x80000000) !== 0, at: base + (target & 0x7fffffff) });
  }
  return out;
}
const type = entries(base).find((e) => e.id === 16 && e.dir);
if (!type) die("no version resource");
let node = type;
while (node.dir) node = entries(node.at)[0] ?? die("empty version resource directory");
// IMAGE_RESOURCE_DATA_ENTRY: RVA, size.
const dataAt = rvaToOffset(b.readUInt32LE(node.at));
const blob = b.subarray(dataAt, dataAt + b.readUInt32LE(node.at + 4));

const fixed = blob.indexOf(Buffer.from([0xbd, 0x04, 0xef, 0xfe]));
if (fixed < 0) die("no VS_FIXEDFILEINFO");
const ms = blob.readUInt32LE(fixed + 8), ls = blob.readUInt32LE(fixed + 12);
const fileVersion = `${ms >>> 16}.${ms & 0xffff}.${ls >>> 16}.${ls & 0xffff}`;

// StringFileInfo values: the UTF-16LE key, NUL, padding to 4 bytes, then the UTF-16LE value up to NUL.
function stringValue(key) {
  const k = Buffer.from(`${key}\0`, "utf16le");
  const at = blob.indexOf(k);
  if (at < 0) return null;
  let p = at + k.length;
  while (p % 4 !== 0) p += 1;
  const start = p;
  while (p + 1 < blob.length && blob.readUInt16LE(p) !== 0) p += 2;
  return blob.subarray(start, p).toString("utf16le");
}
console.log(`ProductVersion=${stringValue("ProductVersion") ?? ""}`);
console.log(`FileVersion=${fileVersion}`);
console.log(`ProductName=${stringValue("ProductName") ?? ""}`);

function die(msg) { console.error(`pe-version: ${msg}`); process.exit(1); }
