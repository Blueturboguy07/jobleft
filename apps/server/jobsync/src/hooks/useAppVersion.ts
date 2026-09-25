import { useState, useEffect } from "react";
import { AppVersionInfo } from "@/models/version.model";

export function useAppVersion() {
  const [version, setVersion] = useState<AppVersionInfo | null>(null);

  useEffect(() => {
    let active = true;

    fetch("/api/version")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: AppVersionInfo | null) => {
        if (active) setVersion(data);
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, []);

  return version;
}
