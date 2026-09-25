"use client";
import { useEffect, useState } from "react";
import {
  getFromLocalStorage,
  saveToLocalStorage,
} from "@/utils/localstorage.utils";

type Options<T> = {
  /** Module-level constant at every call site — it is an effect dependency. */
  defaults: T;
  /** Module-level function at every call site, for the same reason. */
  coerce: (stored: unknown) => T;
  storageKey: string;
  open: boolean;
};

// Reads on open rather than at mount: localStorage is unavailable during SSR,
// and `ready` holds the preview back one commit so it generates once, with
// the stored settings, instead of once with the defaults and again after.
export function useExportSettings<T>({
  defaults,
  coerce,
  storageKey,
  open,
}: Options<T>) {
  const [settings, setSettings] = useState<T>(defaults);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!open) {
      setReady(false);
      return;
    }
    let next: T;
    try {
      next = coerce(getFromLocalStorage(storageKey, null));
    } catch {
      // getFromLocalStorage calls JSON.parse unguarded.
      next = defaults;
    }
    setSettings(next);
    setReady(true);
  }, [open, storageKey, defaults, coerce]);

  const update = (next: T) => {
    setSettings(next);
    saveToLocalStorage(storageKey, next);
  };

  return {
    settings,
    setSettings: update,
    ready,
    // Passed through, not spread: spreading an unconstrained generic does
    // not reliably narrow back to T, and nothing here mutates settings in
    // place.
    reset: () => update(defaults),
  };
}
