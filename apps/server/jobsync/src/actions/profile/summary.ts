"use server";
import prisma from "@/lib/db";
import { handleError } from "@/lib/utils";
import { AddSummarySectionFormSchema } from "@/models/addSummaryForm.schema";
import { SectionType } from "@/models/profile.model";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertResumeOwnership, requireUser } from "./shared";

export const addResumeSummary = async (
  data: z.infer<typeof AddSummarySectionFormSchema>,
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    await assertResumeOwnership(data.resumeId!, user.id);

    const res = await prisma.resumeSection.create({
      data: {
        resumeId: data.resumeId!,
        sectionTitle: data.sectionTitle!,
        sectionType: SectionType.SUMMARY,
      },
    });

    const summary = await prisma.resumeSection.update({
      where: {
        id: res.id,
      },
      data: {
        summary: {
          create: {
            content: data.content!,
          },
        },
      },
    });
    revalidatePath(`/dashboard/profile/resume/${data.resumeId}`);
    return { data: summary, success: true };
  } catch (error) {
    const msg = "Failed to create summary.";
    return handleError(error, msg);
  }
};

export const updateResumeSummary = async (
  data: z.infer<typeof AddSummarySectionFormSchema>,
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const res = await prisma.resumeSection.update({
      where: {
        id: data.id,
        Resume: { profile: { userId: user.id } },
      },
      data: {
        sectionTitle: data.sectionTitle!,
      },
    });

    const summary = await prisma.resumeSection.update({
      where: {
        id: data.id,
        Resume: { profile: { userId: user.id } },
      },
      data: {
        summary: {
          update: {
            content: data.content!,
          },
        },
      },
    });
    revalidatePath(`/dashboard/profile/resume/${data.resumeId}`);
    return { data: summary, success: true };
  } catch (error) {
    const msg = "Failed to update summary.";
    return handleError(error, msg);
  }
};
