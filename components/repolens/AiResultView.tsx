import { ChevronRight, Code2 } from "lucide-react";
import type { FileRecord, SourceReference } from "@/data/model";
import type { AiMode } from "@/data/explanation-provider";

export type AiResultRecord = Record<string, unknown> & {
  __repositoryId: string;
  __entryFileId: string;
  __revision: string;
  __mode: AiMode;
  __contextFiles: { fileId: string; contentHash: string }[];
  __routeSteps?: import("@/data/model").TourStep[];
};

export function AiResultView({ result, files, stale, onOpenReference }: {
  result: AiResultRecord;
  files: Map<string, FileRecord>;
  stale: boolean;
  onOpenReference: (reference: SourceReference) => void;
}) {
  const title = String(result.role ?? result.title ?? "AI 讲解");
  const keyPoints = Array.isArray(result.keyPoints) ? result.keyPoints as string[] : [];
  const references = Array.isArray(result.references) ? result.references as { fileId: string; startLine: number; endLine?: number }[] : [];
  const steps = Array.isArray(result.steps) ? result.steps as { fileId: string; purpose: string; references: { fileId: string; startLine: number; endLine?: number }[] }[] : [];

  return <div className="ai-result">
    <strong>{title}</strong>
    {stale && <p role="status">引用关联源码已变化，当前结果已过期，不能跳转。</p>}
    {keyPoints.length > 0 && <ul>{keyPoints.map((point, index) => <li key={`${index}-${point}`}>{point}</li>)}</ul>}
    {steps.length > 0 && <div className="relation-list" aria-label="AI 阅读路线步骤">
      {steps.map((step, index) => {
        const reference = step.references.find((item) => item.fileId === step.fileId);
        if (!reference) return null;
        return <button className="reference-row" key={`${step.fileId}-${index}`} disabled={stale} onClick={() => onOpenReference({ fileId: step.fileId, line: reference.startLine, endLine: reference.endLine })}>
          <span className="reference-icon"><Code2 size={14} /></span>
          <span className="reference-copy"><strong>{index + 1}. {files.get(step.fileId)?.name ?? step.fileId}</strong><small>{step.purpose}</small></span>
          <ChevronRight size={14} className="reference-arrow" />
        </button>;
      })}
    </div>}
    {references.length > 0 && <div className="relation-list" aria-label="AI 源码引用">
      {references.map((reference, index) => <button className="reference-row" key={`${reference.fileId}-${reference.startLine}-${index}`} disabled={stale} onClick={() => onOpenReference({ fileId: reference.fileId, line: reference.startLine, endLine: reference.endLine })}>
        <span className="reference-icon"><Code2 size={14} /></span>
        <span className="reference-copy"><strong>{files.get(reference.fileId)?.name ?? reference.fileId}</strong><small>第 {reference.startLine}–{reference.endLine ?? reference.startLine} 行 · AI 引用</small></span>
        <ChevronRight size={14} className="reference-arrow" />
      </button>)}
    </div>}
  </div>;
}
