export type TaskState = "open" | "doing" | "done";

export interface Task {
  id: string;
  title: string;
  state: TaskState;
}
