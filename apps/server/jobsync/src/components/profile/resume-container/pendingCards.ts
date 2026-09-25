import type { ImportCardPayload } from "@/actions/resumeImport.actions";
import { ResumeImportData } from "@/models/resumeImport.schema";
import { extractSkillCategories } from "@/utils/skillImport.utils";
import type { DeepPartial } from "ai";

export type PendingCard = {
  id: string;
  card: ImportCardPayload;
};

// Keywords that map to supported section types — filter these out of unrecognizedSections
const SUPPORTED_KEYWORDS = [
  "contact",
  "summary",
  "experience",
  "education",
  "certification",
  "certifications",
  "skill",
  "skills",
];

export function filterUnrecognizedSections(sections: string[]): string[] {
  return sections.filter((section) => {
    const lower = section.toLowerCase();
    return !SUPPORTED_KEYWORDS.some((kw) => lower.includes(kw));
  });
}

// Accepts partial data so cards can render progressively as the import stream
// arrives. Entries are only shown once their key identifying field is present.
export function buildPendingCards(
  data: DeepPartial<ResumeImportData>,
): PendingCard[] {
  const cards: PendingCard[] = [];

  if (!data) return cards;

  if (
    data.contactInfo &&
    Object.keys(data.contactInfo).some(
      (k) => k !== "confidence" && !!(data.contactInfo as any)[k],
    )
  ) {
    cards.push({
      id: "contactInfo",
      card: { type: "contactInfo", data: data.contactInfo as any },
    });
  }

  if (typeof data.summary === "string" && data.summary.trim()) {
    cards.push({
      id: "summary",
      card: { type: "summary", data: data.summary },
    });
  }

  // Skills sit before experience to match the resume's section order.
  const skillCategories = extractSkillCategories(data.skills);
  if (skillCategories.length > 0) {
    cards.push({
      id: "skills",
      card: { type: "skills", data: { categories: skillCategories } as any },
    });
  }

  (data.experience ?? []).forEach((exp, i) => {
    if (!exp || (!exp.company && !exp.jobTitle)) return;
    cards.push({
      id: `experience-${i}`,
      card: { type: "experience", data: exp as any },
    });
  });

  (data.education ?? []).forEach((edu, i) => {
    if (!edu || !edu.institution) return;
    cards.push({
      id: `education-${i}`,
      card: { type: "education", data: edu as any },
    });
  });

  (data.certifications ?? []).forEach((cert, i) => {
    if (!cert || !cert.title) return;
    cards.push({
      id: `certification-${i}`,
      card: { type: "certification", data: cert as any },
    });
  });

  return cards;
}
