"use server";
import prisma from "@/lib/db";
import { handleError } from "@/lib/utils";
import { TaskStatus } from "@/models/task.model";
import { AddTaskFormSchema } from "@/models/addTaskForm.schema";
import { z } from "zod";
import { requireUser } from "../shared";

const WITH_ACTIVITY_TYPE = {
  activityType: true,
};

export const createTask = async (
  data: z.infer<typeof AddTaskFormSchema>
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const validatedData = AddTaskFormSchema.parse(data);

    const task = await prisma.task.create({
      data: {
        title: validatedData.title,
        description: validatedData.description,
        status: validatedData.status,
        priority: validatedData.priority,
        percentComplete: validatedData.percentComplete,
        dueDate: validatedData.dueDate,
        activityTypeId: validatedData.activityTypeId,
        userId: user.id,
      },
      include: WITH_ACTIVITY_TYPE,
    });

    return { success: true, data: task };
  } catch (error) {
    const msg = "Failed to create task.";
    return handleError(error, msg);
  }
};

export const updateTask = async (
  data: z.infer<typeof AddTaskFormSchema>
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    if (!data.id) {
      throw new Error("Task ID is required for update");
    }

    const validatedData = AddTaskFormSchema.parse(data);

    const task = await prisma.task.update({
      where: {
        id: data.id,
        userId: user.id,
      },
      data: {
        title: validatedData.title,
        description: validatedData.description,
        status: validatedData.status,
        priority: validatedData.priority,
        percentComplete: validatedData.percentComplete,
        dueDate: validatedData.dueDate,
        activityTypeId: validatedData.activityTypeId,
      },
      include: WITH_ACTIVITY_TYPE,
    });

    return { success: true, data: task };
  } catch (error) {
    const msg = "Failed to update task.";
    return handleError(error, msg);
  }
};

export const updateTaskStatus = async (
  taskId: string,
  status: TaskStatus
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const task = await prisma.task.update({
      where: {
        id: taskId,
        userId: user.id,
      },
      data: {
        status,
      },
      include: WITH_ACTIVITY_TYPE,
    });

    return { success: true, data: task };
  } catch (error) {
    const msg = "Failed to update task status.";
    return handleError(error, msg);
  }
};

export const deleteTaskById = async (
  taskId: string
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const task = await prisma.task.findFirst({
      where: {
        id: taskId,
        userId: user.id,
      },
      include: {
        activities: {
          select: { id: true },
        },
      },
    });

    if (!task) {
      return { success: false, message: "Task not found" };
    }

    if (task.activities.length > 0) {
      return {
        success: false,
        message:
          "Cannot delete task with linked activity. Remove the activity first.",
      };
    }

    await prisma.task.delete({
      where: {
        id: taskId,
        userId: user.id,
      },
    });

    return { success: true };
  } catch (error) {
    const msg = "Failed to delete task.";
    return handleError(error, msg);
  }
};
