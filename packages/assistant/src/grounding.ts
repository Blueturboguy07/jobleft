// The grounding guard (O1, O2). The model may only state numbers, links and dates that come from the person's data in
// this conversation (the tool results of this turn and the person's own messages). It works on the STREAM: the text is
// released word by word, and a word that carries a dollar amount, a percent, a link or a date that no source holds is
// replaced with a plain marker before it reaches the screen. A sponsor denial ("does not sponsor") is replaced too,
// unless the posting itself says it. This does not make a model honest; it makes a made-up figure visible and harmless.

export class Grounder {
  private corpus = '';
  private numbers: number[] = [];
  private sponsorNo = false;
  private pending = '';
  private queue: string[] = [];
  private readonly window: number;
  replaced: string[] = [];

  constructor(opts: { window?: number } = {}) { this.window = opts.window ?? 5; }

  /** Adds text that is allowed to be quoted: tool results and the person's messages. */
  addSource(text: string): void {
    this.corpus += '\n' + text.toLowerCase();
    for (const m of text.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) {
      const v = Number(m[0].replace(/,/g, ''));
      if (Number.isFinite(v)) this.numbers.push(v);
    }
    if (/"sponsorship"\s*:\s*"no"|post_says_no|no sponsorship|not (?:able to )?sponsor|unable to sponsor|without sponsorship|cannot sponsor|can't sponsor|will not sponsor|does not sponsor|doesn't sponsor/i.test(text)) this.sponsorNo = true;
  }

  private numberKnown(v: number): boolean {
    if (this.numbers.includes(v)) return true;
    if (v >= 1000) return this.numbers.some((n) => n >= 1000 && Math.abs(n - v) / v <= 0.015);
    return this.numbers.some((n) => Math.abs(n - v) < 0.005);
  }

  private checkWord(w: string): string {
    let out = w;
    // links (also inside markdown)
    out = out.replace(/https?:\/\/[^\s)\]>"']+/gi, (u) => {
      const bare = u.replace(/[.,;:!?]+$/, '');
      const tail = u.slice(bare.length);
      const norm = bare.toLowerCase().replace(/\/+$/, '');
      const known = this.corpus.includes(norm) || this.corpus.includes(norm + '/');
      if (known) return u;
      this.replaced.push(bare);
      return '[link removed: not in your data]' + tail;
    });
    // money: $120,000  $95k  $38.50  $1.2M
    out = out.replace(/\$\s?(\d[\d,]*(?:\.\d+)?)\s?([kKmM])?(?![\w])/g, (all, num: string, unit: string | undefined) => {
      let v = Number(num.replace(/,/g, ''));
      if (!Number.isFinite(v)) return all;
      if (unit && /k/i.test(unit)) v *= 1000; else if (unit && /m/i.test(unit)) v *= 1_000_000;
      if (this.numberKnown(v)) return all;
      this.replaced.push(all);
      return '[amount not in your data]';
    });
    // percent
    out = out.replace(/(\d{1,3}(?:\.\d+)?)\s?%/g, (all, num: string) => {
      if (this.numberKnown(Number(num))) return all;
      this.replaced.push(all);
      return '[percent not in your data]';
    });
    // ISO dates
    out = out.replace(/\b(\d{4}-\d{2}-\d{2})\b/g, (all, d: string) => {
      if (this.corpus.includes(d)) return all;
      this.replaced.push(all);
      return '[date not in your data]';
    });
    return out;
  }

  private phrase(text: string): string {
    if (this.sponsorNo) return text;
    return text.replace(/\b(?:(?:does|do|did|will|would|can|could)\s*(?:not|n't)|doesn['’]t|don['’]t|won['’]t|never|no longer|not)\s+(?:currently\s+|typically\s+|usually\s+|generally\s+)?(?:offer\s+|provide\s+)?(?:visa\s+|h-?1b\s+)?sponsor(?:ship|s|ing)?\b/gi, (m) => {
      this.replaced.push(m);
      return '[sponsorship is not stated in your data]';
    });
  }

  /** Text in; the part that is safe to show out. The last part-word and the last few words are held back. */
  push(text: string): string {
    const all = this.pending + text;
    const bits = all.split(/(\s+)/);
    const lastIsPartial = bits.length > 0 && !/\s$/.test(all);
    this.pending = lastIsPartial ? bits.pop() ?? '' : '';
    let out = '';
    for (const b of bits) {
      this.queue.push(/^\s+$/.test(b) ? b : this.checkWord(b));
      // hold back the last `window` words so a phrase that spans words can still be checked
      const words = this.queue.filter((q) => !/^\s+$/.test(q)).length;
      if (words > this.window) out += this.release();
    }
    return out;
  }

  private release(): string {
    // check the phrase over the queue, then release everything before the last `window` words
    const joined = this.phrase(this.queue.join(''));
    this.queue = joined.split(/(\s+)/).filter((s) => s !== '');
    let out = '';
    while (this.queue.filter((q) => !/^\s+$/.test(q)).length > this.window) {
      const first = this.queue.shift()!;
      out += first;
    }
    return out;
  }

  /** The rest of the text at the end of the answer. */
  flush(): string {
    let tail = this.pending ? this.checkWord(this.pending) : '';
    this.pending = '';
    this.queue.push(tail);
    const joined = this.phrase(this.queue.join(''));
    this.queue = [];
    return joined;
  }
}

/** Which of the known jobs the text names: by id, or by both its company and its title. */
export function jobsNamedIn(text: string, jobs: Iterable<{ id: string; title: string; company: string }>, max = 10): Array<{ id: string; title: string; company: string }> {
  const t = text.toLowerCase();
  const out: Array<{ id: string; title: string; company: string }> = [];
  for (const j of jobs) {
    if (t.includes(j.id.toLowerCase()) || (t.includes(j.title.toLowerCase()) && t.includes(j.company.toLowerCase()))) out.push({ id: j.id, title: j.title, company: j.company });
    if (out.length >= max) break;
  }
  return out;
}
