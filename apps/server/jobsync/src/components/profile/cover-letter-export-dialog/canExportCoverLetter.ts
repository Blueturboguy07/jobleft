// The one rule for what counts as an exportable letter. The dialog reads it
// to disable Export up front; the export handler keeps it as a safety net.
//
// A plain module with no @react-pdf/renderer anywhere in its graph — the
// same reason canExportResume sits outside the resume-pdf barrel. Importing
// it must not pull the renderer into an eagerly-loaded chunk.
export function canExportCoverLetter(
  content: string | null | undefined,
): boolean {
  if (!content || !content.trim()) return false;
  const text = new DOMParser().parseFromString(content, "text/html").body
    .textContent;
  return Boolean(text && text.trim());
}
