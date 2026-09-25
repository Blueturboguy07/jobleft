import type { NextRequest } from "next/server";
import { APP_CONSTANTS } from "@/lib/constants";

// Checked before req.formData(), which buffers the entire body into memory.
// Checking file.size afterwards reports the problem but does not prevent it.
export function isOverUploadCap(req: NextRequest): boolean {
  const declared = Number(req.headers.get("content-length"));
  return (
    Number.isFinite(declared) &&
    declared > APP_CONSTANTS.BACKUP_MAX_UPLOAD_BYTES
  );
}
