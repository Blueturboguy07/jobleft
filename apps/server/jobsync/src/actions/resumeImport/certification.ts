import prisma from "@/lib/db";
import { SectionType } from "@/models/profile.model";
import type { ImportCertification } from "@/models/resumeImport.schema";
import { getOrCreateResumeSection, parseImportDate } from "./shared";

export async function saveCertificationCard(
  resumeId: string,
  userId: string,
  d: ImportCertification,
): Promise<void> {
  const section = await getOrCreateResumeSection(
    resumeId,
    SectionType.CERTIFICATION,
    "Certifications",
  );

  await prisma.resumeSection.update({
    where: { id: section.id, Resume: { profile: { userId } } },
    data: {
      licenseOrCertifications: {
        create: {
          title: d.title,
          organization: d.organization ?? "",
          issueDate: parseImportDate(d.issueDate) ?? undefined,
          expirationDate: parseImportDate(d.expirationDate) ?? undefined,
          credentialUrl: d.credentialUrl,
        },
      },
    },
  });
}
