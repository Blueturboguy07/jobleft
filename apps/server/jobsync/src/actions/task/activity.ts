"use server";
import prisma from "@/lib/db";
import { handleError } from "@/lib/utils";
import { requireUser } from "../shared";

export const startActivityFromTask = async (
  taskId: string
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const task = await prisma.task.findFirst({
      where: {
        id: taskId,
        userId: user.id,
      },
    });

    if (!task) {
      return { success: false, message: "Task not found" };
    }

    if (task.status === "complete" || task.status === "cancelled") {
      return {
        success: false,
        message: "Cannot start an activity from a completed or cancelled task.",
      };
    }

    if (!task.activityTypeId) {
      return {
        success: false,
        message: "Task must have an activity type to start an activity.",
      };
    }

    const runningActivity = await prisma.activity.findFirst({
      where: {
        userId: user.id,
        endTime: null,
      },
    });

    if (runningActivity) {
      return {
        success: false,
        message:
          "You already have a running activity. Please stop it before starting a new one.",
      };
    }

    // A task can have many activities over time; each start links a new one
    // to the task so per-task time can be tracked.
    const activity = await prisma.activity.create({
      data: {
        activityName: task.title,
        activityTypeId: task.activityTypeId,
        userId: user.id,
        startTime: new Date(),
        endTime: null,
        taskId: task.id,
      },
      include: {
        activityType: true,
      },
    });

    return { success: true, data: activity };
  } catch (error) {
    const msg = "Failed to start activity from task.";
    return handleError(error, msg);
  }
};
