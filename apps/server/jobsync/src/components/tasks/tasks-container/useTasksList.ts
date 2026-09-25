"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { getTasksList, updateTaskStatus } from "@/actions/task.actions";
import { toastActionResult, toastError } from "@/lib/toast";
import { Task, TaskGroupBy, TaskStatus } from "@/models/task.model";
import { APP_CONSTANTS } from "@/lib/constants";

const DEFAULT_STATUS_FILTER: TaskStatus[] = ["in-progress", "needs-attention"];

// Owns the task list itself: pagination, search, status/group filters,
// infinite scroll, and the optimistic status-change update.
export function useTasksList({
  filterKey,
  onTasksChanged,
}: {
  filterKey?: string;
  onTasksChanged?: () => void;
}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [page, setPage] = useState(1);
  const [totalTasks, setTotalTasks] = useState(0);
  const [initialLoading, setInitialLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [groupBy, setGroupBy] = useState<TaskGroupBy>("none");
  const [statusFilter, setStatusFilter] = useState<TaskStatus[]>(
    DEFAULT_STATUS_FILTER,
  );
  const [searchTerm, setSearchTerm] = useState("");
  const hasSearched = useRef(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const tasksPerPage = APP_CONSTANTS.RECORDS_PER_PAGE;

  const loadTasks = useCallback(
    async (
      pageNum: number,
      filter?: string,
      statuses?: TaskStatus[],
      search?: string,
      group?: TaskGroupBy,
    ) => {
      if (pageNum === 1) setInitialLoading(true);
      else setLoadingMore(true);
      const { success, data, total, message } = await getTasksList(
        pageNum,
        tasksPerPage,
        filter,
        statuses,
        search,
        group,
      );
      if (success && data) {
        setTasks((prev) => (pageNum === 1 ? data : [...prev, ...data]));
        setTotalTasks(total);
        setPage(pageNum);
      } else {
        toastError(message);
      }
      setInitialLoading(false);
      setLoadingMore(false);
    },
    [tasksPerPage],
  );

  const reloadTasks = useCallback(async () => {
    await loadTasks(
      1,
      filterKey,
      statusFilter,
      searchTerm || undefined,
      groupBy,
    );
    onTasksChanged?.();
  }, [loadTasks, filterKey, statusFilter, searchTerm, groupBy, onTasksChanged]);

  const onChangeTaskStatus = async (taskId: string, status: TaskStatus) => {
    const originalTasks = [...tasks];
    setTasks((prev) =>
      prev.map((task) => (task.id === taskId ? { ...task, status } : task)),
    );

    const result = await updateTaskStatus(taskId, status);
    if (result.success) {
      onTasksChanged?.();
    } else {
      setTasks(originalTasks);
    }
    toastActionResult(result, { success: "Task status updated successfully" });
  };

  useEffect(() => {
    (async () =>
      await loadTasks(
        1,
        filterKey,
        statusFilter,
        searchTerm || undefined,
        groupBy,
      ))();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadTasks, filterKey, statusFilter, groupBy]);

  // Debounced search effect
  useEffect(() => {
    if (searchTerm !== "") {
      hasSearched.current = true;
    }
    if (searchTerm === "" && !hasSearched.current) return;

    const timer = setTimeout(() => {
      loadTasks(1, filterKey, statusFilter, searchTerm || undefined, groupBy);
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm]);

  // Infinite scroll: auto-load next page when sentinel is visible
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (
          entries[0].isIntersecting &&
          !initialLoading &&
          !loadingMore &&
          tasks.length < totalTasks
        ) {
          loadTasks(
            page + 1,
            filterKey,
            statusFilter,
            searchTerm || undefined,
            groupBy,
          );
        }
      },
      { threshold: APP_CONSTANTS.INTERSECTION_OBSERVER_THRESHOLD },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [
    tasks.length,
    totalTasks,
    page,
    filterKey,
    statusFilter,
    searchTerm,
    groupBy,
    initialLoading,
    loadingMore,
    loadTasks,
  ]);

  const onGroupByChange = (value: string) => {
    setGroupBy(value as TaskGroupBy);
  };

  const toggleStatusFilter = (status: TaskStatus) => {
    setStatusFilter((prev) =>
      prev.includes(status)
        ? prev.filter((s) => s !== status)
        : [...prev, status],
    );
  };

  return {
    tasks,
    totalTasks,
    initialLoading,
    loadingMore,
    groupBy,
    onGroupByChange,
    statusFilter,
    toggleStatusFilter,
    searchTerm,
    setSearchTerm,
    sentinelRef,
    reloadTasks,
    onChangeTaskStatus,
  };
}
