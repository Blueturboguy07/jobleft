"use client";

import { useEffect } from "react";

// Clearing the cookie is the only way out of a session whose user row is
// gone: redirecting alone loops, because auth.config sends anyone holding a
// valid token back to /dashboard.
function StaleSessionSignOut({
  signOutAction,
}: {
  signOutAction: () => Promise<void>;
}) {
  useEffect(() => {
    signOutAction();
  }, [signOutAction]);

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-muted/40">
      <p className="text-sm text-muted-foreground">
        Your session is no longer valid. Signing you out&hellip;
      </p>
    </div>
  );
}

export default StaleSessionSignOut;
