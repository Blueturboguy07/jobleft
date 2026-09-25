// INTERIM stand-in for @jobleft/static-data companyKey (the rule in docs/INTERFACES.md, "@jobleft/static-data"):
// lower case; accents removed; "&" and "+" become "and"; a leading "the" and legal suffixes are removed;
// punctuation and spaces are removed. Ordinary words ("technologies", "group") are kept.

const SUFFIXES = new Set(['inc', 'llc', 'l.l.c.', 'corp', 'corporation', 'co', 'ltd', 'llp', 'plc', 'pbc', 'gmbh']);

export function companyKey(name: string): string {
  let s = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  s = s.replace(/[&+]/g, ' and ');
  let words = s.split(/[\s,]+/).filter(Boolean);
  if (words[0] === 'the' && words.length > 1) words = words.slice(1);
  while (words.length > 1 && SUFFIXES.has(words[words.length - 1]!.replace(/\.$/, '')) ) words.pop();
  while (words.length > 1 && SUFFIXES.has(words[words.length - 1]!)) words.pop();
  return words.join('').replace(/[^\p{L}\p{N}]/gu, '');
}
