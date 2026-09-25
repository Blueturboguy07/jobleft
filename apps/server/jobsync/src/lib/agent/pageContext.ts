import type { PageContext } from "@/models/agent.model";

// The app's page vocabulary, owned here rather than in the chat panel: the
// client derives pageContext from these patterns and the chat route derives
// the model's page line from the same ones. Two copies would drift.
const RESUME_ROUTE = /^\/dashboard\/profile\/resume\/([^/]+)$/;
const JOB_ROUTE = /^\/dashboard\/myjobs\/([^/]+)$/;
const JOBS_LIST_ROUTE = /^\/dashboard\/myjobs\/?$/;

export type PageLocation = "job" | "jobs-list" | "resume" | "elsewhere";

export function pageContextFor(pathname: string): PageContext {
  const resumeId = pathname.match(RESUME_ROUTE)?.[1];
  const jobId = pathname.match(JOB_ROUTE)?.[1];
  return {
    route: pathname,
    ...(resumeId ? { resumeId } : {}),
    ...(jobId ? { jobId } : {}),
  };
}

// Keyed on the ids first, because jobId is what match_job and
// generate_cover_letter actually read — a label derived from the route could
// tell the user no job is open while the tool happily scores one.
export function pageLocationOf(pageContext?: PageContext): PageLocation {
  if (pageContext?.jobId) return "job";
  if (pageContext?.resumeId) return "resume";
  if (JOBS_LIST_ROUTE.test(pageContext?.route ?? "")) return "jobs-list";
  return "elsewhere";
}
