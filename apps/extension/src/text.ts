// Text helpers shared by the answer engine (in the app) and the content script (in the page).
// Pure: no DOM, no network, no clock.

/** Lower case, no accents, straight quotes, single spaces, no required markers. */
export function norm(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\(\s*(required|optional)\s*\)/g, ' ')
    .replace(/\*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** norm() plus punctuation to spaces: for word matching ("e-mail address:" -> "e mail address"). */
export function words(s: string | null | undefined): string {
  return norm(s).replace(/[^a-z0-9+#/.' ]+/g, ' ').replace(/[/.']+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** True when `text` opens with `phrase` and the phrase ends at a word boundary. */
export function opensWith(text: string, phrase: string): boolean {
  if (!text.startsWith(phrase)) return false;
  return !/[a-z0-9]/.test(text.charAt(phrase.length));
}

/** True when `phrase` appears in `text` as whole words. */
export function hasWords(text: string, phrase: string): boolean {
  if (!phrase) return false;
  const i = text.indexOf(phrase);
  if (i < 0) return false;
  let from = i;
  while (from >= 0) {
    const before = from === 0 ? '' : text.charAt(from - 1);
    const after = text.charAt(from + phrase.length);
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    from = text.indexOf(phrase, from + 1);
  }
  return false;
}

export function anyWords(text: string, phrases: readonly string[]): boolean {
  return phrases.some((p) => hasWords(text, p));
}

/** Option texts that mean "nothing chosen yet". They are never picked. */
export function isPlaceholderOption(label: string, value: string): boolean {
  const l = norm(label).replace(/^[-\s]+|[-\s.…]+$/g, '');
  const v = norm(value);
  if (!l && !v) return true;
  // Short prompts only: "Choose not to disclose" is a real answer, "Choose one" is not.
  const prompt = /^(select|select one|select an option|select an answer|please select|please select one|please choose|choose|choose one|choose an option|pick one|none selected|--|select a [a-z ]{1,30}|select your [a-z ]{1,30}|please select a [a-z ]{1,30})$/;
  if (prompt.test(l)) return true;
  return v === '' && (l === '' || /^(select|please|choose)\b/.test(l));
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`;
}
