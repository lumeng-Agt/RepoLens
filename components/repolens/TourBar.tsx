import { BookOpenText, Check, ChevronLeft, ChevronRight, Code2, RotateCcw } from "lucide-react";
import type { RepositorySnapshot, SourceReference } from "@/data/model";

export function TourBar({ repository, stepIndex, completedSteps, stepsRef, disabled = false, onGoToStep, onComplete, onReset, onOpenReference }: {
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
  if (!current) return <footer className="tourbar" aria-label="静态分析">
    <div className="tourbar-intro"><span className="tourbar-icon"><BookOpenText size={16} /></span><div><span className="tourbar-label">静态分析</span><span className="tourbar-count">{repository.files.length} 个文件 · {repository.dependencies.length} 条仓库内引用</span></div></div>
    <p className="analysis-hint">选择目录或图节点查看依赖、源码与解析诊断；可在详情面板按需生成 AI 阅读路线。</p>
    <span className="diagnostic-count">{repository.diagnostics?.length ? `${repository.diagnostics.length} 条诊断` : "解析正常"}</span>
  </footer>;

  const currentNumber = stepIndex + 1;
  return <footer className="tourbar" aria-label="代码阅读路线">
    <div className="tourbar-intro"><span className="tourbar-icon"><BookOpenText size={16} /></span><div><span className="tourbar-label">阅读路线</span><span className="tourbar-count">第 {currentNumber} 步，共 {repository.tour.length} 步</span></div></div>
    <div ref={stepsRef} className="tour-steps" aria-label="选择阅读步骤">
      {repository.tour.map((step, index) => <button key={step.id} className={`tour-step${index === stepIndex ? " is-current" : ""}${completedSteps.includes(step.id) ? " is-complete" : ""}`} disabled={disabled} onClick={() => onGoToStep(index)} aria-current={index === stepIndex ? "step" : undefined} aria-label={`第 ${index + 1} 步：${step.title}`}>
        <span className="tour-step-marker">{completedSteps.includes(step.id) ? <Check size={12} /> : String(index + 1).padStart(2, "0")}</span><span className="tour-step-name">{step.title}</span>
      </button>)}
    </div>
    <div className="tour-controls">
      <button className="tour-reset" onClick={onReset} disabled={disabled} aria-label="重新开始导览" data-tooltip="重新开始"><RotateCcw size={15} /></button>
      <button className="tour-prev" onClick={() => onGoToStep(stepIndex - 1)} disabled={disabled || stepIndex === 0}><ChevronLeft size={16} /><span>上一步</span></button>
      {stepIndex === repository.tour.length - 1
        ? <button className="tour-next" onClick={onComplete} disabled={disabled}>{completedSteps.includes(current.id) ? <><span>导览已完成</span><Check size={15} /></> : <><span>完成导览</span><Check size={15} /></>}</button>
        : <button className="tour-next" onClick={() => onGoToStep(stepIndex + 1, true)} disabled={disabled}><span>下一步</span><ChevronRight size={15} /></button>}
    </div>
    <div className="tour-description" aria-live="polite"><span className="description-step">{String(currentNumber).padStart(2, "0")}</span><span>{current.description}</span><button disabled={disabled} onClick={() => onOpenReference(current.reference)} aria-label={`打开 ${current.title} 第 ${current.reference.line} 行`}><Code2 size={14} />L{current.reference.line}</button></div>
  </footer>;
}
