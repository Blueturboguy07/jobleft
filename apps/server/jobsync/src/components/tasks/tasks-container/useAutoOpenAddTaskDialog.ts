"use client";
import { useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";

// Opens the task dialog once when the page is reached via a `?add-task=true`
// deep link, then strips the param so a refresh doesn't reopen it.
export function useAutoOpenAddTaskDialog(
  setDialogOpen: (open: boolean) => void,
) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const autoOpenHandled = useRef(false);

  useEffect(() => {
    if (autoOpenHandled.current) return;
    if (searchParams.get("add-task") === "true") {
      autoOpenHandled.current = true;
      setDialogOpen(true);
      const params = new URLSearchParams(searchParams.toString());
      params.delete("add-task");
      const newPath = params.toString()
        ? `?${params.toString()}`
        : window.location.pathname;
      router.replace(newPath);
    }
  }, [router, searchParams, setDialogOpen]);
}
