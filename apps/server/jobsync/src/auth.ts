import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { authConfig } from "./auth.config";
import { User } from "./models/user.model";
import prisma from "./lib/db";
import { ensureLocalUser, isLocalMode, LOCAL_USER } from "./lib/local-user";

async function getUser(email: string): Promise<User | undefined> {
  try {
    const user = await prisma.user.findUnique({
      where: { email },
    });
    return user || undefined;
  } catch (error) {
    console.error("Failed to fetch user:", error);
    throw new Error("Failed to fetch user.");
  }
}

const nextAuth = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      async authorize(credentials) {
        const parsedCredentials = z
          .object({ email: z.string().email(), password: z.string().min(6) })
          .safeParse(credentials);

        if (parsedCredentials.success) {
          const { email, password } = parsedCredentials.data;
          const user = await getUser(email);
          if (!user) return null;
          const passwordsMatch = await bcrypt.compare(password, user.password);
          if (passwordsMatch) return user;
        }
        console.log("Invalid credentials");
        return null;
      },
    }),
  ],
});

export const { handlers, signIn, signOut } = nextAuth;

// LOCAL_MODE=1 (jobleft desktop): one fixed user, no sign-in. Calls that pass
// arguments (auth used as a middleware wrapper) still go to NextAuth.
const nextAuthSession = nextAuth.auth;
export const auth = (
  isLocalMode()
    ? async (...args: unknown[]) => {
        if (args.length > 0) return (nextAuthSession as any)(...args);
        await ensureLocalUser();
        return {
          user: { ...LOCAL_USER },
          expires: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        };
      }
    : nextAuthSession
) as typeof nextAuthSession;
