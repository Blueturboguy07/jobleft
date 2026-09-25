// Serves the built UI (apps/ui/dist, or JOBLEFT_UI_DIR) at "/". Only files inside that folder are served: every
// path segment is decoded once, "..", "." and hidden names are refused, and the real path must stay inside the
// folder (a symlink cannot lead out). No directory listing. Unknown paths without an extension get index.html
// (the SPA's own router). Nothing here reads the data folder.

import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, sep } from 'node:path';
import { setSecurityHeaders } from './respond.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

/**
 * The UI's content security policy: everything from this origin only, nothing from the internet (server O10), no
 * framing (clickjacking of the pairing button), and API calls only to this origin. Ant Design injects <style>
 * elements, so inline styles are allowed; inline scripts are not.
 */
export const UI_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export class StaticSite {
  readonly root: string;
  private readonly realRoot: string;
  constructor(root: string) {
    this.root = root;
    this.realRoot = realpathSync(root);
  }

  /** Resolves a URL path to a file inside the root, or null. */
  resolve(pathname: string): string | null {
    const segs: string[] = [];
    for (const raw of pathname.split('/')) {
      if (raw === '') continue;
      let s: string;
      try { s = decodeURIComponent(raw); } catch { return null; }
      if (s === '.' || s === '..' || s.startsWith('.') || s.includes('/') || s.includes('\\') || s.includes('\0')) return null;
      segs.push(s);
    }
    const candidate = segs.length === 0 ? join(this.realRoot, 'index.html') : join(this.realRoot, ...segs);
    let file = candidate;
    if (!existsSync(file) || statSync(file).isDirectory()) {
      if (segs.length > 0 && extname(segs[segs.length - 1]!) !== '') return null;
      file = join(this.realRoot, 'index.html');
      if (!existsSync(file)) return null;
    }
    let real: string;
    try { real = realpathSync(file); } catch { return null; }
    if (real !== this.realRoot && !real.startsWith(this.realRoot + sep)) return null;
    if (!statSync(real).isFile()) return null;
    return real;
  }

  /** Serves a GET or HEAD. Returns false when nothing matched (the caller answers 404). */
  serve(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
    const file = this.resolve(pathname);
    if (!file) return false;
    const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
    setSecurityHeaders(res, false);
    res.setHeader('content-security-policy', UI_CSP);
    res.setHeader('content-type', type);
    // index.html is never cached (a new build must load); hashed assets may be.
    res.setHeader('cache-control', file.endsWith(`${sep}index.html`) ? 'no-store' : 'no-cache');
    const size = statSync(file).size;
    res.setHeader('content-length', size);
    res.statusCode = 200;
    if (req.method === 'HEAD') { res.end(); return true; }
    const stream = createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
    return true;
  }
}
