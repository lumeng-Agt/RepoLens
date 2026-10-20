"use client";

import { useEffect, useRef } from "react";
import { ArrowRight, BookOpen, Check, Circle, Code2, FolderOpen, Network, Route, Sparkles, X } from "lucide-react";
import type { UsageGuideTaskId } from "@/data/usage-guide.mjs";

const taskCopy: Record<UsageGuideTaskId, { title: string; description: string; action: string; icon: typeof Code2 }> = {
  source: { title: "找到一份源码", description: "从目录或快速打开中选择文件，看看源码和文件说明如何对应。", action: "快速打开文件", icon: Code2 },
  dependencies: { title: "理解文件关系", description: "查看当前文件导入了什么，或哪些文件引用了它。", action: "查看当前文件引用", icon: Network },
  tour: { title: "跟随阅读路线", description: "进入下一步查看源码，再返回刚才的位置。", action: "查看下一步", icon: Route },
  note: { title: "留下阅读记录", description: "给当前文件添加笔记、书签，或记下待理解的问题。", action: "添加阅读记录", icon: BookOpen },
  repository: { title: "打开自己的仓库", description: "选择本地目录，或输入 GitHub 仓库链接。", action: "打开仓库", icon: FolderOpen },
};

export function UsageGuideWelcome({ onTryExample, onOpenRepository, onSkip }: {
  onTryExample: () => void; onOpenRepository: () => void; onSkip: () => void;
}) {
  return <main className="usage-welcome-page">
    <div className="usage-welcome-card">
      <div className="usage-welcome-brand"><span className="usage-welcome-mark"><BookOpen size={19} /></span><span>RepoLens</span><span className="usage-welcome-caption">仓库导览</span></div>
      <div className="usage-welcome-copy">
        <p className="usage-guide-kicker">先读懂，再深入</p>
        <h1>从这里开始读懂一个仓库</h1>
        <p>浏览源码、理解静态依赖、记录阅读成果。需要时再使用 AI，每次发送代码前都可以先检查范围。</p>
      </div>
      <div className="usage-welcome-actions">
        <button type="button" className="usage-primary-action" onClick={onTryExample}>体验示例<ArrowRight size={16} /></button>
        <button type="button" className="usage-secondary-action" onClick={onOpenRepository}>打开自己的仓库<FolderOpen size={16} /></button>
      </div>
      <button type="button" className="usage-skip-action" onClick={onSkip}>跳过指引，直接进入工作区</button>
      <div className="usage-welcome-footnote"><Sparkles size={14} /><span>示例可离线体验；开始浏览不会调用模型或发送源码。</span></div>
    </div>
  </main>;
}

export function UsageGuideNotice({ onOpen, onDismiss }: { onOpen: () => void; onDismiss: () => void }) {
  return <div className="usage-guide-notice" role="status">
    <BookOpen size={15} /><span>RepoLens 使用指南已上线。</span>
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
    { id: "dependencies", available: hasDependencies, unavailable: "当前仓库没有可展示的仓库内引用。" },
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
      <header className="usage-guide-heading"><div><span className="usage-guide-kicker">READING GUIDE</span><h2 id="usage-guide-title">使用指南</h2></div><button type="button" ref={closeRef} className="usage-guide-close" aria-label="关闭使用指南" onClick={onClose}><X size={18} /></button></header>
      <div className="usage-guide-scroll">
        <p className="usage-guide-intro">跟着实际操作熟悉 RepoLens。任务可以按任意顺序完成，稍后也能继续。</p>
        {storageMessage && <p className="usage-guide-storage-note" role="status">{storageMessage}</p>}
        <div className="usage-guide-progress" role="status"><span>{completedCount} / {availableTasks.length} 项已完成</span><div><span style={{ width: `${availableTasks.length ? completedCount / availableTasks.length * 100 : 0}%` }} /></div></div>
        {allDone && <p className="usage-guide-complete"><Check size={15} />已完成适用于当前仓库的入门任务，可以开始自己的阅读。</p>}
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
        <details className="usage-ai-guide"><summary><Sparkles size={15} />使用 AI 辅助阅读（可选）</summary><ol><li>配置兼容的模型服务。</li><li>预览并检查准备发送的文件和行范围。</li><li>确认后生成，再检查回答引用是否支持结论。</li></ol><p>没有模型配置也可以完成源码浏览、依赖查看和阅读记录。</p></details>
        <div className="usage-guide-footer-actions"><button type="button" onClick={onOpenWelcome}>重新查看欢迎页</button><button type="button" onClick={onResetProgress}>重新开始指引</button></div>
      </div>
      <footer className="usage-guide-context">当前仓库：<strong>{repositoryName}</strong></footer>
    </aside>
  </div>;
}
