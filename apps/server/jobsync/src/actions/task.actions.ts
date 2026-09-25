// Barrel for the task server actions, split into src/actions/task/.
// Each module below carries its own "use server"; this file only re-exports so
// the long-standing "@/actions/task.actions" import path keeps working.

export {
  getTasksList,
  getTaskById,
  getActivityTypesWithTaskCounts,
} from "./task/queries";

export {
  createTask,
  updateTask,
  updateTaskStatus,
  deleteTaskById,
} from "./task/mutations";

export { startActivityFromTask } from "./task/activity";
