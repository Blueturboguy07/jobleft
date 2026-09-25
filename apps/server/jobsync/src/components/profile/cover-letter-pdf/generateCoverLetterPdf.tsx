import React from "react";
import { format } from "date-fns";
import { htmlToPdfNodes } from "@/components/pdf-export/html-to-pdf";
import { sanitizeFilename } from "@/components/pdf-export/download";
import type { ContactInfo } from "@/models/profile.model";
import type { CoverLetterExportSettings } from "@/models/coverLetterExport.model";
import { buildLetterStyles } from "./styles/letter.styles";
import { stripEmptyParagraphs } from "./stripEmptyParagraphs";

export async function generateCoverLetterPdfBlob(
  letter: { title: string; content: string },
  contactInfo: ContactInfo | null,
  settings: CoverLetterExportSettings,
): Promise<{ blob: Blob; filename: string }> {
  const { pdf, Font } = await import("@react-pdf/renderer");
  Font.registerHyphenationCallback((word) => [word]);

  const { styles, htmlStyles } = buildLetterStyles(settings);
  // Parse on the main thread before entering react-pdf's rendering context.
  const bodyNodes = htmlToPdfNodes(
    stripEmptyParagraphs(letter.content),
    htmlStyles,
  );

  // Spelled-out month, the conventional business-letter form — deliberately
  // not the app's "PP", whose abbreviated month reads as UI, not letterhead.
  const dateLabel = format(new Date(), "MMMM d, yyyy");

  const { CoverLetterDocument } = await import("./CoverLetterTemplate");
  const document = (
    <CoverLetterDocument
      title={letter.title}
      contactInfo={contactInfo}
      dateLabel={dateLabel}
      bodyNodes={bodyNodes}
      styles={styles}
    />
  );

  const blob = await pdf(document as any).toBlob();
  // A letter has exactly one style, so the suffix names the document type
  // rather than a layout — it is what tells the two exports apart on disk.
  const filename = `${sanitizeFilename(letter.title, "Untitled")}_cover_letter.pdf`;
  return { blob, filename };
}
