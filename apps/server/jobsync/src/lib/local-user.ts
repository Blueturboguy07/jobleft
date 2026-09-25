import prisma from "@/lib/db";
import { CONTACT_ROLES, JOB_SOURCES, JOB_STATUSES } from "@/lib/constants";

// Single-user desktop mode (jobleft). Set LOCAL_MODE=1 and the app never shows
// a sign-in screen: every auth() call returns this one fixed user, created on
// first use with the same seed rows the signup action writes.
export const LOCAL_USER = {
  id: "local-user",
  name: "Local user",
  email: "local@jobleft.invalid",
} as const;

export const isLocalMode = () => process.env.LOCAL_MODE === "1";

let pending: Promise<void> | null = null;

export function ensureLocalUser(): Promise<void> {
  pending ??= (async () => {
    const existing = await prisma.user.findUnique({
      where: { id: LOCAL_USER.id },
      select: { id: true },
    });
    if (!existing) {
      // "!" is not a bcrypt hash, so password sign-in can never match this row.
      await prisma.user.create({ data: { ...LOCAL_USER, password: "!" } });
      await prisma.jobSource.createMany({
        data: JOB_SOURCES.map((s) => ({
          label: s.label,
          value: s.value,
          createdBy: LOCAL_USER.id,
        })),
      });
      await prisma.contactRole.createMany({
        data: CONTACT_ROLES.map((r) => ({
          label: r.label,
          value: r.value,
          createdBy: LOCAL_USER.id,
        })),
      });
    }
    for (const status of JOB_STATUSES) {
      await prisma.jobStatus.upsert({
        where: { value: status.value },
        update: {},
        create: status,
      });
    }
  })().catch((error) => {
    pending = null; // let the next request retry
    throw error;
  });
  return pending;
}
