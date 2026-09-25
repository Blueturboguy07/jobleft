// HTML to plain text, with no dependency. Descriptions are stored as text (one copy, small, searchable) and are
// never cut short (parsers O14): the whole posting stays readable.

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', ndash: '-', mdash: '-',
  hellip: '...', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', sbquo: "'", bdquo: '"', bull: '-', middot: '.',
  copy: '(c)', reg: '(r)', trade: '(tm)', deg: '°', times: 'x', divide: '/', minus: '-', plusmn: '±', frac12: '1/2',
  frac14: '1/4', frac34: '3/4', sup2: '2', sup3: '3', micro: 'µ', para: '', sect: '§', laquo: '"', raquo: '"',
  lsaquo: "'", rsaquo: "'", prime: "'", Prime: '"', larr: '<-', rarr: '->', uarr: '^', darr: 'v', harr: '<->', check: '✓',
  euro: '€', pound: '£', yen: '¥', cent: '¢', curren: '¤', dollar: '$', percnt: '%', num: '#', commat: '@', excl: '!',
  quest: '?', colon: ':', semi: ';', comma: ',', period: '.', lpar: '(', rpar: ')', lsqb: '[', rsqb: ']', lcub: '{',
  rcub: '}', sol: '/', bsol: '\\', ast: '*', plus: '+', equals: '=', verbar: '|', vert: '|', tilde: '~', hat: '^',
  shy: '', zwj: '', zwnj: '', lrm: '', rlm: '', iexcl: '¡', iquest: '¿', ordf: 'ª', ordm: 'º',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', yacute: 'ý', Aacute: 'Á', Eacute: 'É', Iacute: 'Í',
  Oacute: 'Ó', Uacute: 'Ú', agrave: 'à', egrave: 'è', igrave: 'ì', ograve: 'ò', ugrave: 'ù', Agrave: 'À', Egrave: 'È',
  acirc: 'â', ecirc: 'ê', icirc: 'î', ocirc: 'ô', ucirc: 'û', Acirc: 'Â', Ecirc: 'Ê', Ocirc: 'Ô', atilde: 'ã', otilde: 'õ',
  ntilde: 'ñ', Atilde: 'Ã', Otilde: 'Õ', Ntilde: 'Ñ', auml: 'ä', euml: 'ë', iuml: 'ï', ouml: 'ö', uuml: 'ü', yuml: 'ÿ',
  Auml: 'Ä', Euml: 'Ë', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', ccedil: 'ç', Ccedil: 'Ç', aring: 'å', Aring: 'Å', aelig: 'æ',
  AElig: 'Æ', oslash: 'ø', Oslash: 'Ø', eth: 'ð', thorn: 'þ',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
      if (code === 0xa0) return ' ';
      // Windows-1252 code points written as numeric entities (&#146; is a right quote).
      const cp1252: Record<number, string> = { 128: '€', 130: "'", 132: '"', 133: '...', 145: "'", 146: "'", 147: '"', 148: '"', 149: '-', 150: '-', 151: '-', 153: '(tm)' };
      if (cp1252[code]) return cp1252[code];
      if (code < 32 && code !== 9 && code !== 10 && code !== 13) return '';
      try { return String.fromCodePoint(code); } catch { return ''; }
    }
    const v = NAMED[body] ?? NAMED[body.toLowerCase()];
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

const BLOCK = 'p|div|h[1-6]|ul|ol|dl|dt|dd|tr|table|thead|tbody|tfoot|section|article|header|footer|aside|nav|main|blockquote|pre|figure|figcaption|address|fieldset|form|hr|details|summary|center';

export function htmlToText(input: string): string {
  if (!input) return '';
  let s = unescapeEncodedHtml(String(input));
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  s = s.replace(/<(script|style|head|noscript|template|svg|iframe|object)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<hr\b[^>]*>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<\/(?:td|th)\s*>/gi, ' | ');
  s = s.replace(new RegExp(`</(?:${BLOCK})\\s*>`, 'gi'), '\n');
  s = s.replace(new RegExp(`<(?:${BLOCK})\\b[^>]*>`, 'gi'), '\n');
  s = s.replace(/<[a-zA-Z/!?][^>]*>/g, '');
  s = decodeEntities(s);
  // A second layer that some feeds double-encode ("&amp;nbsp;").
  if (/&(?:nbsp|amp|lt|gt|quot|#\d+);/.test(s)) s = decodeEntities(s);
  s = s.replace(new RegExp('[\\u{200b}-\\u{200d}\\u{2060}\\u{feff}]', 'gu'), '');
  s = s.replace(new RegExp('[\\u{a0}\\u{2000}-\\u{200a}\\u{202f}\\u{205f}\\u{3000}]', 'gu'), ' ');
  const lines = s.split(/\r?\n/).map((l) => l.replace(/[ \t\r\f\v]+/g, ' ').replace(/\s*\|\s*$/, '').trim());
  // Collapse runs of blank lines to one.
  const out: string[] = [];
  let blank = 0;
  for (const l of lines) {
    if (l === '') { blank++; if (blank <= 1) out.push(''); } else { blank = 0; out.push(l); }
  }
  return out.join('\n').trim();
}
