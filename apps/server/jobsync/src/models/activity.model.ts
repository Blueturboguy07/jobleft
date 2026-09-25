export interface ActivityType {
  id: string;
  label: string;
  value: string;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Activity {
  id?: string;
  activityTypeId?: string;
  activityType: ActivityType | string;
  userId?: string;
  createdAt?: Date;
  updatedAt?: Date;
  activityName: string;
  startTime: Date;
  endTime?: Date;
  duration?: number;
  breakMinutes?: number;
  breakStartedAt?: Date | null;
  breakPlannedMins?: number | null;
  description?: string;
  taskId?: string | null;
}
