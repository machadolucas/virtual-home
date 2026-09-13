import { sectionFor, type GroupableTask } from "./grouping";
import type { LocalDate } from "@/domain/time";
export const TODAY_QUEUES = ["all", "attention", "upcoming", "waiting"] as const;
export type TodayQueue = typeof TODAY_QUEUES[number];
export function inTodayQueue(task: GroupableTask, today: LocalDate, queue: TodayQueue): boolean {
  const section = sectionFor(task, today);
  if (!section) return false;
  if (queue === "all") return true;
  if (queue === "attention") return section === "needs_attention" || section === "condition";
  if (queue === "waiting") return section === "blocked";
  return section === "ready" || section === "upcoming";
}
export function belongsToScope(task: GroupableTask, viewerId: string, mine: boolean): boolean {
  return !mine || task.assignmentMode === "shared" || task.assigneeUserId === null || task.assigneeUserId === viewerId;
}
