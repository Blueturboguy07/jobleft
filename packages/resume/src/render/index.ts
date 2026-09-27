// Export: a one-page PDF and a Word file with the same content, and the same for cover letters.

import type { ResumeDocument } from '@jobleft/contracts';
import { documentText } from '../document.ts';
import { ResumeError } from '../errors.ts';
import { letterDocx, resumeDocx } from './docx.ts';
import { fitLetter, fitResume, type FitResult } from './layout.ts';
import { chooseFonts, resetFonts, writePdf } from './pdf-writer.ts';

/**
 * Picks fonts that can show every character, or refuses (jobleft never replaces or drops a letter). The refusal says
 * where the characters are and what the person can do in the app (JL-resume-7); the font setting stays in the docs.
 */
function withFontsFor<T>(text: string, f: () => T, where: (ch: string) => string | null = () => null): T {
  const c = chooseFonts(text);
  if (!c.ok) {
    const places = [...new Set(c.missing.map(where).filter((x): x is string => !!x))];
    const at = places.length ? ` (in ${places.slice(0, 3).join(', ')})` : '';
    throw new ResumeError('bad_request', `The PDF cannot show these characters: ${c.missing.slice(0, 8).join(' ')}${at}. No font jobleft can use on this computer has them, and jobleft never replaces or drops letters, so it did not make the PDF. Export the Word file instead (it keeps every character), or remove these characters and export again.`, { characters: c.missing, where: places });
  }
  try { return f(); } finally { resetFonts(); }
}

/** Where a character first appears in a resume: "your name or contact details (from your profile)" or a section title. */
function placeOf(doc: ResumeDocument): (ch: string) => string | null {
  return (ch) => {
    const h = doc.header;
    if ([h.name, h.email, h.phone, h.city, ...h.links.map((l) => l.url)].some((x) => x?.includes(ch))) return 'your name or contact details (from your profile)';
    const s = doc.sections.find((x) => [x.title, x.text ?? '', ...x.items.flatMap((i) => [i.heading, i.subheading, i.location, ...i.bullets, ...i.tags])].some((t) => t?.includes(ch)));
    return s ? `the ${s.title || 'untitled'} section` : null;
  };
}

export interface RenderedResume { bytes: Uint8Array; pages: number; leftOut: string[]; fit: FitResult }

/** One page, always. Shrinks first; leaves out whole items only when it must, and lists each one. */
export function renderResumePdf(doc: ResumeDocument): RenderedResume {
  return withFontsFor(documentText(doc), () => {
    const fit = fitResume(doc);
    if (fitOverflowed(fit)) {
      throw new ResumeError('conflict', fit.leftOut.length
        ? 'The resume does not fit on one page even after leaving out older items. Shorten it in your profile and try again.'
        : 'The resume does not fit on one page even at the smallest print size. Shorten the header or the skills list and try again.', { leftOut: fit.leftOut });
    }
    const bytes = writePdf([fit.page], { title: `${doc.header.name} resume`.trim(), subject: 'Resume' });
    return { bytes, pages: 1, leftOut: fit.leftOut, fit };
  }, placeOf(doc));
}

function fitOverflowed(fit: FitResult): boolean {
  return fit.page.runs.some((r) => r.y < fit.params.margin - 0.5);
}

/** The Word file holds exactly what the PDF holds (same left-out items, same order). */
export function renderResumeDocx(doc: ResumeDocument): { bytes: Uint8Array; leftOut: string[] } {
  // The same fit as the PDF (same fonts when this computer has them), so both files hold the same items.
  const c = chooseFonts(documentText(doc));
  try {
    const fit = fitResume(doc);
    return { bytes: resumeDocx(fit.doc, fit.params), leftOut: fit.leftOut };
  } finally {
    if (c.ok) resetFonts();
  }
}

export function renderLetterPdf(text: string): Uint8Array {
  return withFontsFor(text, () => {
    const fit = fitLetter(text);
    if (!fit.fits) throw new ResumeError('conflict', 'The letter is longer than one page. Shorten it (for example ask "make it shorter") and export again.');
    return writePdf([fit.page], { title: 'Cover letter', subject: 'Cover letter' });
  }, () => 'the letter');
}

export function renderLetterDocx(text: string): Uint8Array {
  const c = chooseFonts(text);
  try {
    const fit = fitLetter(text);
    if (!fit.fits) throw new ResumeError('conflict', 'The letter is longer than one page. Shorten it (for example ask "make it shorter") and export again.');
    return letterDocx(text, fit.params);
  } finally {
    if (c.ok) resetFonts();
  }
}
