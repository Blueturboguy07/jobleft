// The words of a web search, and whether a job's text is about them (Jobs > Web jobs, the assistant's web search).

const STOP = new Set(['and', 'or', 'the', 'a', 'an', 'of', 'for', 'in', 'at', 'to', 'with', 'en', 'de', 'het', 'een', 'van', 'voor', 'job', 'jobs', 'vacature', 'vacatures']);

/**
 * Level words: a posting may not use them ("starter", or none at all), and the match score weighs the level
 * already, so they are not required when other words are left.
 */
const LEVEL = new Set(['junior', 'medior', 'senior', 'starter', 'trainee', 'intern', 'internship', 'stage', 'stagiair', 'entry', 'graduate', 'lead', 'principal', 'staff']);

/** The words a job must mention to belong to a search ("junior SOC analyst" -> soc, analyst). */
export function searchWords(q: string): string[] {
  const all = [...new Set(q.toLowerCase().split(/[^\p{L}\p{N}+#]+/u).filter((w) => w.length >= 2 && !STOP.has(w)))];
  const core = all.filter((w) => !LEVEL.has(w));
  return (core.length ? core : all).slice(0, 8);
}

/**
 * The word sets of a search: one per title it names ("SOC Analyst, Security Analyst" is either one). Kept as
 * "soc analyst|security analyst".
 */
export function searchAlternatives(q: string): string[][] {
  return q.split(/\s*(?:,|;|\|| or )\s*/i).map(searchWords).filter((w) => w.length).slice(0, 3);
}

/**
 * true when the text mentions every search word: a word of up to three letters (SOC, IT, UX) as a whole word, one of
 * four or five letters at the start of a word ("cyber" in "cybersecurity"), a longer one anywhere or by its first
 * four letters ("analyst" finds the Dutch "analist"). The engines often answer with jobs that only share the site;
 * this keeps the cards to the search.
 */
export function mentionsAll(text: string, words: string[]): boolean {
  const t = text.toLowerCase();
  const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return words.every((w) => {
    if (w.length <= 3) return new RegExp(`(^|[^\\p{L}\\p{N}])${esc(w)}($|[^\\p{L}\\p{N}])`, 'u').test(t);
    if (w.length <= 5) return new RegExp(`(^|[^\\p{L}\\p{N}])${esc(w)}`, 'u').test(t);
    return t.includes(w) || t.includes(w.slice(0, 4));
  });
}

