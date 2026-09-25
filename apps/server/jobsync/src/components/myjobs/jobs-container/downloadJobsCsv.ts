import { format } from "date-fns";
import { toastError, toastSuccess } from "@/lib/toast";

export async function downloadJobsList() {
  try {
    const res = await fetch("/api/jobs/export", {
      method: "POST",
      headers: {
        "Content-Type": "text/csv",
      },
    });
    if (!res.ok) {
      throw new Error("Failed to download jobs!");
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `jobsync-${format(new Date(), "yyyy-MM-dd")}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toastSuccess("Downloaded successfully!");
  } catch (error) {
    toastError(
      error instanceof Error ? error.message : "Unknown error occurred.",
    );
  }
}
