// HTML to plain text, with no dependency. Descriptions are stored as text (one copy, small,
// searchable). freehire keeps sanitised HTML instead; that is a deliberate difference.

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '...',
  rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', bull: '-', middot: '.', copy: '(c)', reg: '(r)',
  trade: '(tm)', eacute: 'é', egrave: 'è', agrave: 'à', aacute: 'á', uuml: 'ü', ouml: 'ö', auml: 'ä',
  ntilde: 'ñ', ccedil: 'ç', euro: 'EUR', pound: 'GBP', yen: 'JPY', deg: 'deg', times: 'x',
  shy: '', zwj: '', zwnj: '', lrm: '', rlm: '',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
      if (code === 0xa0) return ' ';
      try { return String.fromCodePoint(code); } catch { return ''; }
    }
    const v = NAMED[body.toLowerCase()];
    return v === undefined ? m : v;
  });
}

const encodedTag = /&lt;\/?[a-zA-Z]/g;
const liveTag = /<\/?[a-zA-Z]/g;

/**
 * Some feeds (Greenhouse) serve the body entity-encoded ("&lt;p&gt;Role&lt;/p&gt;").
 * Decode one layer only when encoded tag openers outnumber live ones (freehire rule
 * `unescapeEncodedHTML`), so a posting that shows markup as an example is left alone.
 */
export function unescapeEncodedHtml(s: string): string {
  if (!s.includes('&lt;')) return s;
  const enc = (s.match(encodedTag) ?? []).length;
  const live = (s.match(liveTag) ?? []).length;
  return enc > live ? decodeEntities(s) : s;
}

export function htmlToText(input: string): string {
  if (!input) return '';
  let s = unescapeEncodedHtml(input);
  s = s.replace(/<(script|style|head|noscript)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<\/(p|div|h[1-6]|ul|ol|tr|table|section|article|blockquote|pre)\s*>/gi, '\n');
  s = s.replace(/<(p|div|h[1-6]|ul|ol|tr|table|section|article|blockquote|pre)\b[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/[​‌‍﻿]/g, '');
  const lines = s.split('\n').map((l) => l.replace(/[ \t\r\f\v]+/g, ' ').trim());
  // Collapse runs of blank lines to one.
  const out: string[] = [];
  let blank = 0;
  for (const l of lines) {
    if (l === '') { blank++; if (blank <= 1) out.push(''); } else { blank = 0; out.push(l); }
  }
  return out.join('\n').trim();
}
