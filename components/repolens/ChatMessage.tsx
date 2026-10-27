import { useRef } from "react";
import { MoreHorizontal, Pencil, X, FileCode2 } from "lucide-react";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ChatMarkdown, ChatCopyButton } from "./ChatMarkdown";
import type { QaMessage, QaReference, ChatEvidenceState } from "./chat-types";
import type { AiRouteRecord, SourceReference } from "@/data/model";

export function ChatEvidence({ evidence, onClose, onOpen }: { evidence: ChatEvidenceState; onClose: () => void; onOpen: (reference: SourceReference) => void }) {
  return <aside className="question-evidence" aria-label="回答证据"><div><strong title={evidence.fileId}>{evidence.fileId}:{evidence.startLine}</strong><button type="button" aria-label="关闭证据" onClick={onClose}><X size={14}/></button></div>
    {evidence.status === "loading" ? <p role="status">正在读取引用…</p> : evidence.status === "error" ? <p role="alert">{evidence.error}</p> : <><pre>{evidence.source}</pre><button type="button" onClick={() => onOpen({ fileId: evidence.fileId, line: evidence.startLine })}>在源码中打开</button><small>请核对源码是否支持回答。</small></>}
  </aside>;
}

export function ChatMessage({ entry, stale, busy, evidence, onEvidence, onCloseEvidence, onOpen, onEdit, onSupplement, onTour }: {
  entry: QaMessage; stale: boolean; busy: boolean; evidence: ChatEvidenceState | null;
  onEvidence: (entry: QaMessage, reference: QaReference, index: number) => void;
  onCloseEvidence: () => void; onOpen: (reference: SourceReference) => void;
  onEdit: (text: string) => void; onSupplement: (entry: QaMessage) => void; onTour?: (route: AiRouteRecord) => void;
}) {
  const supplementAfterClose = useRef(false);
  const references = entry.references;
  const referenceButton = (reference: QaReference, index: number) => <button key={`${reference.fileId}:${reference.startLine}:${index}`} type="button" disabled={stale} title={stale ? "源码已变化，引用需要重新核对" : reference.fileId} onClick={() => onEvidence(entry, reference, index)}><FileCode2 size={12}/>{reference.fileId.split("/").pop()}:{reference.startLine}{reference.endLine && reference.endLine !== reference.startLine ? `–${reference.endLine}` : ""}</button>;
  return <article className={`question-message is-${entry.role}${stale ? " is-stale" : ""}`}>
    <div className="question-message-heading"><strong>{entry.role === "user" ? "你" : "RepoLens"}</strong>{stale && <span>源码已变化 · 回答过期</span>}</div>
    {entry.route ? <section className="chat-result-card"><strong>{entry.route.title}</strong><details><summary>{entry.route.steps.length} 个阅读步骤</summary><ol>{entry.route.steps.map(step => <li key={step.id}><button type="button" disabled={stale} onClick={() => onOpen(step.reference)}>{step.title}</button><p>{step.description}</p></li>)}</ol></details><button type="button" disabled={stale} onClick={() => onTour?.(entry.route!)}>开始阅读</button></section>
      : entry.explanation ? <section className="chat-result-card"><strong>{String(entry.explanation.role ?? entry.explanation.title ?? "文件讲解")}</strong><ul>{(Array.isArray(entry.explanation.keyPoints) ? entry.explanation.keyPoints as string[] : []).map((point, index) => <li key={index}><ChatMarkdown text={point}/></li>)}</ul></section>
      : <ChatMarkdown text={entry.content}/>}
    {!!entry.claims?.length && <details className="chat-claims"><summary>结论与依据</summary>{entry.claims.map((claim, index) => <div key={index}><p>{claim.text}</p><div className="question-references">{claim.referenceIndices.map(i => references[i] && referenceButton(references[i], i))}</div></div>)}</details>}
    {entry.insufficientEvidence && <p className="question-insufficient">当前源码范围不足以确认结论。</p>}
    {entry.role === "assistant" && !!references.length && <div className="question-references" aria-label="回答引用">{references.map(referenceButton)}</div>}
    {evidence?.messageId === entry.id && <ChatEvidence evidence={evidence} onClose={onCloseEvidence} onOpen={onOpen}/>}
    <div className="chat-message-tools"><ChatCopyButton text={entry.content} label={entry.role === "user" ? "复制问题" : "复制回答"}/><button type="button" disabled={busy} aria-label="编辑为新问题" title="编辑为新问题" onClick={() => onEdit(entry.content)}><Pencil size={13}/></button>
      {entry.role === "assistant" && <DropdownMenu><DropdownMenuTrigger asChild><button type="button" aria-label="回答菜单" title="更多"><MoreHorizontal size={15}/></button></DropdownMenuTrigger><DropdownMenuContent align="start" onCloseAutoFocus={event => { if (supplementAfterClose.current) { event.preventDefault(); supplementAfterClose.current = false; requestAnimationFrame(() => onSupplement(entry)); } }}><DropdownMenuItem disabled={busy} onSelect={() => { supplementAfterClose.current = true; }}>补充文件</DropdownMenuItem></DropdownMenuContent></DropdownMenu>}
    </div>
  </article>;
}
