import "server-only";
import { auth } from "@/auth";
import prisma from "@/lib/db";
import { CurrentUser } from "@/models/user.model";

export const getCurrentUser = async () => {
  const session = await auth();
  if (!session?.user?.id) return null;
  // A JWT carries no proof the row still exists. Replace the database and the
  // signed cookie points at nothing, which every ownership-scoped query reads
  // as "no data" rather than "not signed in".
  const exists = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true },
  });
  if (!exists) return null;
  const user: CurrentUser = {
    id: session.user.id,
    name: session.user.name ?? "",
    email: session.user.email ?? "",
  };
  return user;
};
