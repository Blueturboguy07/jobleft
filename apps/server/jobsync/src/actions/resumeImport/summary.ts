import prisma from "@/lib/db";
import { SectionType } from "@/models/profile.model";
import { wrapAsHtml } from "./shared";

export async function saveSummaryCard(
  resumeId: string,
  data: string,
): Promise<void> {
  // Look for existing summary section
  const existingSection = await prisma.resumeSection.findFirst({
    where: { resumeId, sectionType: SectionType.SUMMARY },
    select: { id: true, summaryId: true },
  });

  if (existingSection) {
    // Update existing
    if (existingSection.summaryId) {
      await prisma.summary.update({
        where: { id: existingSection.summaryId },
        data: { content: wrapAsHtml(data) },
      });
    }
  } else {
    // Create new section + summary
    const section = await prisma.resumeSection.create({
      data: {
        resumeId,
        sectionTitle: "Summary",
        sectionType: SectionType.SUMMARY,
      },
    });
    await prisma.resumeSection.update({
      where: { id: section.id },
      data: {
        summary: { create: { content: wrapAsHtml(data) } },
      },
    });
  }
}
