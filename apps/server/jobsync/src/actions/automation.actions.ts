// Barrel for the automation server actions, split into src/actions/automation/.
// Each module below carries its own "use server"; this file only re-exports so
// the long-standing "@/actions/automation.actions" import path keeps working.

export { getAutomationsList, getAutomationById } from "./automation/queries";

export {
  createAutomation,
  updateAutomation,
  deleteAutomation,
  pauseAutomation,
  resumeAutomation,
} from "./automation/mutations";

export {
  getDiscoveredJobs,
  getDiscoveredJobById,
  dismissDiscoveredJob,
  clearDiscoveredJobs,
  acceptDiscoveredJob,
} from "./automation/discoveredJobs";

export { analyzeDiscoveredJob } from "./automation/analyze";

export { getAutomationRuns, deleteAutomationRun } from "./automation/runs";
