import prisma from "@/lib/db";
import { SectionType } from "@/models/profile.model";
import {
  resolveCompany,
  resolveJobTitle,
  resolveLocation,
} from "@/lib/jobs/resolve";
import type { ImportExperience } from "@/models/resumeImport.schema";
import { getOrCreateResumeSection, parseImportDate, wrapAsHtml } from "./shared";

export async function saveExperienceCard(
  resumeId: string,
  userId: string,
  d: ImportExperience,
): Promise<void> {
  // Location is required by schema — use a placeholder if none provided
  const [company, jobTitle, location] = await Promise.all([
    resolveCompany(d.company, userId),
    resolveJobTitle(d.jobTitle, userId),
    resolveLocation(d.location?.trim() || "Not specified", userId),
  ]);

  const startDate = parseImportDate(d.startDate) ?? new Date(2000, 0, 1);
  const endDate = parseImportDate(d.endDate);

  const section = await getOrCreateResumeSection(
    resumeId,
    SectionType.EXPERIENCE,
    "Experience",
  );

  await prisma.resumeSection.update({
    where: { id: section.id, Resume: { profile: { userId } } },
    data: {
      workExperiences: {
        create: {
          companyId: company.id,
          jobTitleId: jobTitle.id,
          locationId: location.id,
          startDate,
          endDate: endDate ?? undefined,
          description: wrapAsHtml(d.description),
        },
      },
    },
  });
}
