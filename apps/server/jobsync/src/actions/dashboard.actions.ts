// Barrel for the dashboard data functions, split into src/actions/dashboard/.
// Unlike the other action barrels this file and its modules carry no
// "use server": these are plain server-side reads called from the dashboard
// page, and TopActivityType is a type export a client component imports.

export { getJobsActivitySummary } from "./dashboard/stats";
export type { TopActivityType, JobsActivitySummary } from "./dashboard/stats";

export { getRecentJobs, getRecentActivities } from "./dashboard/recent";

export {
  getActivityDataForPeriod,
  getJobsActivityForPeriod,
  getActivityCalendarData,
} from "./dashboard/charts";
