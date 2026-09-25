import prisma from "@/lib/db";
import { SectionType } from "@/models/profile.model";
import { resolveLocation } from "@/lib/jobs/resolve";
import type { ImportEducation } from "@/models/resumeImport.schema";
import { getOrCreateResumeSection, parseImportDate, wrapAsHtml } from "./shared";

export async function saveEducationCard(
  resumeId: string,
  userId: string,
  d: ImportEducation,
): Promise<void> {
  const location = await resolveLocation(
    d.location?.trim() || "Not specified",
    userId,
  );

  const startDate = parseImportDate(d.startDate) ?? new Date(2000, 0, 1);
  const endDate = parseImportDate(d.endDate);

  const section = await getOrCreateResumeSection(
    resumeId,
    SectionType.EDUCATION,
    "Education",
  );

  await prisma.resumeSection.update({
    where: { id: section.id, Resume: { profile: { userId } } },
    data: {
      educations: {
        create: {
          institution: d.institution,
          degree: d.degree ?? "",
          fieldOfStudy: d.fieldOfStudy ?? "",
          locationId: location.id,
          startDate,
          endDate: endDate ?? undefined,
          description: wrapAsHtml(d.description),
        },
      },
    },
  });
}
