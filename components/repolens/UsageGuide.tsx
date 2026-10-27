"use client";

import { useEffect, useRef } from "react";
import { ArrowRight, BookOpen, Check, Circle, Code2, FolderOpen, Network, Route, Sparkles, X } from "lucide-react";
import type { UsageGuideTaskId } from "@/data/usage-guide.mjs";

const taskCopy: Record<UsageGuideTaskId, { title: string; description: string; action: string; icon: typeof Code2 }> = {
  source: { title: "打开源码文件", description: "从文件目录或“快速打开”中选择文件，查看源码内容。", action: "快速打开文件", icon: Code2 },
  dependencies: { title: "理解文件关系", description: "查看当前文件导入了什么，或哪些文件引用了它。", action: "查看当前文件引用", icon: Network },
  tour: { title: "跟随阅读路线", description: "进入下一步查看源码，再返回刚才的位置。", action: "查看下一步", icon: Route },
  note: { title: "留下阅读记录", description: "给当前文件添加笔记、书签，或记下待理解的问题。", action: "添加阅读记录", icon: BookOpen },
  repository: { title: "打开自己的仓库", description: "选择本地目录，或输入 GitHub 仓库链接。", action: "打开仓库", icon: FolderOpen },
};

export function UsageGuideNotice({ onOpen, onDismiss }: { onOpen: () => void; onDismiss: () => void }) {
  return <div className="usage-guide-notice" role="status">
    <BookOpen size={15} /><span>使用指南可随时从顶部重新打开。</span>
    <button type="button" onClick={onOpen}>查看指引</button>
    <button type="button" className="usage-notice-dismiss" aria-label="关闭使用指南提示" onClick={onDismiss}><X size={14} /></button>
  </div>;
}

export function UsageGuidePanel({ open, completedTaskIds, repositoryName, hasDependencies, hasTour, canAddNote, returnFocusRef, onClose, onStartTask, onOpenWelcome, onResetProgress, storageMessage }: {
  open: boolean;
  completedTaskIds: UsageGuideTaskId[];
  repositoryName: string;
  hasDependencies: boolean;
  hasTour: boolean;
  canAddNote: boolean;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onStartTask: (task: UsageGuideTaskId | "practice-example") => void;
  onOpenWelcome: () => void;
  onResetProgress: () => void;
  storageMessage?: string;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const guideTrigger = returnFocusRef.current;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key !== "Tab") return;
      const dialog = document.querySelector<HTMLElement>(".usage-guide-dialog");
      const focusable = dialog ? [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), [tabindex]:not([tabindex="-1"])')] : [];
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (previous?.isConnected) previous.focus();
      else guideTrigger?.focus();
    };
  }, [open, onClose, returnFocusRef]);
  if (!open) return null;
  const tasks: { id: UsageGuideTaskId; available: boolean; unavailable?: string }[] = [
    { id: "source", available: true },
    { id: "dependencies", available: hasDependencies, unavailable: "当前仓库没有可跳转的仓库内引用。" },
    { id: "tour", available: hasTour, unavailable: "当前仓库没有阅读路线。" },
    { id: "note", available: canAddNote, unavailable: "请先打开自己的仓库，再创建阅读记录。" },
    { id: "repository", available: true },
  ];
  const availableTasks = tasks.filter((task) => task.available);
  const completedCount = availableTasks.filter((task) => completedTaskIds.includes(task.id)).length;
  const allDone = availableTasks.length > 0 && completedCount === availableTasks.length;
  return <div className="usage-guide-layer">
    <button type="button" className="usage-guide-backdrop" aria-label="关闭使用指南" onClick={onClose} />
    <aside className="usage-guide-dialog" role="dialog" aria-modal="true" aria-labelledby="usage-guide-title">
      <header className="usage-guide-heading"><div><h2 id="usage-guide-title">使用指南</h2></div><button type="button" ref={closeRef} className="usage-guide-close" aria-label="关闭使用指南" onClick={onClose}><X size={18} /></button></header>
      <div className="usage-guide-scroll">
        <p className="usage-guide-intro">按需完成这些操作，也可以稍后再看。</p>
        {storageMessage && <p className="usage-guide-storage-note" role="status">{storageMessage}</p>}
        <div className="usage-guide-progress" role="status"><span>{completedCount} / {availableTasks.length} 项已完成</span><div><span style={{ width: `${availableTasks.length ? completedCount / availableTasks.length * 100 : 0}%` }} /></div></div>
        {allDone && <p className="usage-guide-complete"><Check size={15} />当前仓库适用的任务已完成。</p>}
        <ol className="usage-guide-task-list">
          {tasks.map(({ id, available, unavailable }) => {
            const task = taskCopy[id]; const done = completedTaskIds.includes(id); const Icon = task.icon;
            return <li key={id} className={`usage-guide-task${done ? " is-done" : ""}${!available ? " is-unavailable" : ""}`}>
              <span className="usage-guide-task-icon">{done ? <Check size={16} /> : <Icon size={16} />}</span>
              <div className="usage-guide-task-body"><strong>{task.title}</strong><p>{available ? task.description : unavailable}</p>
                {available ? <button type="button" className="usage-guide-task-action" onClick={() => onStartTask(id)}>{done ? "再做一次" : task.action}<ArrowRight size={14} /></button>
                  : (id === "dependencies" || id === "tour") && <button type="button" className="usage-guide-task-action" onClick={() => onStartTask("practice-example")}>在示例中练习<ArrowRight size={14} /></button>}
              </div>
              <span className="usage-guide-task-state" aria-label={done ? "已完成" : available ? "未完成" : "当前不适用"}>{done ? <Check size={15} /> : <Circle size={13} />}</span>
            </li>;
          })}
        </ol>
        <details className="usage-ai-guide"><summary><Sparkles size={15} />使用 AI 辅助阅读（可选）</summary><ol><li>配置模型服务。</li><li>预览将发送的文件和行范围。</li><li>确认发送后，检查回答中的引用是否支持结论。</li></ol><p>不配置模型也可以浏览源码、查看依赖和添加阅读记录。</p></details>
        <div className="usage-guide-footer-actions"><button type="button" onClick={onOpenWelcome}>返回首页</button><button type="button" onClick={onResetProgress}>重置指南进度</button></div>
      </div>
      <footer className="usage-guide-context">仓库：<strong>{repositoryName}</strong></footer>
    </aside>
  </div>;
}
