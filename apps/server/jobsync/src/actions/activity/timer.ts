"use server";
import prisma from "@/lib/db";
import { handleError } from "@/lib/utils";
import { APP_CONSTANTS } from "@/lib/constants";
import { revalidatePath } from "next/cache";
import { differenceInMinutes } from "date-fns";
import {
  RUNNING_ACTIVITY_SELECT,
  breakMinutesSince,
  requireUser,
} from "./shared";

export const startActivityById = async (
  activityId: string
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    // Check for existing active activity to prevent concurrent activities
    const existingActive = await prisma.activity.findFirst({
      where: {
        userId: user.id,
        endTime: null,
      },
    });

    if (existingActive) {
      return {
        success: false,
        message: "An activity is already in progress. Stop it before starting a new one.",
      };
    }

    const activity = await prisma.activity.findFirst({
      where: {
        id: activityId,
        userId: user.id,
      },
    });

    if (!activity) {
      throw new Error("Activity not found");
    }
    const { activityName, activityTypeId, description } = activity;

    const newActivity = await prisma.activity.create({
      data: {
        activityName,
        activityTypeId,
        userId: user.id,
        startTime: new Date(),
        endTime: null,
        description,
      },
      select: RUNNING_ACTIVITY_SELECT,
    });
    return { newActivity, success: true };
  } catch (error) {
    const msg = "Failed to start activity. ";
    return handleError(error, msg);
  }
};

export const stopActivityById = async (
  activityId: string,
  endTime: Date,
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    // endTime: null — this must never reach an already-saved row, because the
    // discard branch below deletes.
    const activity = await prisma.activity.findFirst({
      where: { id: activityId, userId: user.id, endTime: null },
    });

    if (!activity) {
      throw new Error("Activity not found");
    }

    // Time spent away is never billed as work, even if the user never resumed.
    const breakMinutes =
      activity.breakMinutes +
      (activity.breakStartedAt
        ? breakMinutesSince(activity.breakStartedAt, endTime)
        : 0);

    // Subtract before capping: capping first double-penalised anything past 8h
    // of wall clock and could zero out a real day's work (decision 7).
    const workedMinutes =
      differenceInMinutes(endTime, activity.startTime) - breakMinutes;
    const duration = Math.min(
      Math.max(workedMinutes, 0),
      APP_CONSTANTS.ACTIVITY_MAX_DURATION_MINUTES,
    );

    if (duration < APP_CONSTANTS.ACTIVITY_MIN_DURATION_MINUTES) {
      await prisma.activity.delete({
        where: { id: activityId, userId: user.id },
      });
      revalidatePath("/dashboard");
      return { success: true, discarded: true };
    }

    const stopped = await prisma.activity.update({
      where: { id: activityId, userId: user.id },
      data: {
        endTime,
        duration,
        breakMinutes,
        breakStartedAt: null,
        breakPlannedMins: null,
      },
    });

    revalidatePath("/dashboard");
    return { activity: stopped, success: true, discarded: false };
  } catch (error) {
    const msg = "Failed to stop activity. ";
    return handleError(error, msg);
  }
};

export const getCurrentActivity = async (): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const activity = await prisma.activity.findFirst({
      where: {
        userId: user.id,
        endTime: null,
      },
      select: RUNNING_ACTIVITY_SELECT,
    });

    if (!activity) {
      return { success: false };
    }

    return { activity, success: true };
  } catch (error) {
    const msg = "Failed to get current activity. ";
    return handleError(error, msg);
  }
};
