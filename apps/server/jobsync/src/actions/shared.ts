import { getCurrentUser } from "@/utils/user.utils";

// Not a "use server" module: shared across the action directories, so it must
// stay importable without becoming a callable server-action endpoint.

export const requireUser = async () => {
  const user = await getCurrentUser();
  if (!user) {
    throw new Error("Not authenticated");
  }
  return user;
};
