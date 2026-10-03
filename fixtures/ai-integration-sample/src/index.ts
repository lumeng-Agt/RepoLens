import type { Task } from "./task";
import { buildSummary } from "./summary";

const tasks: Task[] = [
  { id: "task-1", title: "Read the overview", state: "done" },
  { id: "task-2", title: "Review the dependency map", state: "doing" },
  { id: "task-3", title: "Write a short note", state: "open" },
];

console.log(buildSummary(tasks));
