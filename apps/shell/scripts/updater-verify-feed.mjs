#!/usr/bin/env node
// Checks a release's update feed against the files it names, the way an installed jobleft does before it installs
// anything, plus the release rules. Node 18+, no packages. Used by scripts/publik-release.sh on the files it
// downloaded back from the release.
//
//   node apps/shell/scripts/updater-verify-feed.mjs --feed <latest.json> --dir <folder with the release files> \
//     --base-url https://github.com/<owner>/<repo>/releases/download/v<version>/ \
//     [--feed-sig <latest.json.sig>] [--config apps/shell/src-tauri/tauri.conf.json] [--expect-platforms a,b]
//
// For every platform of the feed: the url is the absolute https --base-url + a file name; that file is in --dir; the
// signature in the feed is byte for byte the file's .sig next to it; it verifies (minisign Ed25519) with the public
// key in tauri.conf.json; and its trusted comment names the feed's version and the file. With --feed-sig, the feed's
// own signature must verify with the same key and name the same version. Any failure: exit 1.
import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i += 2) {
  if (!args[i].startsWith("--") || args[i + 1] === undefined) die(`bad argument ${args[i]}`);
  opt[args[i].slice(2)] = args[i + 1];
}
for (const k of ["feed", "dir", "base-url"]) if (!opt[k]) die(`--${k} is required`);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = opt.config ?? join(root, "src-tauri", "tauri.conf.json");
const pub = parsePublicKey(JSON.parse(readFileSync(configPath, "utf8"))?.plugins?.updater?.pubkey ?? die("no pubkey"));
const base = opt["base-url"].endsWith("/") ? opt["base-url"] : `${opt["base-url"]}/`;
if (new URL(base).protocol !== "https:") die(`--base-url is not https: ${base}`);

const feedBytes = readFileSync(opt.feed);
const feed = JSON.parse(feedBytes.toString("utf8"));
if (!/^\d+\.\d+\.\d+$/.test(feed.version ?? "")) die(`feed version ${feed.version} is not x.y.z`);
if (!feed.pub_date || Number.isNaN(Date.parse(feed.pub_date))) die("feed has no valid pub_date");
const platforms = Object.keys(feed.platforms ?? {});
if (platforms.length === 0) die("feed has no platforms");
if (opt["expect-platforms"]) {
  const want = opt["expect-platforms"].split(",").sort().join(",");
  if (platforms.slice().sort().join(",") !== want) die(`feed platforms ${platforms.join(",")}, expected ${want}`);
}
for (const target of platforms) {
  const { url, signature } = feed.platforms[target];
  if (typeof url !== "string" || !url.startsWith(base)) die(`${target}: url ${url} is not under ${base}`);
  const name = decodeURIComponent(url.slice(base.length));
  if (!name || name.includes("/")) die(`${target}: url ${url} does not name one file`);
  const file = join(opt.dir, name);
  if (!existsSync(file)) die(`${target}: ${name} is not in ${opt.dir}`);
  const sigFile = readFileSync(`${file}.sig`, "utf8").trim();
  if (signature !== sigFile) die(`${target}: the feed's signature is not ${name}.sig`);
  const signed = checkSignature(readFileSync(file), signature, `${name}.sig`);
  if (signed.version !== feed.version) die(`${target}: ${name} is signed for version ${signed.version}, the feed says ${feed.version}`);
  if (signed.file && signed.file !== name) die(`${target}: the signature names file ${signed.file}, not ${name}`);
  console.log(`ok  ${target}  ${name}  signature verifies with key ${pub.keyId}, version ${signed.version}, url ${url}`);
}
if (opt["feed-sig"]) {
  const signed = checkSignature(feedBytes, readFileSync(opt["feed-sig"], "utf8").trim(), basename(opt["feed-sig"]));
  if (signed.version !== feed.version) die(`the feed's own signature names version ${signed.version}, not ${feed.version}`);
  console.log(`ok  ${basename(opt.feed)}  its own signature (${basename(opt["feed-sig"])}) verifies with key ${pub.keyId}, version ${signed.version}`);
}
console.log(`ok  feed version ${feed.version}, ${platforms.length} platform(s), pub_date ${feed.pub_date}`);

function die(msg) { console.error(`updater-verify-feed: ${msg}`); process.exit(1); }
function b64(s) { return Buffer.from(s.trim(), "base64"); }

// The same minisign rules as apps/shell/scripts/updater-latest-json.mjs (and the updater plugin).
function parsePublicKey(b64text) {
  const lines = b64(b64text).toString("utf8").trim().split("\n");
  const raw = b64(lines[lines.length - 1]);
  if (raw.length !== 42 || raw.subarray(0, 2).toString() !== "Ed") die("the configured pubkey is not a minisign Ed25519 key");
  const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw.subarray(10)]);
  return { keyId: hexId(raw.subarray(2, 10)), id: raw.subarray(2, 10), key: createPublicKey({ key: der, format: "der", type: "spki" }) };
}
function checkSignature(data, sigB64, what) {
  const lines = b64(sigB64).toString("utf8").split("\n");
  if (lines.length < 4 || !lines[2].startsWith("trusted comment: ")) die(`${what} is not a minisign signature`);
  const blob = b64(lines[1]);
  if (blob.length !== 74) die(`${what}: bad signature length`);
  const alg = blob.subarray(0, 2).toString();
  const id = blob.subarray(2, 10);
  const sig = blob.subarray(10);
  if (!id.equals(pub.id)) die(`${what} was made with key ${hexId(id)}, but tauri.conf.json has key ${pub.keyId}`);
  const message = alg === "ED" ? createHash("blake2b512").update(data).digest() : alg === "Ed" ? data : die(`${what}: unknown algorithm ${alg}`);
  if (!verify(null, message, pub.key, sig)) die(`${what} does not verify: the file or the signature is wrong`);
  const trusted = lines[2].slice("trusted comment: ".length);
  if (!verify(null, Buffer.concat([sig, Buffer.from(trusted, "utf8")]), pub.key, b64(lines[3]))) die(`${what}: the trusted comment does not verify`);
  const field = (k) => trusted.split("\t").find((f) => f.startsWith(`${k}:`))?.slice(k.length + 1);
  return { version: field("version"), file: field("file") };
}
function hexId(id) { return Buffer.from(id).reverse().toString("hex").toUpperCase(); }
