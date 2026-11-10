import type { ChatIntent } from "@/components/repolens/chat-intent";
import "./chat.css";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { X, MessageSquare } from "lucide-react";
import type { AiRouteRecord, FileRecord, RepositorySnapshot, SourceReference } from "@/data/model";

// Load the transcript and its Markdown renderer together so restoring scroll uses final message heights.
const QuestionPanel = lazy(() => import("./QuestionPanel").then(module => ({ default: module.QuestionPanel })));

type Workspace = { repository: RepositorySnapshot; file: FileRecord };
export function AiChatSidebar({ onShowGraph, open, repository, currentFile, intent, available, clearingTarget, clearVersions, clearAllVersion, extraFileIds, modelSettings, onClose, onSettings, onOpenRepository, onOpenReference, onCompleted, onActivateTour, onRelations, savedTourSignatures, onSaveTour }: { onShowGraph?: (ids: string[]) => void;
  open: boolean; repository: RepositorySnapshot; currentFile: FileRecord; intent: ChatIntent; available: boolean; clearingTarget: string | null; clearVersions: Record<string, number>; clearAllVersion: number; extraFileIds: string[]; modelSettings: { baseUrl: string; model: string; configured: boolean };
  savedTourSignatures: string[]; onSaveTour: (route: AiRouteRecord) => Promise<boolean>;
  onRelations: (fileId: string) => void; onClose: () => void; onSettings: () => void; onOpenRepository: () => void; onOpenReference: (reference: SourceReference) => void; onCompleted: (workspaceId: string) => void; onActivateTour: (route: AiRouteRecord) => void;
}) {
  const workspaceId = repository.workspaceId ?? repository.id;
  const [workspaces, setWorkspaces] = useState<Map<string, Workspace>>(new Map());
  useEffect(() => {
    if (repository.source !== "local" || !open) return;
    // Keep the last known repository/file per workspace while the sidebar is open.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWorkspaces((previous) => new Map(previous).set(workspaceId, { repository, file: currentFile }));
  }, [repository, currentFile, workspaceId, open]);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);
  const entries = useMemo(() => [...workspaces.entries()], [workspaces]);
  return <aside id="ai-chat-panel" className={`ai-chat-sidebar${open ? " is-open" : ""}`} aria-label="AI 聊天" hidden={!open}>
    {repository.source !== "local" && <header className="ai-chat-heading"><strong><MessageSquare size={15} />聊天</strong><button type="button" aria-label="收起 AI 面板" title="关闭面板，已确认的请求会继续" onClick={onClose}><X size={17} /></button></header>}
    {repository.source !== "local" && <div className="ai-chat-example"><h3>示例使用预置讲解</h3><p>打开自己的仓库后，可以讲解文件、生成路线或提问。</p><button type="button" onClick={onOpenRepository}>打开自己的仓库</button></div>}
    {entries.map(([id, entry]) => <div key={id} className="ai-chat-workspace" hidden={id !== workspaceId || repository.source !== "local"}>
      <Suspense fallback={<p role="status">正在加载聊天…</p>}>
        <QuestionPanel onShowGraph={onShowGraph} savedTourSignatures={id === workspaceId ? savedTourSignatures : []} onSaveTour={id === workspaceId ? onSaveTour : undefined} onRelations={onRelations} unified modelSettings={modelSettings} onCloseChat={onClose} repository={entry.repository} currentFile={entry.file} filesById={new Map(entry.repository.files.map((file) => [file.id, file]))} active={open && id === workspaceId} persistenceActive={id === workspaceId && repository.source === "local"} backendAvailable={available} storageBusy={clearingTarget === "*" || clearingTarget === id} clearVersion={clearAllVersion * 1_000_000 + (clearVersions[id] ?? 0)} intent={id === workspaceId ? intent : undefined} additionalFileIds={id === workspaceId ? extraFileIds : []} onOpenSettings={onSettings} onOpenReference={onOpenReference} onCompleted={() => onCompleted(id)} onActivateTour={onActivateTour} />
      </Suspense>
    </div>)}
  </aside>;
}
