// Export: a one-page PDF and a Word file with the same content, and the same for cover letters.

import type { ResumeDocument } from '@jobleft/contracts';
import { documentText } from '../document.ts';
import { ResumeError } from '../errors.ts';
import { letterDocx, resumeDocx } from './docx.ts';
import { fitLetter, fitResume, type FitResult } from './layout.ts';
import { unsupportedChars, writePdf } from './pdf-writer.ts';

function checkChars(text: string): void {
  const bad = unsupportedChars(text);
  if (bad.length) {
    throw new ResumeError('bad_request', `The PDF cannot show these characters yet: ${bad.slice(0, 8).join(' ')}. jobleft never replaces or drops letters, so it did not make the PDF. Export the Word file instead (it keeps every character).`, { characters: bad });
  }
}

export interface RenderedResume { bytes: Uint8Array; pages: number; leftOut: string[]; fit: FitResult }

/** One page, always. Shrinks first; leaves out whole items only when it must, and lists each one. */
export function renderResumePdf(doc: ResumeDocument): RenderedResume {
  checkChars(documentText(doc));
  const fit = fitResume(doc);
  if (!fit.fits && fit.leftOut.length === 0 && fitOverflowed(fit)) {
    throw new ResumeError('conflict', 'The resume does not fit on one page even at the smallest print size. Shorten the header or the skills list and try again.');
  }
  if (fitOverflowed(fit)) {
    throw new ResumeError('conflict', 'The resume does not fit on one page even after leaving out older items. Shorten it in your profile and try again.', { leftOut: fit.leftOut });
  }
  const bytes = writePdf([fit.page], { title: `${doc.header.name} resume`.trim(), subject: 'Resume' });
  return { bytes, pages: 1, leftOut: fit.leftOut, fit };
}

function fitOverflowed(fit: FitResult): boolean {
  return fit.page.runs.some((r) => r.y < fit.params.margin - 0.5);
}

/** The Word file holds exactly what the PDF holds (same left-out items, same order). */
export function renderResumeDocx(doc: ResumeDocument): { bytes: Uint8Array; leftOut: string[] } {
  const fit = fitResume(doc);
  return { bytes: resumeDocx(fit.doc, fit.params), leftOut: fit.leftOut };
}

export function renderLetterPdf(text: string): Uint8Array {
  checkChars(text);
  const fit = fitLetter(text);
  if (!fit.fits) throw new ResumeError('conflict', 'The letter is longer than one page. Shorten it (for example ask "make it shorter") and export again.');
  return writePdf([fit.page], { title: 'Cover letter', subject: 'Cover letter' });
}

export function renderLetterDocx(text: string): Uint8Array {
  const fit = fitLetter(text);
  if (!fit.fits) throw new ResumeError('conflict', 'The letter is longer than one page. Shorten it (for example ask "make it shorter") and export again.');
  return letterDocx(text, fit.params);
}
