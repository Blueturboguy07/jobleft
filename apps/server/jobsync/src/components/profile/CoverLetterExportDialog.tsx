"use client";

import { useCallback, useMemo } from "react";
import { PdfExportDialog } from "@/components/pdf-export/PdfExportDialog";
import { triggerDownload } from "@/components/pdf-export/download";
import { useExportSettings } from "@/components/pdf-export/useExportSettings";
import { usePdfPreview } from "@/components/pdf-export/usePdfPreview";
import { APP_CONSTANTS } from "@/lib/constants";
import { toastError, toastSuccess } from "@/lib/toast";
import { settingsKey } from "@/models/pdfExport.model";
import type { ContactInfo } from "@/models/profile.model";
import {
  coerceCoverLetterExportSettings,
  defaultCoverLetterExportSettings,
  type CoverLetterExportSettings,
} from "@/models/coverLetterExport.model";
import { CoverLetterSettingsPanel } from "./cover-letter-export-dialog/CoverLetterSettingsPanel";
import { canExportCoverLetter } from "./cover-letter-export-dialog/canExportCoverLetter";

const EMPTY_MESSAGE = "Add some content to this cover letter to preview it.";

type CoverLetterExportDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  letter: { title: string; content: string } | null;
  /** undefined while the default-resume lookup is still in flight. */
  contactInfo: ContactInfo | null | undefined;
};

export function CoverLetterExportDialog({
  open,
  onOpenChange,
  letter,
  contactInfo,
}: CoverLetterExportDialogProps) {
  const { settings, setSettings, ready, reset } = useExportSettings({
    storageKey: APP_CONSTANTS.COVER_LETTER_EXPORT_SETTINGS_STORAGE_KEY,
    defaults: defaultCoverLetterExportSettings,
    coerce: coerceCoverLetterExportSettings,
    open,
  });

  const isDefault =
    settingsKey(settings) === settingsKey(defaultCoverLetterExportSettings);

  // Memoized because the editor trigger re-renders this on every keystroke,
  // and the guard parses the whole letter.
  const canExport = useMemo(
    () => canExportCoverLetter(letter?.content),
    [letter?.content],
  );

  // undefined means the default-resume lookup has not come back. The preview
  // must not start without it, or the first blob renders with no letterhead
  // and is thrown away for a second one that has it.
  const letterheadPending = contactInfo === undefined;

  // The dynamic import stays here, so @react-pdf/renderer never reaches an
  // eagerly-loaded chunk.
  const generate = useCallback(
    async (next: CoverLetterExportSettings) => {
      const { generateCoverLetterPdfBlob } = await import(
        "./cover-letter-pdf/generateCoverLetterPdf"
      );
      return generateCoverLetterPdfBlob(letter!, contactInfo ?? null, next);
    },
    [letter, contactInfo],
  );

  const { blob, filename, isGenerating, error } = usePdfPreview(
    generate,
    settings,
    open && ready && canExport && !letterheadPending,
  );

  const onExport = async (
    prepared: { blob: Blob; filename: string } | null,
  ) => {
    if (!letter || !canExportCoverLetter(letter.content)) {
      toastError("Add some content before exporting.", "Nothing to export");
      return;
    }
    try {
      // The blob on screen is the artifact; generating is the fallback for a
      // failed preview.
      const output = prepared ?? (await generate(settings));
      triggerDownload(output.blob, output.filename);
      toastSuccess("Saved to your Downloads folder.", "PDF exported");
    } catch {
      toastError("Failed to generate PDF. Please try again.");
    }
  };

  return (
    <PdfExportDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Export to PDF"
      description="Adjust the settings and preview the file before exporting."
      previewLabel="Cover letter preview"
      emptyMessage={EMPTY_MESSAGE}
      blob={blob}
      filename={filename}
      isGenerating={isGenerating}
      isPending={letterheadPending}
      hasError={!!error}
      canExport={canExport}
      onExport={onExport}
      settingsPanel={
        <CoverLetterSettingsPanel
          settings={settings}
          onChange={setSettings}
          onReset={reset}
          isDefault={isDefault}
          hasLetterhead={contactInfo !== null}
        />
      }
    />
  );
}
