import type { Task } from "./task";
import { countByState } from "./status";

export function buildSummary(tasks: readonly Task[]): string {
  const counts = countByState(tasks);
  return `${counts.open} open · ${counts.doing} in progress · ${counts.done} done`;
}
