// The HTML 4 named character references (the 252 of the W3C HTML 4.01 specification, plus the five XML ones and the
// legacy upper-case forms), numeric references, and the removal of terminal control characters.
// The crawler's own decoder knows only a few dozen names, so "S&atilde;o Paulo" stayed raw. Names are case sensitive
// here ("Eacute" is not "eacute"), like html.unescape.

// U+00A0..U+00FF in order.
const LATIN1 = ('nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro ' +
  'para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute ' +
  'Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute ' +
  'THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ' +
  'ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml').split(' ');

const GREEK_UP = 'Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho'.split(' '); // U+0391..
const GREEK_UP2 = 'Sigma Tau Upsilon Phi Chi Psi Omega'.split(' '); // U+03A3..
const GREEK_LO = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigmaf sigma tau upsilon phi chi psi omega'.split(' '); // U+03B1..

const OTHERS: Record<string, number> = {
  OElig: 338, oelig: 339, Scaron: 352, scaron: 353, Yuml: 376, fnof: 402, circ: 710, tilde: 732,
  thetasym: 977, upsih: 978, piv: 982,
  ensp: 8194, emsp: 8195, thinsp: 8201, zwnj: 8204, zwj: 8205, lrm: 8206, rlm: 8207, ndash: 8211, mdash: 8212,
  lsquo: 8216, rsquo: 8217, sbquo: 8218, ldquo: 8220, rdquo: 8221, bdquo: 8222, dagger: 8224, Dagger: 8225, bull: 8226,
  hellip: 8230, permil: 8240, prime: 8242, Prime: 8243, lsaquo: 8249, rsaquo: 8250, oline: 8254, frasl: 8260, euro: 8364,
  image: 8465, weierp: 8472, real: 8476, trade: 8482, alefsym: 8501,
  larr: 8592, uarr: 8593, rarr: 8594, darr: 8595, harr: 8596, crarr: 8629, lArr: 8656, uArr: 8657, rArr: 8658, dArr: 8659, hArr: 8660,
  forall: 8704, part: 8706, exist: 8707, empty: 8709, nabla: 8711, isin: 8712, notin: 8713, ni: 8715, prod: 8719, sum: 8721,
  minus: 8722, lowast: 8727, radic: 8730, prop: 8733, infin: 8734, ang: 8736, and: 8743, or: 8744, cap: 8745, cup: 8746,
  int: 8747, there4: 8756, sim: 8764, cong: 8773, asymp: 8776, ne: 8800, equiv: 8801, le: 8804, ge: 8805, sub: 8834,
  sup: 8835, nsub: 8836, sube: 8838, supe: 8839, oplus: 8853, otimes: 8855, perp: 8869, sdot: 8901,
  lceil: 8968, rceil: 8969, lfloor: 8970, rfloor: 8971, lang: 9001, rang: 9002, loz: 9674,
  spades: 9824, clubs: 9827, hearts: 9829, diams: 9830,
};

const TABLE = new Map<string, string>();
LATIN1.forEach((n, i) => TABLE.set(n, String.fromCodePoint(0xa0 + i)));
GREEK_UP.forEach((n, i) => TABLE.set(n, String.fromCodePoint(0x391 + i)));
GREEK_UP2.forEach((n, i) => TABLE.set(n, String.fromCodePoint(0x3a3 + i)));
GREEK_LO.forEach((n, i) => TABLE.set(n, String.fromCodePoint(0x3b1 + i)));
for (const [n, c] of Object.entries(OTHERS)) TABLE.set(n, String.fromCodePoint(c));
for (const [n, c] of Object.entries({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", AMP: '&', LT: '<', GT: '>', QUOT: '"', COPY: '©', REG: '®' })) TABLE.set(n, c);
// Layout characters that mean nothing in plain text.
TABLE.set('nbsp', ' ');
for (const n of ['shy', 'zwj', 'zwnj', 'lrm', 'rlm']) TABLE.set(n, '');

/** How many named references the table holds (a test checks it stays complete). */
export const ENTITY_COUNT = TABLE.size;

/** Controls that a terminal or a log reader may act on (ESC, BEL, NUL, C1 such as CSI 0x9B), and bidi overrides. Tab, LF and CR stay. */
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F‪-‮⁦-⁩]/g;
export function stripControls(s: string): string {
  return s.replace(CONTROLS, '');
}

/** Decodes every named (exact case) and numeric reference once. Unknown names stay as written. */
export function decodeEntitiesFull(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]{1,31});/g, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
      if (code === 0xa0) return ' ';
      return String.fromCodePoint(code);
    }
    const v = TABLE.get(body);
    return v === undefined ? m : v;
  });
}

/** Replaces the named references that are not markup (everything but amp, lt, gt, quot, apos) with their characters. */
export function decodeNamedNonMarkup(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&([A-Za-z][A-Za-z0-9]{1,31});/g, (m, name: string) => {
    const low = name.toLowerCase();
    if (low === 'amp' || low === 'lt' || low === 'gt' || low === 'quot' || low === 'apos') return m;
    const v = TABLE.get(name);
    return v === undefined ? m : v;
  });
}
