import prisma from "@/lib/db";
import type { ImportContactInfo } from "@/models/resumeImport.schema";

export async function saveContactInfoCard(
  resumeId: string,
  userId: string,
  d: ImportContactInfo,
): Promise<void> {
  await prisma.resume.update({
    where: { id: resumeId, profile: { userId } },
    data: {
      ContactInfo: {
        connectOrCreate: {
          where: { resumeId },
          create: {
            firstName: d.firstName ?? "",
            lastName: d.lastName ?? "",
            headline: d.headline ?? "",
            email: d.email ?? "",
            phone: d.phone ?? "",
            address: d.address,
          },
        },
      },
    },
  });
}
