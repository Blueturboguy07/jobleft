"use server";
import prisma from "@/lib/db";
import { handleError } from "@/lib/utils";
import { AddContactInfoFormSchema } from "@/models/addContactInfoForm.schema";
import type { ContactInfo } from "@/models/profile.model";
import { getCurrentUser } from "@/utils/user.utils";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "./shared";

export const addContactInfo = async (
  data: z.infer<typeof AddContactInfoFormSchema>,
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const res = await prisma.resume.update({
      where: {
        id: data.resumeId,
        profile: { userId: user.id },
      },
      data: {
        ContactInfo: {
          connectOrCreate: {
            where: { resumeId: data.resumeId },
            create: {
              firstName: data.firstName,
              lastName: data.lastName,
              headline: data.headline,
              email: data.email!,
              phone: data.phone!,
              address: data.address,
              url1: data.url1 || null,
              url1Label: data.url1Label || null,
              url2: data.url2 || null,
              url2Label: data.url2Label || null,
            },
          },
        },
      },
    });
    revalidatePath("/dashboard/profile/resume");
    return { data: res, success: true };
  } catch (error) {
    const msg = "Failed to create contact info.";
    return handleError(error, msg);
  }
};

export const updateContactInfo = async (
  data: z.infer<typeof AddContactInfoFormSchema>,
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const res = await prisma.contactInfo.update({
      where: {
        id: data.id,
        resume: { profile: { userId: user.id } },
      },
      data: {
        firstName: data.firstName,
        lastName: data.lastName,
        headline: data.headline,
        email: data.email!,
        phone: data.phone!,
        address: data.address,
        url1: data.url1 || null,
        url1Label: data.url1Label || null,
        url2: data.url2 || null,
        url2Label: data.url2Label || null,
      },
    });
    revalidatePath("/dashboard/profile/resume");
    return { data: res, success: true };
  } catch (error) {
    const msg = "Failed to update contact info.";
    return handleError(error, msg);
  }
};

// Returns a bare value rather than a result envelope, matching the shape of
// getDefaultResumeId next door. Null means "no letterhead" — the letter then
// degrades to date + body.
//
// getCurrentUser, not this module's usual requireUser: "no session" has to
// return null like every other no-letterhead case, not throw past the caller.
// Do not "fix" this into requireUser — the null is the contract.
export const getDefaultContactInfo = async (): Promise<ContactInfo | null> => {
  const user = await getCurrentUser();
  if (!user) return null;

  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { defaultResumeId: true },
  });
  if (!row?.defaultResumeId) return null;

  // Ownership chain, never the resume id alone.
  const contactInfo = await prisma.contactInfo.findFirst({
    where: {
      resumeId: row.defaultResumeId,
      resume: { profile: { userId: user.id } },
    },
  });
  return (contactInfo as ContactInfo | null) ?? null;
};
