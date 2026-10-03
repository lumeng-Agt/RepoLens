import type { Task, TaskState } from "./task";

export function countByState(tasks: readonly Task[]): Record<TaskState, number> {
  return tasks.reduce<Record<TaskState, number>>((counts, task) => {
    counts[task.state] += 1;
    return counts;
  }, { open: 0, doing: 0, done: 0 });
}
