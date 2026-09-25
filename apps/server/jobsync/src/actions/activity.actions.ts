// Barrel for the activity server actions, split into src/actions/activity/.
// Each module below carries its own "use server"; this file only re-exports so
// the long-standing "@/actions/activity.actions" import path keeps working.

export {
  getActivitiesList,
  createActivity,
  deleteActivityById,
} from "./activity/activities";

export {
  startActivityById,
  stopActivityById,
  getCurrentActivity,
} from "./activity/timer";

export { startBreak, endBreak, updateBreakLength } from "./activity/breaks";

export {
  getAllActivityTypes,
  createActivityType,
  getActivityTypeList,
  deleteActivityTypeById,
} from "./activity/activityTypes";
