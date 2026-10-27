import { BookOpenText, Check, ChevronDown, ChevronLeft, ChevronRight, Code2, RotateCcw } from "lucide-react";
import type { RepositorySnapshot, SourceReference } from "@/data/model";

export function TourBar({ id, hidden = false, repository, stepIndex, completedSteps, stepsRef, disabled = false, onGoToStep, onComplete, onReset, onOpenReference }: {
  id?: string;
  hidden?: boolean;
  repository: RepositorySnapshot;
  stepIndex: number;
  completedSteps: string[];
  stepsRef: React.RefObject<HTMLDivElement | null>;
  disabled?: boolean;
  onGoToStep: (index: number, markCurrentComplete?: boolean) => void;
  onComplete: () => void;
  onReset: () => void;
  onOpenReference: (reference: SourceReference) => void;
}) {
  const current = repository.tour[stepIndex];
  if (!current) return <footer id={id} hidden={hidden} className="tourbar is-analysis-only" aria-label="静态分析">
    <div className="tourbar-intro"><span className="tourbar-icon"><BookOpenText size={16} /></span><div><span className="tourbar-label">静态分析</span><span className="tourbar-count">{repository.files.length} 个文件 · {repository.dependencies.length} 条引用</span></div></div>
    <p className="analysis-hint">选择文件查看源码和静态引用。</p>
    <span className="diagnostic-count">{repository.diagnostics?.length ? `${repository.diagnostics.length} 条诊断` : "无诊断"}</span>
  </footer>;

  const currentNumber = stepIndex + 1;
  return <footer id={id} hidden={hidden} className="tourbar" aria-label="代码阅读路线">
    <div className="tourbar-intro"><span className="tourbar-icon"><BookOpenText size={16} /></span><div><span className="tourbar-label">阅读路线</span><span className="tourbar-count">第 {currentNumber} 步，共 {repository.tour.length} 步</span></div></div>
    <div className="tour-current-copy"><strong title={current.title}>{current.title}</strong><details className="tour-step-description"><summary>本步说明 <ChevronDown size={13} /></summary><div><span>{current.description}{current.relationship && <small className="tour-step-context">与前一步：{current.relationship}</small>}{current.question && <small className="tour-step-context">检查理解：{current.question}</small>}</span><button disabled={disabled} onClick={() => onOpenReference(current.reference)} aria-label={`打开 ${current.title} 第 ${current.reference.line} 行`}><Code2 size={14} />第 {current.reference.line} 行</button></div></details></div>
    <details className="tour-step-disclosure"><summary>全部步骤 <ChevronDown size={13} /></summary><div ref={stepsRef} className="tour-steps" aria-label="选择阅读步骤">
      {repository.tour.map((step, index) => <button key={step.id} className={`tour-step${index === stepIndex ? " is-current" : ""}${completedSteps.includes(step.id) ? " is-complete" : ""}`} disabled={disabled} onClick={() => onGoToStep(index)} aria-current={index === stepIndex ? "step" : undefined} aria-label={`第 ${index + 1} 步：${step.title}`}>
        <span className="tour-step-marker">{completedSteps.includes(step.id) ? <Check size={12} /> : String(index + 1).padStart(2, "0")}</span><span className="tour-step-name">{step.title}</span>
      </button>)}
    </div></details>
    <div className="tour-controls">
      <button className="tour-reset" onClick={onReset} disabled={disabled} aria-label="重新开始当前路线" title="重置路线进度" data-tooltip="重新开始当前路线"><RotateCcw size={15} /></button>
      <button className="tour-prev" onClick={() => onGoToStep(stepIndex - 1)} disabled={disabled || stepIndex === 0}><ChevronLeft size={16} /><span>上一步</span></button>
      {stepIndex === repository.tour.length - 1
        ? <button className="tour-next" onClick={onComplete} disabled={disabled}>{completedSteps.includes(current.id) ? <><span>导览已完成</span><Check size={15} /></> : <><span>完成导览</span><Check size={15} /></>}</button>
        : <button className="tour-next" onClick={() => onGoToStep(stepIndex + 1, true)} disabled={disabled}><span>下一步</span><ChevronRight size={15} /></button>}
    </div>
  </footer>;
}
