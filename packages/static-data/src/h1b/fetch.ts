// Downloads the official DOL LCA disclosure files the shipped table is built from (about 670 MB in total), one at a
// time, politely (robots.txt, one request per second per host, the fixed User-Agent), and checks each file's size
// and sha256 against lca-files.ts. A file that is already there and correct is not downloaded again.

import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statfsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';
import { PoliteFetch } from '../net/polite-fetch.ts';
import { sha256File } from './build.ts';
import { OFFICIAL_LCA_FILES } from './lca-files.ts';

export async function fetchOfficialLcaFiles(dir: string, log: (s: string) => void = () => {}, pf: PoliteFetch = new PoliteFetch({ timeoutMs: 30 * 60_000 })): Promise<string[]> {
  mkdirSync(dir, { recursive: true });
  const out: string[] = [];
  for (const f of OFFICIAL_LCA_FILES) {
    const path = join(dir, f.name);
    if (existsSync(path) && statSync(path).size === f.bytes && (await sha256File(path)) === f.sha256) {
      log(`already here and verified: ${f.name}`);
      out.push(path);
      continue;
    }
    const fs = statfsSync(dir);
    const free = fs.bavail * fs.bsize;
    if (free < f.bytes + 200 * 1024 * 1024) throw new Error(`not enough free disk for ${f.name}: ${(free / 1e6).toFixed(0)} MB free, ${(f.bytes / 1e6).toFixed(0)} MB needed plus 200 MB to spare`);
    log(`downloading ${f.url} (${(f.bytes / 1e6).toFixed(1)} MB)`);
    const res = await pf.request(f.url, { accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, */*' });
    const tmp = `${path}.part`;
    rmSync(tmp, { force: true });
    await pipeline(Readable.fromWeb(res.body as ReadableStream), createWriteStream(tmp));
    const size = statSync(tmp).size;
    if (size !== f.bytes) { rmSync(tmp, { force: true }); throw new Error(`${f.name}: got ${size} bytes, expected ${f.bytes} (DOL may have republished the file; update lca-files.ts after checking it)`); }
    const sha = await sha256File(tmp);
    if (sha !== f.sha256) { rmSync(tmp, { force: true }); throw new Error(`${f.name}: sha256 ${sha} differs from the recorded ${f.sha256} (DOL may have republished the file)`); }
    renameSync(tmp, path);
    out.push(path);
  }
  return out;
}
