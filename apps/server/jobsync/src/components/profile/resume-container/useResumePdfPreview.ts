"use client";
import { useCallback } from "react";
import { usePdfPreview } from "@/components/pdf-export/usePdfPreview";
import type { Resume } from "@/models/profile.model";
import type { ResumeExportSettings } from "@/models/resumeExport.model";
import { canExportResume } from "./useResumePdfExport";

export function useResumePdfPreview(
  resume: Resume,
  settings: ResumeExportSettings,
  open: boolean,
) {
  // The dynamic import stays here, so the shared hook never pulls
  // @react-pdf/renderer into its own chunk.
  const generate = useCallback(
    async (next: ResumeExportSettings) => {
      const { generateResumePdfBlob } = await import("../resume-pdf");
      return generateResumePdfBlob(resume, next);
    },
    [resume],
  );

  return usePdfPreview(generate, settings, open && canExportResume(resume));
}
