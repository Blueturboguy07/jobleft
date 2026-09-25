// BERT WordPiece tokenizer for bge-small-en-v1.5 (uncased), written from the published algorithm
// (BertNormalizer + BertPreTokenizer + WordPiece + "[CLS] $A [SEP]"). It is checked against the Hugging Face
// tokenizer output in test/tokenizer.test.ts. No third-party code is copied.

export interface TokenizerConfig {
  lowercase: boolean;
  stripAccents: boolean;
  maxLength: number;
}

const CJK_RANGES: Array<[number, number]> = [
  [0x4e00, 0x9fff], [0x3400, 0x4dbf], [0x20000, 0x2a6df], [0x2a700, 0x2b73f], [0x2b740, 0x2b81f], [0x2b820, 0x2ceaf],
  [0xf900, 0xfaff], [0x2f800, 0x2fa1f],
];

function isCjk(cp: number): boolean {
  for (const [a, b] of CJK_RANGES) if (cp >= a && cp <= b) return true;
  return false;
}

const RE_CONTROL = /\p{C}/u;
const RE_WHITESPACE = /\s/u;
const RE_PUNCT = /\p{P}/u;
const RE_MARK = /\p{Mn}/u;

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || RE_WHITESPACE.test(ch);
}

function isControl(ch: string): boolean {
  if (ch === '\t' || ch === '\n' || ch === '\r') return false;
  return RE_CONTROL.test(ch);
}

function isPunctuation(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) return true;
  return RE_PUNCT.test(ch);
}

export class WordPieceTokenizer {
  private readonly vocab: Map<string, number>;
  readonly clsId: number;
  readonly sepId: number;
  readonly padId: number;
  readonly unkId: number;
  private readonly cfg: TokenizerConfig;
  private readonly cache = new Map<string, number[]>();

  constructor(vocabText: string, cfg: Partial<TokenizerConfig> = {}) {
    const lines = vocabText.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    this.vocab = new Map();
    lines.forEach((tok, i) => { if (!this.vocab.has(tok.replace(/\r$/, ''))) this.vocab.set(tok.replace(/\r$/, ''), i); });
    this.cfg = { lowercase: cfg.lowercase ?? true, stripAccents: cfg.stripAccents ?? (cfg.lowercase ?? true), maxLength: cfg.maxLength ?? 512 };
    const id = (t: string) => {
      const v = this.vocab.get(t);
      if (v === undefined) throw new Error(`vocabulary has no ${t}`);
      return v;
    };
    this.clsId = id('[CLS]');
    this.sepId = id('[SEP]');
    this.padId = id('[PAD]');
    this.unkId = id('[UNK]');
  }

  get vocabSize(): number { return this.vocab.size; }

  /** BertNormalizer: clean text, space around CJK, strip accents, lower case. */
  normalize(text: string): string {
    let out = '';
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      if (cp === 0 || cp === 0xfffd || isControl(ch)) continue;
      if (isWhitespace(ch)) { out += ' '; continue; }
      if (isCjk(cp)) { out += ` ${ch} `; continue; }
      out += ch;
    }
    if (this.cfg.stripAccents) {
      let s = '';
      for (const ch of out.normalize('NFD')) if (!RE_MARK.test(ch)) s += ch;
      out = s;
    }
    if (this.cfg.lowercase) out = out.toLowerCase();
    return out;
  }

  /** BertPreTokenizer: split on whitespace, and every punctuation character is its own word. */
  preTokenize(text: string): string[] {
    const words: string[] = [];
    let cur = '';
    for (const ch of text) {
      if (isWhitespace(ch)) { if (cur) { words.push(cur); cur = ''; } continue; }
      if (isPunctuation(ch)) { if (cur) { words.push(cur); cur = ''; } words.push(ch); continue; }
      cur += ch;
    }
    if (cur) words.push(cur);
    return words;
  }

  /** Greedy longest-match-first WordPiece for one word. */
  wordPiece(word: string): number[] {
    const hit = this.cache.get(word);
    if (hit) return hit;
    const chars = Array.from(word);
    let out: number[];
    if (chars.length > 100) out = [this.unkId];
    else {
      out = [];
      let start = 0;
      let bad = false;
      while (start < chars.length) {
        let end = chars.length;
        let found = -1;
        while (start < end) {
          let sub = chars.slice(start, end).join('');
          if (start > 0) sub = `##${sub}`;
          const id = this.vocab.get(sub);
          if (id !== undefined) { found = id; break; }
          end--;
        }
        if (found < 0) { bad = true; break; }
        out.push(found);
        start = end;
      }
      if (bad) out = [this.unkId];
    }
    if (this.cache.size < 200_000) this.cache.set(word, out);
    return out;
  }

  /** Token ids with [CLS] and [SEP], truncated to maxLength. */
  encode(text: string, maxLength = this.cfg.maxLength): number[] {
    const ids: number[] = [this.clsId];
    const limit = maxLength - 1;
    for (const w of this.preTokenize(this.normalize(text))) {
      for (const id of this.wordPiece(w)) {
        if (ids.length >= limit) break;
        ids.push(id);
      }
      if (ids.length >= limit) break;
    }
    ids.push(this.sepId);
    return ids;
  }
}
