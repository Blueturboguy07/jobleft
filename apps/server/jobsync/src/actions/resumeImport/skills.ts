import prisma from "@/lib/db";
import { SectionType } from "@/models/profile.model";
import { resolveTag } from "@/lib/jobs/resolve";
import { APP_CONSTANTS } from "@/lib/constants";
import type { ImportSkills } from "@/models/resumeImport.schema";

export async function saveSkillsCard(
  resumeId: string,
  userId: string,
  data: ImportSkills,
): Promise<void> {
  // Drop empty categories/skills and enforce the same caps as the
  // manual skills form before resolving names to shared tags.
  const categories = (data.categories ?? [])
    .map((cat) => ({
      label: cat.label?.trim() || null,
      skills: (cat.skills ?? [])
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, APP_CONSTANTS.MAX_SKILLS_PER_CATEGORY),
    }))
    .filter((cat) => cat.skills.length > 0)
    .slice(0, APP_CONSTANTS.MAX_SKILL_CATEGORIES);

  if (categories.length === 0) {
    throw new Error("No skills to import");
  }

  const section = await prisma.resumeSection.create({
    data: {
      resumeId,
      sectionTitle: "Skills",
      sectionType: SectionType.SKILLS,
    },
  });

  let order = 0;
  const skillRows: {
    tagId: string;
    category: string | null;
    order: number;
    resumeSectionId: string;
  }[] = [];
  for (const cat of categories) {
    for (const name of cat.skills) {
      const tag = await resolveTag(name, userId);
      skillRows.push({
        tagId: tag.id,
        category: cat.label,
        order: order++,
        resumeSectionId: section.id,
      });
    }
  }

  await prisma.skill.createMany({ data: skillRows });
}
