// "Thinking" text never reaches the person (ai-engine O13). Providers that separate it (Ollama `thinking`,
// OpenAI-style `reasoning_content`, Anthropic thinking blocks) are handled in each provider. This file handles
// models that write their thinking inline as <think>...</think> in the answer text.

const OPEN = /^\s*<(think|thinking|reasoning)>/i;

/** Streaming filter: drops a leading <think>...</think> block from a stream of text pieces. */
export class ThinkStripper {
  private buf = '';
  private mode: 'start' | 'inside' | 'pass' = 'start';
  private closeTag = '</think>';
  /** Characters of thinking text dropped so far. */
  dropped = 0;

  push(text: string): string {
    if (this.mode === 'pass') return text;
    this.buf += text;
    if (this.mode === 'start') {
      const trimmed = this.buf.trimStart();
      if (trimmed.length === 0) return '';
      const m = OPEN.exec(this.buf);
      if (m) {
        this.closeTag = `</${m[1]!.toLowerCase()}>`;
        this.mode = 'inside';
        this.dropped += m[0].length;
        this.buf = this.buf.slice(m[0].length);
      } else {
        const lower = trimmed.toLowerCase();
        const couldBeTag = ['<think>', '<thinking>', '<reasoning>'].some((t) => t.startsWith(lower));
        if (couldBeTag) return ''; // wait for more text
        this.mode = 'pass';
        const out = this.buf; this.buf = ''; return out;
      }
    }
    // inside a thinking block
    const idx = this.buf.toLowerCase().indexOf(this.closeTag);
    if (idx < 0) {
      // Keep only a tail that could be the start of the closing tag.
      const keep = this.closeTag.length - 1;
      if (this.buf.length > keep) {
        this.dropped += this.buf.length - keep;
        this.buf = this.buf.slice(-keep);
      }
      return '';
    }
    this.dropped += idx + this.closeTag.length;
    const rest = this.buf.slice(idx + this.closeTag.length).replace(/^\s+/, '');
    this.buf = '';
    this.mode = 'pass';
    return rest;
  }

  /** Text held back at the end of the stream (never thinking text). */
  flush(): string {
    if (this.mode === 'start') { const out = this.buf; this.buf = ''; this.mode = 'pass'; return out; }
    if (this.mode === 'inside') { this.dropped += this.buf.length; this.buf = ''; return ''; }
    return '';
  }

  /** true when the stream is still inside an unclosed thinking block. */
  get inThinking(): boolean { return this.mode === 'inside'; }
}

/** Removes thinking blocks from a whole answer, including an orphan closing tag after an unmarked thinking part. */
export function stripThinking(text: string): string {
  let out = text.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '');
  const orphan = /<\/(think|thinking|reasoning)>/i.exec(out);
  if (orphan) out = out.slice(orphan.index + orphan[0].length);
  out = out.replace(/<(think|thinking|reasoning)>[\s\S]*$/i, '');
  return out.trim();
}
