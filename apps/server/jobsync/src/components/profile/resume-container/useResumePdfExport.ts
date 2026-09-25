"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { triggerDownload } from "@/components/pdf-export/download";
import { toastError, toastSuccess } from "@/lib/toast";
import type { Resume } from "@/models/profile.model";
import {
  defaultResumeExportSettings,
  type ResumeExportSettings,
} from "@/models/resumeExport.model";

// The one rule for what counts as an exportable resume. The dialog reads it to
// disable Export up front; the hook keeps it as its own safety net.
export function canExportResume(resume: Resume): boolean {
  const hasName = Boolean(
    resume.ContactInfo?.firstName?.trim() ||
      resume.ContactInfo?.lastName?.trim(),
  );
  const hasSections = Boolean(
    resume.ResumeSections?.some(
      (s) =>
        s.summary?.content ||
        s.workExperiences?.length ||
        s.educations?.length ||
        s.licenseOrCertifications?.length ||
        s.skills?.length,
    ),
  );
  return hasName || hasSections;
}

// Owns PDF export: generating the blob, downloading it, and the follow-up
// prompt when the resume already has a file attached.
export function useResumePdfExport(resume: Resume) {
  const router = useRouter();
  const [isExporting, setIsExporting] = useState(false);
  const [pendingPdf, setPendingPdf] = useState<{
    blob: Blob;
    filename: string;
  } | null>(null);
  const [showAttachConfirm, setShowAttachConfirm] = useState(false);

  const uploadPdfAsAttachment = async (
    blob: Blob,
    filename: string,
    replaceExisting: boolean,
  ) => {
    const formData = new FormData();
    formData.append(
      "file",
      new File([blob], filename, { type: "application/pdf" }),
    );
    formData.append("title", resume.title);
    formData.append("id", resume.id!);
    if (replaceExisting && resume.FileId) {
      formData.append("fileId", resume.FileId);
    }
    const res = await fetch("/api/profile/resume", {
      method: "POST",
      body: formData,
    });
    if (!res.ok) throw new Error("Upload failed");
    router.refresh();
  };

  const handleExportPdf = async (
    settings: ResumeExportSettings = defaultResumeExportSettings,
    prepared?: { blob: Blob; filename: string } | null,
  ) => {
    if (!canExportResume(resume)) {
      toastError(
        "Add your contact info and at least one section (Summary, Experience, or Education) before exporting.",
        "Nothing to export",
      );
      return;
    }

    setIsExporting(true);
    try {
      // The dialog hands back the blob already on screen; generating is the
      // fallback for a failed preview or a caller with no preview at all.
      let output = prepared;
      if (!output) {
        const { generateResumePdfBlob } = await import("../resume-pdf");
        output = await generateResumePdfBlob(resume, settings);
      }
      const { blob, filename } = output;

      if (!resume.FileId) {
        triggerDownload(blob, filename);
        await uploadPdfAsAttachment(blob, filename, false);
        toastSuccess("Saved to Downloads and attached to this resume.", "PDF exported");
      } else {
        setPendingPdf({ blob, filename });
        setShowAttachConfirm(true);
      }
    } catch {
      toastError("Failed to generate PDF. Please try again.");
    } finally {
      setIsExporting(false);
    }
  };

  const handleAttachChoice = async (choice: "replace" | "download-only") => {
    if (!pendingPdf) return;
    setShowAttachConfirm(false);
    setIsExporting(true);
    try {
      const { blob, filename } = pendingPdf;
      triggerDownload(blob, filename);
      if (choice === "replace") {
        await uploadPdfAsAttachment(blob, filename, true);
        toastSuccess("Saved to Downloads and attachment replaced.", "PDF exported");
      } else {
        toastSuccess("Saved to your Downloads folder.", "PDF exported");
      }
    } catch {
      toastError("Failed to upload PDF. Please try again.");
    } finally {
      setIsExporting(false);
      setPendingPdf(null);
    }
  };

  const cancelAttach = () => {
    setShowAttachConfirm(false);
    setPendingPdf(null);
  };

  return {
    isExporting,
    showAttachConfirm,
    setShowAttachConfirm,
    handleExportPdf,
    handleAttachChoice,
    cancelAttach,
  };
}
