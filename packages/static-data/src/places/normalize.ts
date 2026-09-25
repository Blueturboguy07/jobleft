// Place-name normalization: case, accents, punctuation and the common short forms "St.", "Ste.", "Ft.", "Mt.".
// "St. Louis", "Saint Louis" and "st louis" all become "saint louis".

const FIRST_WORD: Readonly<Record<string, string>> = { st: 'saint', ste: 'sainte', ft: 'fort', mt: 'mount', pt: 'point' };

export function normPlace(s: string): string {
  let t = String(s ?? '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
  t = t.replace(/&/g, ' and ').replace(/['’`]/g, '');
  t = t.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
  if (!t) return '';
  const words = t.split(' ');
  // "St Louis", "Ft Worth", "Mt Vernon", also after a direction word ("East St Louis", "Port St Lucie").
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const long = FIRST_WORD[w];
    if (long && i < words.length - 1 && (i === 0 || ['east', 'west', 'north', 'south', 'port', 'lake', 'new'].includes(words[i - 1]!))) words[i] = long;
  }
  return words.join(' ');
}
