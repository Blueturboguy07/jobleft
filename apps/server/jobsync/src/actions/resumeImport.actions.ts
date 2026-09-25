"use server";

// The single resolveImportCard action, split into src/actions/resumeImport/:
// each card type's save logic lives in its own module, with parseImportDate,
// wrapAsHtml and getOrCreateResumeSection shared across them via ./resumeImport/shared.

import { requireUser } from "./shared";
import { assertResumeOwnership } from "./profile/shared";
import { handleError } from "@/lib/utils";
import {
  ImportContactInfo,
  ImportExperience,
  ImportEducation,
  ImportCertification,
  ImportSkills,
} from "@/models/resumeImport.schema";
import { saveContactInfoCard } from "./resumeImport/contactInfo";
import { saveSummaryCard } from "./resumeImport/summary";
import { saveExperienceCard } from "./resumeImport/experience";
import { saveEducationCard } from "./resumeImport/education";
import { saveCertificationCard } from "./resumeImport/certification";
import { saveSkillsCard } from "./resumeImport/skills";

export type ImportCardPayload =
  | { type: "contactInfo"; data: ImportContactInfo }
  | { type: "summary"; data: string }
  | { type: "experience"; data: ImportExperience }
  | { type: "education"; data: ImportEducation }
  | { type: "certification"; data: ImportCertification }
  | { type: "skills"; data: ImportSkills };

export type ResolveResult =
  | { success: true; status: "saved" }
  | { success: false; message: string };

export async function resolveImportCard(
  resumeId: string,
  card: ImportCardPayload,
): Promise<ResolveResult> {
  try {
    const user = await requireUser();
    await assertResumeOwnership(resumeId, user.id);

    switch (card.type) {
      case "contactInfo":
        await saveContactInfoCard(resumeId, user.id, card.data);
        break;
      case "summary":
        await saveSummaryCard(resumeId, card.data);
        break;
      case "experience":
        await saveExperienceCard(resumeId, user.id, card.data);
        break;
      case "education":
        await saveEducationCard(resumeId, user.id, card.data);
        break;
      case "certification":
        await saveCertificationCard(resumeId, user.id, card.data);
        break;
      case "skills":
        await saveSkillsCard(resumeId, user.id, card.data);
        break;
    }

    return { success: true, status: "saved" };
  } catch (error) {
    const msg = "Failed to save imported section.";
    const result = handleError(error, msg);
    return { success: false, message: result?.message ?? msg };
  }
}
