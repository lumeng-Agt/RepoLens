import type {
  DependencyEdge,
  FileRecord,
  RepositorySnapshot,
  SourceReference,
  TourStep,
} from "./model";

type DraftFile = Omit<FileRecord, "id">;

const drafts: DraftFile[] = [
  {
    path: "src/main.tsx",
    name: "main.tsx",
    kind: "typescript",
    role: "应用入口",
    summary: "创建 React 根节点，并把主应用挂载到页面容器。",
    imports: [
      { targetPath: "src/App.tsx", specifier: "./App" },
      { targetPath: "src/styles.css", specifier: "./styles.css" },
    ],
    source: `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element was not found.");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);`,
  },
  {
    path: "src/App.tsx",
    name: "App.tsx",
    kind: "typescript",
    role: "应用装配",
    summary: "应用外层组件，把页面入口交给任务列表页面。",
    imports: [{ targetPath: "src/pages/TaskPage.tsx", specifier: "./pages/TaskPage" }],
    source: `import { TaskPage } from "./pages/TaskPage";

export default function App() {
  return <TaskPage />;
}`,
  },
  {
    path: "src/pages/TaskPage.tsx",
    name: "TaskPage.tsx",
    kind: "typescript",
    role: "任务页面",
    summary: "组合筛选栏和任务列表，并把状态逻辑接入页面。",
    imports: [
      { targetPath: "src/components/TaskFilter.tsx", specifier: "../components/TaskFilter" },
      { targetPath: "src/components/TaskList.tsx", specifier: "../components/TaskList" },
      { targetPath: "src/hooks/useTasks.ts", specifier: "../hooks/useTasks" },
    ],
    source: `import { TaskFilter } from "../components/TaskFilter";
import { TaskList } from "../components/TaskList";
import { useTasks } from "../hooks/useTasks";

export function TaskPage() {
  const { tasks, filter, setFilter, toggleTask } = useTasks();

  return (
    <main className="task-page">
      <header>
        <p>MONDAY, OCTOBER 12</p>
        <h1>Keep the day moving.</h1>
      </header>
      <TaskFilter value={filter} onChange={setFilter} />
      <TaskList tasks={tasks} onToggle={toggleTask} />
    </main>
  );
}`,
  },
  {
    path: "src/components/TaskList.tsx",
    name: "TaskList.tsx",
    kind: "typescript",
    role: "列表组件",
    summary: "遍历任务数据，将每一项交给独立的任务行组件。",
    imports: [
      { targetPath: "src/components/TaskItem.tsx", specifier: "./TaskItem" },
      { targetPath: "src/types.ts", specifier: "../types" },
    ],
    source: `import { TaskItem } from "./TaskItem";
import type { Task } from "../types";

type TaskListProps = {
  tasks: Task[];
  onToggle: (id: string) => void;
};

export function TaskList({ tasks, onToggle }: TaskListProps) {
  if (tasks.length === 0) {
    return <p className="empty-state">Nothing on the list yet.</p>;
  }

  return (
    <ul className="task-list">
      {tasks.map((task) => (
        <TaskItem key={task.id} task={task} onToggle={onToggle} />
      ))}
    </ul>
  );
}`,
  },
  {
    path: "src/components/TaskItem.tsx",
    name: "TaskItem.tsx",
    kind: "typescript",
    role: "任务行组件",
    summary: "显示单条任务，并把完成状态的切换交回父组件。",
    imports: [{ targetPath: "src/types.ts", specifier: "../types" }],
    source: `import type { Task } from "../types";

type TaskItemProps = {
  task: Task;
  onToggle: (id: string) => void;
};

export function TaskItem({ task, onToggle }: TaskItemProps) {
  return (
    <li className={task.done ? "task-item is-done" : "task-item"}>
      <button
        className="task-check"
        aria-label={task.done ? "Mark as active" : "Mark as done"}
        onClick={() => onToggle(task.id)}
      >
        {task.done ? "✓" : ""}
      </button>
      <span>{task.title}</span>
      <small>{task.due}</small>
    </li>
  );
}`,
  },
  {
    path: "src/components/TaskFilter.tsx",
    name: "TaskFilter.tsx",
    kind: "typescript",
    role: "筛选组件",
    summary: "提供全部、进行中和已完成三种任务视图。",
    imports: [{ targetPath: "src/types.ts", specifier: "../types" }],
    source: `import type { TaskStatus } from "../types";

const filters: TaskStatus[] = ["all", "active", "done"];

type TaskFilterProps = {
  value: TaskStatus;
  onChange: (value: TaskStatus) => void;
};

export function TaskFilter({ value, onChange }: TaskFilterProps) {
  return (
    <nav className="task-filters" aria-label="Filter tasks">
      {filters.map((filter) => (
        <button
          key={filter}
          aria-pressed={value === filter}
          onClick={() => onChange(filter)}
        >
          {filter}
        </button>
      ))}
    </nav>
  );
}`,
  },
  {
    path: "src/hooks/useTasks.ts",
    name: "useTasks.ts",
    kind: "typescript",
    role: "状态逻辑",
    summary: "管理筛选状态和完成切换，供页面直接使用。",
    imports: [
      { targetPath: "src/services/taskService.ts", specifier: "../services/taskService" },
      { targetPath: "src/utils/filterByStatus.ts", specifier: "../utils/filterByStatus" },
      { targetPath: "src/types.ts", specifier: "../types" },
    ],
    source: `import { useMemo, useState } from "react";
import { initialTasks } from "../services/taskService";
import { filterByStatus } from "../utils/filterByStatus";
import type { TaskStatus } from "../types";

export function useTasks() {
  const [tasks, setTasks] = useState(initialTasks);
  const [filter, setFilter] = useState<TaskStatus>("all");

  const visibleTasks = useMemo(
    () => filterByStatus(tasks, filter),
    [tasks, filter],
  );

  function toggleTask(id: string) {
    setTasks((current) =>
      current.map((task) =>
        task.id === id ? { ...task, done: !task.done } : task,
      ),
    );
  }

  return { tasks: visibleTasks, filter, setFilter, toggleTask };
}`,
  },
  {
    path: "src/services/taskService.ts",
    name: "taskService.ts",
    kind: "typescript",
    role: "数据服务",
    summary: "提供演示任务初始数据；真实产品可在这里替换为 API 调用。",
    imports: [
      { targetPath: "src/data/seed.ts", specifier: "../data/seed" },
      { targetPath: "src/types.ts", specifier: "../types" },
    ],
    source: `import { seedTasks } from "../data/seed";
import type { Task } from "../types";

export const initialTasks: Task[] = seedTasks;

export function createTask(title: string): Task {
  return {
    id: crypto.randomUUID(),
    title,
    due: "Today",
    done: false,
  };
}`,
  },
  {
    path: "src/data/seed.ts",
    name: "seed.ts",
    kind: "typescript",
    role: "示例数据",
    summary: "集中保存首次打开任务清单时使用的静态示例数据。",
    imports: [{ targetPath: "src/types.ts", specifier: "../types" }],
    source: `import type { Task } from "../types";

export const seedTasks: Task[] = [
  { id: "task-1", title: "Review the launch notes", due: "9:30 AM", done: false },
  { id: "task-2", title: "Send the weekly update", due: "11:00 AM", done: false },
  { id: "task-3", title: "Pick up a few groceries", due: "4:00 PM", done: true },
];`,
  },
  {
    path: "src/utils/filterByStatus.ts",
    name: "filterByStatus.ts",
    kind: "typescript",
    role: "纯函数工具",
    summary: "根据当前筛选值派生可见任务，不修改传入的原始数组。",
    imports: [{ targetPath: "src/types.ts", specifier: "../types" }],
    source: `import type { Task, TaskStatus } from "../types";

export function filterByStatus(tasks: Task[], status: TaskStatus) {
  if (status === "active") return tasks.filter((task) => !task.done);
  if (status === "done") return tasks.filter((task) => task.done);
  return tasks;
}`,
  },
  {
    path: "src/types.ts",
    name: "types.ts",
    kind: "typescript",
    role: "共享类型",
    summary: "定义任务数据结构与筛选状态，供多个模块复用。",
    imports: [],
    source: `export type TaskStatus = "all" | "active" | "done";

export type Task = {
  id: string;
  title: string;
  due: string;
  done: boolean;
};`,
  },
  {
    path: "src/styles.css",
    name: "styles.css",
    kind: "style",
    role: "全局样式",
    summary: "入口文件载入的基础样式，设置应用字体和页面底色。",
    imports: [],
    source: `:root {
  color-scheme: light;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  background: #f7f7f4;
  color: #20231f;
}

body {
  margin: 0;
  min-width: 320px;
}

button {
  font: inherit;
}`,
  },
];

const idsByPath = new Map(drafts.map((file) => [file.path, file.path]));

const files: FileRecord[] = drafts.map((file) => ({
  ...file,
  id: file.path,
  language: file.path.split(".").pop()?.toLowerCase(),
}));

function lineForSpecifier(file: DraftFile, specifier: string) {
  const lineIndex = (file.source ?? "")
    .split("\n")
    .findIndex((line) => line.includes(`"${specifier}"`));
  if (lineIndex === -1) {
    throw new Error(`Import ${specifier} was not found in ${file.path}`);
  }
  return lineIndex + 1;
}

const dependencies: DependencyEdge[] = drafts.flatMap((file) =>
  file.imports.map((entry) => {
    const fromId = idsByPath.get(file.path);
    const toId = idsByPath.get(entry.targetPath);
    if (!fromId || !toId) {
      throw new Error(`Unresolved sample dependency: ${file.path} → ${entry.targetPath}`);
    }
    return {
      id: `${fromId}::${toId}`,
      fromId,
      toId,
      specifier: entry.specifier,
      reference: { fileId: fromId, line: lineForSpecifier(file, entry.specifier) },
    };
  }),
);

function sourceReference(fileId: string, excerpt: string): SourceReference {
  const file = files.find((candidate) => candidate.id === fileId);
  if (!file) throw new Error(`Unknown sample file: ${fileId}`);
  const lineIndex = (file.source ?? "")
    .split("\n")
    .findIndex((line) => line.includes(excerpt));
  if (lineIndex === -1) {
    throw new Error(`Excerpt ${excerpt} was not found in ${fileId}`);
  }
  return { fileId, line: lineIndex + 1 };
}

const tour: TourStep[] = [
  {
    id: "entry",
    title: "从入口开始",
    focusFileId: "src/main.tsx",
    description: "入口创建页面根节点并挂载 App。沿着本文件的导入关系，可以看到应用和全局样式从哪里接入。",
    reference: sourceReference("src/main.tsx", "createRoot(rootElement)"),
  },
  {
    id: "page",
    title: "页面组织内容",
    focusFileId: "src/pages/TaskPage.tsx",
    description: "任务页面把筛选栏和列表组合到一起，并从 useTasks 获取数据和交互处理函数。",
    reference: sourceReference("src/pages/TaskPage.tsx", "const { tasks, filter"),
  },
  {
    id: "component",
    title: "列表拆分为组件",
    focusFileId: "src/components/TaskList.tsx",
    description: "列表组件只负责空状态和逐项渲染；单条任务交由 TaskItem 呈现。",
    reference: sourceReference("src/components/TaskList.tsx", "tasks.map((task)"),
  },
  {
    id: "state",
    title: "状态集中在 Hook",
    focusFileId: "src/hooks/useTasks.ts",
    description: "Hook 持有任务与筛选状态，并通过纯函数计算可见列表，再把事件回调交给页面。",
    reference: sourceReference("src/hooks/useTasks.ts", "const [tasks, setTasks]"),
  },
  {
    id: "service",
    title: "服务提供初始数据",
    focusFileId: "src/services/taskService.ts",
    description: "当前服务从 seed 文件提供演示数据。替换数据来源时，可从这一层接入持久化或 API。",
    reference: sourceReference("src/services/taskService.ts", "export const initialTasks"),
  },
];

export const sampleRepositoryProvider = {
  getSnapshot(): RepositorySnapshot {
    const snapshot: RepositorySnapshot = {
      id: "taskflow-sample",
      version: "1.2",
      name: "taskflow",
      description: "一个用于演示的 React 任务清单",
      files,
      dependencies,
      tour,
    };
    validateSnapshot(snapshot);
    return snapshot;
  },
};

function validateSnapshot(snapshot: RepositorySnapshot) {
  const byId = new Map(snapshot.files.map((file) => [file.id, file]));
  if (byId.size !== snapshot.files.length) throw new Error("Sample repository has duplicate file IDs.");
  for (const edge of snapshot.dependencies) {
    const source = byId.get(edge.fromId);
    const target = byId.get(edge.toId);
    if (!source || !target) throw new Error(`Dependency points to a missing file: ${edge.id}`);
    const sourceLine = (source.source ?? "").split("\n")[edge.reference.line - 1];
    if (edge.reference.fileId !== source.id || !sourceLine?.includes(`"${edge.specifier}"`)) {
      throw new Error(`Dependency source reference is invalid: ${edge.id}`);
    }
  }
  if (snapshot.tour.length !== 5) throw new Error("Sample reading route must contain five steps.");
  for (const step of snapshot.tour) {
    const file = byId.get(step.focusFileId);
    const referencedFile = byId.get(step.reference.fileId);
    if (file !== referencedFile || !file?.source?.split("\n")[step.reference.line - 1]) {
      throw new Error(`Tour source reference is invalid: ${step.id}`);
    }
  }
}
