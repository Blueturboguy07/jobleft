import {
  clampNumericField,
  PDF_FONT_LABELS,
  type NumericSetting,
  type PdfFont,
} from "./pdfExport.model";

export interface CoverLetterExportSettings {
  font: PdfFont;
  fontSize: number;
  lineHeight: number;
  marginVertical: number;
  marginHorizontal: number;
  paragraphSpacing: number;
}

// The explicit list the coercion iterates. Iterating the merged
// PDF_NUMERIC_SETTINGS table would leak the resume's spacing fields in.
export const COVER_LETTER_NUMERIC_FIELDS = [
  "fontSize",
  "lineHeight",
  "marginVertical",
  "marginHorizontal",
  "paragraphSpacing",
] as const satisfies readonly NumericSetting[];

export type CoverLetterNumericSetting =
  (typeof COVER_LETTER_NUMERIC_FIELDS)[number];

// A letter is a one-page document with more air than a resume: wider
// margins, and a real gap between paragraphs instead of the resume's 2pt.
export const defaultCoverLetterExportSettings: CoverLetterExportSettings = {
  font: "helvetica",
  fontSize: 11,
  lineHeight: 1.4,
  marginVertical: 54,
  marginHorizontal: 54,
  paragraphSpacing: 10,
};

// Rebuilt from a spread of the defaults, so a stored object can only ever
// contribute values — never extra keys, and never a missing one.
export function coerceCoverLetterExportSettings(
  stored: unknown,
): CoverLetterExportSettings {
  const next = { ...defaultCoverLetterExportSettings };
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return next;
  }
  const raw = stored as Record<string, unknown>;

  if (typeof raw.font === "string" && raw.font in PDF_FONT_LABELS) {
    next.font = raw.font as PdfFont;
  }

  // clampNumericField returns the passed default for anything that is not a
  // finite number, so a missing key needs no guard.
  for (const field of COVER_LETTER_NUMERIC_FIELDS) {
    next[field] = clampNumericField(
      field,
      raw[field],
      defaultCoverLetterExportSettings[field],
    );
  }

  return next;
}
