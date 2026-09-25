"use server";
import prisma from "@/lib/db";
import { handleError } from "@/lib/utils";
import {
  RUNNING_ACTIVITY_SELECT,
  breakMinutesSince,
  clampBreakMinutes,
  requireUser,
} from "./shared";

export const startBreak = async (
  activityId: string,
  plannedMinutes: number,
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const activity = await prisma.activity.findFirst({
      where: { id: activityId, userId: user.id, endTime: null },
    });

    if (!activity) {
      throw new Error("Activity not found");
    }

    if (activity.breakStartedAt) {
      return { success: false, message: "A break is already in progress." };
    }

    const updated = await prisma.activity.update({
      where: { id: activityId, userId: user.id },
      data: {
        breakStartedAt: new Date(),
        breakPlannedMins: clampBreakMinutes(plannedMinutes),
      },
      select: RUNNING_ACTIVITY_SELECT,
    });

    return { activity: updated, success: true };
  } catch (error) {
    const msg = "Failed to start break. ";
    return handleError(error, msg);
  }
};

export const endBreak = async (
  activityId: string,
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const activity = await prisma.activity.findFirst({
      where: { id: activityId, userId: user.id, endTime: null },
      select: RUNNING_ACTIVITY_SELECT,
    });

    if (!activity) {
      throw new Error("Activity not found");
    }

    // Resuming twice (two tabs, or a retry) must not double-count.
    if (!activity.breakStartedAt) {
      return { activity, success: true };
    }

    const updated = await prisma.activity.update({
      where: { id: activityId, userId: user.id },
      data: {
        breakMinutes:
          activity.breakMinutes + breakMinutesSince(activity.breakStartedAt),
        breakStartedAt: null,
        breakPlannedMins: null,
      },
      select: RUNNING_ACTIVITY_SELECT,
    });

    return { activity: updated, success: true };
  } catch (error) {
    const msg = "Failed to end break. ";
    return handleError(error, msg);
  }
};

export const updateBreakLength = async (
  activityId: string,
  plannedMinutes: number,
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const activity = await prisma.activity.findFirst({
      where: { id: activityId, userId: user.id, endTime: null },
    });

    if (!activity?.breakStartedAt) {
      return { success: false, message: "No break is in progress." };
    }

    const updated = await prisma.activity.update({
      where: { id: activityId, userId: user.id },
      data: { breakPlannedMins: clampBreakMinutes(plannedMinutes) },
      select: RUNNING_ACTIVITY_SELECT,
    });

    return { activity: updated, success: true };
  } catch (error) {
    const msg = "Failed to update break length. ";
    return handleError(error, msg);
  }
};
