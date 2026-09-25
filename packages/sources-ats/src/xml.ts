// A small, strict XML reader for the two XML feeds this lane reads (Personio XML, Teamtailor RSS).
// No dependency. It never expands custom entities (no DOCTYPE entity tricks), never fetches anything,
// and refuses what is not a whole XML document: an empty body, an HTML page, cut-off XML, mismatched tags.
// Text is entity-decoded exactly once (the XML layer). CDATA is returned as it is.

import { FeedFormatError } from './errors.ts';

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}
export type XmlNode = XmlElement | string;

const NAME = /[A-Za-z_][-A-Za-z0-9_.:]*/y;
const MAX_DEPTH = 200;

/** Decodes the five XML entities and numeric references. Anything else (for example "&nbsp;") is left as written. */
export function decodeXmlEntities(t: string): string {
  if (!t.includes('&')) return t;
  return t.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (_m, body: string) => {
    switch (body) {
      case 'lt': return '<';
      case 'gt': return '>';
      case 'amp': return '&';
      case 'quot': return '"';
      case 'apos': return "'";
      default: {
        const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
        return String.fromCodePoint(code);
      }
    }
  });
}

/** Parses a whole XML document. Throws FeedFormatError with a plain reason when the text is not one. */
export function parseXml(input: string, url = ''): XmlElement {
  let s = input;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  if (s.trim() === '') throw new FeedFormatError(url, 'the board answered with an empty body, not the XML feed');
  if (/^\s*(<!doctype\s+html|<html[\s>])/i.test(s)) throw new FeedFormatError(url, 'the board answered with an HTML page, not the XML feed');
  if (!/^\s*</.test(s)) throw new FeedFormatError(url, 'the board answered with something that is not XML');

  const doc: XmlElement = { name: '#document', attrs: {}, children: [] };
  const stack: XmlElement[] = [doc];
  let root: XmlElement | null = null;
  const n = s.length;
  let i = 0;
  const cut = (what: string): never => {
    throw new FeedFormatError(url, `the XML is cut off (${what}); the answer is incomplete`);
  };
  const pushText = (t: string, raw: boolean): void => {
    const top = stack[stack.length - 1];
    if (top === doc) {
      if (t.trim() !== '') throw new FeedFormatError(url, 'the answer has text outside the XML root element; it is not an XML feed');
      return;
    }
    const v = raw ? t : decodeXmlEntities(t);
    const last = top.children[top.children.length - 1];
    if (typeof last === 'string') top.children[top.children.length - 1] = last + v;
    else top.children.push(v);
  };

  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt === -1) { pushText(s.slice(i), false); break; }
    if (lt > i) pushText(s.slice(i, lt), false);
    if (s.startsWith('<!--', lt)) {
      const end = s.indexOf('-->', lt + 4);
      if (end === -1) cut('a comment never ends');
      i = end + 3;
      continue;
    }
    if (s.startsWith('<![CDATA[', lt)) {
      const end = s.indexOf(']]>', lt + 9);
      if (end === -1) cut('a CDATA section never ends');
      pushText(s.slice(lt + 9, end), true);
      i = end + 3;
      continue;
    }
    if (s.startsWith('<?', lt)) {
      const end = s.indexOf('?>', lt + 2);
      if (end === -1) cut('a processing instruction never ends');
      i = end + 2;
      continue;
    }
    if (s.startsWith('<!', lt)) {
      // DOCTYPE or another declaration. Skipped; custom entities are never expanded.
      if (/^<!doctype\s+html/i.test(s.slice(lt, lt + 20))) throw new FeedFormatError(url, 'the board answered with an HTML page, not the XML feed');
      const gt = s.indexOf('>', lt + 2);
      const br = s.indexOf('[', lt + 2);
      if (gt === -1) cut('a declaration never ends');
      if (br !== -1 && br < gt) {
        const end = s.indexOf(']>', br);
        if (end === -1) cut('a declaration never ends');
        i = end + 2;
      } else {
        i = gt + 1;
      }
      continue;
    }
    if (s[lt + 1] === '/') {
      const gt = s.indexOf('>', lt + 2);
      if (gt === -1) cut('a closing tag never ends');
      const name = s.slice(lt + 2, gt).trim();
      const top = stack[stack.length - 1];
      if (top === doc) throw new FeedFormatError(url, `the XML closes <${name}> that was never opened; it is not a valid feed`);
      if (top.name !== name) throw new FeedFormatError(url, `the XML closes <${name}> while <${top.name}> is open; it is not a valid feed`);
      stack.pop();
      i = gt + 1;
      continue;
    }
    // Start tag.
    NAME.lastIndex = lt + 1;
    const m = NAME.exec(s);
    if (!m) {
      if (lt + 1 >= n) cut('the last tag never ends');
      throw new FeedFormatError(url, 'the answer contains a "<" that does not start a tag; it is not valid XML');
    }
    const el: XmlElement = { name: m[0], attrs: {}, children: [] };
    let j = lt + 1 + m[0].length;
    let selfClose = false;
    for (;;) {
      while (j < n && /\s/.test(s[j])) j++;
      if (j >= n) cut(`the tag <${el.name}> never ends`);
      if (s[j] === '>') { j++; break; }
      if (s[j] === '/' && s[j + 1] === '>') { selfClose = true; j += 2; break; }
      if (s[j] === '/' && j + 1 >= n) cut(`the tag <${el.name}> never ends`);
      NAME.lastIndex = j;
      const a = NAME.exec(s);
      if (!a) throw new FeedFormatError(url, `the tag <${el.name}> has a malformed attribute; it is not valid XML`);
      j += a[0].length;
      while (j < n && /\s/.test(s[j])) j++;
      if (s[j] !== '=') {
        if (j >= n) cut(`the tag <${el.name}> never ends`);
        throw new FeedFormatError(url, `the attribute ${a[0]} in <${el.name}> has no value; it is not valid XML`);
      }
      j++;
      while (j < n && /\s/.test(s[j])) j++;
      const q = s[j];
      if (q !== '"' && q !== "'") {
        if (j >= n) cut(`the tag <${el.name}> never ends`);
        throw new FeedFormatError(url, `the attribute ${a[0]} in <${el.name}> is not quoted; it is not valid XML`);
      }
      const end = s.indexOf(q, j + 1);
      if (end === -1) cut(`an attribute of <${el.name}> never ends`);
      el.attrs[a[0]] = decodeXmlEntities(s.slice(j + 1, end));
      j = end + 1;
    }
    const parent = stack[stack.length - 1];
    if (parent === doc) {
      if (root) throw new FeedFormatError(url, 'the answer has more than one root element; it is not an XML feed');
      if (el.name.toLowerCase() === 'html') throw new FeedFormatError(url, 'the board answered with an HTML page, not the XML feed');
      root = el;
    }
    parent.children.push(el);
    if (!selfClose) {
      if (stack.length > MAX_DEPTH) throw new FeedFormatError(url, 'the XML is nested too deeply to be a job feed');
      stack.push(el);
    }
    i = j;
  }
  if (stack.length > 1) cut(`<${stack[stack.length - 1].name}> is never closed`);
  if (!root) throw new FeedFormatError(url, 'the answer holds no XML element; it is not the feed');
  return root;
}

export function isElement(n: XmlNode | undefined): n is XmlElement {
  return typeof n === 'object' && n !== null;
}

/** The first child element with this name, or null. */
export function child(el: XmlElement | null | undefined, name: string): XmlElement | null {
  if (!el) return null;
  for (const c of el.children) if (isElement(c) && c.name === name) return c;
  return null;
}

/** Every child element with this name. */
export function children(el: XmlElement | null | undefined, name: string): XmlElement[] {
  if (!el) return [];
  const out: XmlElement[] = [];
  for (const c of el.children) if (isElement(c) && c.name === name) out.push(c);
  return out;
}

/** The element's own text (text and CDATA children, not nested elements), trimmed. '' for a missing element. */
export function text(el: XmlElement | null | undefined): string {
  if (!el) return '';
  let out = '';
  for (const c of el.children) if (typeof c === 'string') out += c;
  return out.trim();
}

/** Text of the named child element ('' when missing). */
export function childText(el: XmlElement | null | undefined, name: string): string {
  return text(child(el, name));
}
