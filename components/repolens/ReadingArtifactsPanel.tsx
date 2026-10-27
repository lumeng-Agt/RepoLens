import { WorkspaceDialog } from "./WorkspaceDialog";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Download, FileDown, Plus, Trash2 } from "lucide-react";
import type { AiRouteRecord, FileRecord, ReadingNote, RepositorySnapshot, SourceReference } from "@/data/model";
import { createAiRouteRecord } from "@/data/ai-route.mjs";
import { isReadingRangeValid, mergeReadingNotes, mergeSavedTours, readingArtifactConflictFingerprint } from "@/data/reading-artifacts.mjs";
import { localRepositoryProvider } from "@/data/providers";

type ExportFile = { format: "repolens-reading"; version: 1; workspaceId: string; ref?: string; notes: ReadingNote[]; tours: AiRouteRecord[] };
type RouteDraft = { sourceSignature: string; repositoryId: string; revision: string; title: string; goal: string; steps: { fileId: string; purpose: string; relationship: string; question: string; startLine: number; endLine?: number; originalFileId: string; originalStartLine: number; originalEndLine?: number; references: { fileId: string; startLine: number; endLine?: number | null }[] }[] };
const download = (name: string, type: string, content: string) => {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a"); link.href = url; link.download = name; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};
function isRoute(value: unknown): value is AiRouteRecord {
  if (!value || typeof value !== "object") return false;
  const route = value as AiRouteRecord;
  const validContext = Array.isArray(route.contextFiles) && route.contextFiles.every((item) => item && typeof item.fileId === "string" && typeof item.contentHash === "string");
  const validSteps = Array.isArray(route.steps) && route.steps.every((step) => step && typeof step.focusFileId === "string" && step.reference && step.reference.fileId === step.focusFileId && Number.isInteger(step.reference.line) && step.reference.line > 0);
  const validSourceSteps = route.sourceSteps === undefined || (Array.isArray(route.sourceSteps) && route.sourceSteps.every((step) => step && typeof step.fileId === "string" && Array.isArray(step.references) && step.references.every((reference) => reference && typeof reference.fileId === "string" && Number.isInteger(reference.startLine) && reference.startLine > 0)));
  return typeof route.title === "string" && typeof route.signature === "string" && typeof route.repositoryId === "string" && typeof route.entryFileId === "string" && typeof route.revision === "string" && validContext && validSteps && validSourceSteps;
}
function isNote(value: unknown): value is ReadingNote {
  if (!value || typeof value !== "object") return false;
  const note = value as ReadingNote;
  return typeof note.id === "string" && typeof note.fileId === "string" && typeof note.path === "string" && typeof note.text === "string" && Number.isInteger(note.startLine) && note.startLine > 0;
}
type ArtifactOperation = { repositoryId: string; workspaceId: string; revision: string; sessionVersion: number; clearGeneration: number };
function sameTarget(left: ArtifactOperation, right: ArtifactOperation) {
  return left.repositoryId === right.repositoryId && left.workspaceId === right.workspaceId && left.revision === right.revision && left.sessionVersion === right.sessionVersion && left.clearGeneration === right.clearGeneration;
}

export function ReadingArtifactsPanel({ repository, currentFile, filesById, focusedLine, notes, tours, sessionVersion, clearGeneration, clearing, onSaveNotes, onSaveTours, onActivateTour, onOpenReference, onNoteCreated }: {
  repository: RepositorySnapshot; currentFile: FileRecord; filesById: Map<string, FileRecord>; focusedLine: SourceReference | null;
  notes: ReadingNote[]; tours: AiRouteRecord[]; sessionVersion: number; clearGeneration: number; clearing: boolean; onSaveNotes: (value: ReadingNote[], expected?: ArtifactOperation) => Promise<boolean>; onSaveTours: (value: AiRouteRecord[], expected?: ArtifactOperation) => Promise<boolean>;
  onActivateTour: (route: AiRouteRecord) => void;
  onOpenReference: (reference: SourceReference) => void;
  onNoteCreated?: () => void;
}) {
  const [text, setText] = useState("");
  const [kind, setKind] = useState<ReadingNote["kind"]>("note");
  const [exportNoteSelection, setExportNoteSelection] = useState<Record<string, boolean>>({});
  const [exportTourSelection, setExportTourSelection] = useState<Record<string, boolean>>({});
  const [selectedNoteIds, setSelectedNoteIds] = useState<string[]>([]);
  const [manualTitle, setManualTitle] = useState(""); const [manualGoal, setManualGoal] = useState("");
  const [error, setError] = useState("");
  const [routeDraft, setRouteDraft] = useState<RouteDraft | null>(null);
  const [routeSaveBusy, setRouteSaveBusy] = useState(false);
  const routeEditController = useRef<AbortController | null>(null);
  const importController = useRef<AbortController | null>(null);
  const workspaceId = repository.workspaceId ?? repository.id;
  const latestArtifactsRef = useRef({ notes, tours });
  useLayoutEffect(() => { latestArtifactsRef.current = { notes, tours }; }, [notes, tours]);
  const currentTargetRef = useRef({ repositoryId: repository.id, workspaceId, revision: repository.revision ?? repository.version, sessionVersion, clearGeneration });
  useLayoutEffect(() => { currentTargetRef.current = { repositoryId: repository.id, workspaceId, revision: repository.revision ?? repository.version, sessionVersion, clearGeneration }; }, [repository.id, workspaceId, repository.revision, repository.version, sessionVersion, clearGeneration]);
  const importSequence = useRef(0);
  const [importPreview, setImportPreview] = useState<{ data: ExportFile; crossTarget: boolean; conflicts: number; conflictFingerprint: string; repositoryId: string; workspaceId: string; revision: string; sessionVersion: number; clearGeneration: number } | null>(null);
  const [importConfirmBusy, setImportConfirmBusy] = useState(false);
  const orderedNotes = useMemo(() => [...notes].sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine || a.createdAt - b.createdAt), [notes]);
  const exportNotes = notes.filter((note) => exportNoteSelection[note.id] !== false);
  const exportTours = tours.filter((tour) => exportTourSelection[tour.signature] !== false);
  const refLabel = repository.origin?.kind === "github" ? `${repository.origin.resolvedRef}@${repository.origin.commit}` : undefined;
  const activeTarget = { repositoryId: repository.id, workspaceId, revision: repository.revision ?? repository.version, sessionVersion, clearGeneration };
  const activeImportPreview = importPreview && sameTarget(importPreview, activeTarget) ? importPreview : null;
  useEffect(() => () => { importSequence.current += 1; routeEditController.current?.abort(); importController.current?.abort(); }, [repository.id, workspaceId, repository.revision, sessionVersion, clearGeneration]);
  const routeIsCurrent = (route: AiRouteRecord) => !route.stale && route.contextFiles.every((context) => filesById.get(context.fileId)?.contentHash === context.contentHash) && route.steps.every((step) => filesById.has(step.focusFileId) && filesById.has(step.reference.fileId) && Number.isInteger(step.reference.line) && step.reference.line > 0);
  const addNote = () => {
    const value = text.trim();
    if (clearing || !value || !currentFile.id) return;
    const startLine = focusedLine?.fileId === currentFile.id ? focusedLine.line : 1;
    const saving = onSaveNotes([...notes, { id: globalThis.crypto.randomUUID(), fileId: currentFile.id, path: currentFile.path, startLine, ...(focusedLine?.fileId === currentFile.id && focusedLine.endLine ? { endLine: focusedLine.endLine } : {}), text: value, contentHash: currentFile.contentHash ?? "", ...(repository.origin?.kind === "github" ? { commit: repository.origin.commit } : {}), createdAt: Date.now(), kind }], activeTarget);
    setText(""); setError("");
    void saving.then(() => { if (sameTarget(activeTarget, currentTargetRef.current)) onNoteCreated?.(); });
  };
  const createManualTour = async () => {
    if (clearing) return;
    const selected = notes.filter((note) => selectedNoteIds.includes(note.id) && !note.stale && filesById.get(note.fileId)?.contentHash === note.contentHash);
    if (!selected.length) { setError("请至少选择一条当前源码仍有效的笔记或书签。"); return; }
    const route = createAiRouteRecord({ repositoryId: repository.id, entryFileId: selected[0].fileId, revision: repository.revision ?? repository.version, title: manualTitle.trim() || "手动阅读路线", goal: manualGoal.trim() || undefined, steps: selected.map((note, index) => ({ fileId: note.fileId, purpose: note.text, ...(note.kind === "question" ? { question: note.text } : {}), relationship: index === 0 ? "用户选定的阅读入口" : "按所选顺序继续阅读，不代表程序运行时的调用顺序", references: [{ fileId: note.fileId, startLine: note.startLine, ...(note.endLine ? { endLine: note.endLine } : {}) }] })), contextFiles: [...new Map(selected.map((note) => [note.fileId, { fileId: note.fileId, contentHash: filesById.get(note.fileId)?.contentHash ?? "" }])).values()] }, (fileId) => filesById.get(fileId)?.name ?? fileId);
    const next = [...tours.filter((item) => item.signature !== route.signature), route];
    const saved = await onSaveTours(next, activeTarget);
    if (!sameTarget(activeTarget, currentTargetRef.current)) return;
    onActivateTour(route); setManualTitle(""); setManualGoal(""); setError(saved ? "手动路线已保存并设为当前路线。" : "手动路线未保存。请检查保存状态后重试。");
  };
  const exportJson = () => download("repolens-reading.json", "application/json", JSON.stringify({ format: "repolens-reading", version: 1, workspaceId: repository.workspaceId ?? repository.id, ...(refLabel ? { ref: refLabel } : {}), notes: exportNotes, tours: exportTours } satisfies ExportFile, null, 2));
  const exportMarkdown = () => {
    const noteText = orderedNotes.filter((note) => exportNoteSelection[note.id] !== false).map((note) => `### ${note.path}:${note.startLine}${note.endLine ? `-${note.endLine}` : ""}\n\n${note.text}`).join("\n\n");
    const routeText = exportTours.map((tour) => `## ${tour.title}${tour.goal ? `：${tour.goal}` : ""}\n\n${tour.steps.map((step, index) => `${index + 1}. ${step.title}：${step.description}（${step.reference.fileId}:${step.reference.line}）${step.question ? `\n   自测：${step.question}` : ""}`).join("\n")}`).join("\n\n");
    download("repolens-reading.md", "text/markdown;charset=utf-8", `# RepoLens 阅读记录\n\n${refLabel ? `来源：${refLabel}\n\n` : ""}${noteText}${noteText && routeText ? "\n\n" : ""}${routeText}\n`);
  };
  const readImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
    if (clearing || !file) return;
    importController.current?.abort();
    const controller = new AbortController(); importController.current = controller;
    const requestId = ++importSequence.current;
    const target = { ...currentTargetRef.current };
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error("导入文件超过 8 MiB 限制。");
      const parsed = JSON.parse(await file.text()) as Partial<ExportFile>;
      if (parsed.format !== "repolens-reading" || parsed.version !== 1 || !Array.isArray(parsed.notes) || !Array.isArray(parsed.tours) || !parsed.notes.every(isNote) || !parsed.tours.every(isRoute)) throw new Error("文件格式无效，只支持 RepoLens 阅读记录 JSON v1。");
      const referencedIds = new Set<string>();
      for (const note of parsed.notes) referencedIds.add(note.fileId);
      for (const tour of parsed.tours) {
        for (const step of tour.steps) { referencedIds.add(step.focusFileId); referencedIds.add(step.reference.fileId); }
        for (const step of tour.sourceSteps ?? []) for (const reference of step.references ?? []) referencedIds.add(reference.fileId);
      }
      const lineCounts = new Map<string, number>();
      await Promise.all([...referencedIds].map(async (fileId) => {
        if (!filesById.has(fileId)) return;
        try {
          const source = await localRepositoryProvider.getSource(target.repositoryId, target.revision, fileId, controller.signal);
          lineCounts.set(fileId, source.split(/\r?\n/).length);
        } catch { /* Keep the imported record and mark its location unverified below. */ }
      }));
      const incomingNotes = parsed.notes.map((note) => {
        const file = filesById.get(note.fileId);
        const stale = !file || (file.contentHash ?? "") !== note.contentHash || !isReadingRangeValid(lineCounts.get(note.fileId) ?? 0, note.startLine, note.endLine);
        return { ...note, ...(stale ? { stale: true } : { stale: false }) };
      });
      const incomingTours = parsed.tours.map((tour) => {
        const invalidStep = tour.steps.some((step) => {
          const file = filesById.get(step.reference.fileId);
          return !filesById.has(step.focusFileId) || !file || !isReadingRangeValid(lineCounts.get(step.reference.fileId) ?? 0, step.reference.line, step.reference.endLine);
        });
        const changedContext = (tour.contextFiles ?? []).some((context) => filesById.get(context.fileId)?.contentHash !== context.contentHash);
        return { ...tour, ...(invalidStep || changedContext ? { stale: true } : { stale: false }) };
      });
      const incoming: ExportFile = { format: "repolens-reading", version: 1, workspaceId: String(parsed.workspaceId ?? ""), ...(typeof parsed.ref === "string" ? { ref: parsed.ref } : {}), notes: incomingNotes, tours: incomingTours };
      if (controller.signal.aborted || requestId !== importSequence.current || !sameTarget(target, currentTargetRef.current)) return;
      const latest = latestArtifactsRef.current;
      const crossTarget = incoming.workspaceId !== target.workspaceId || Boolean(incoming.ref && refLabel && incoming.ref !== refLabel);
      const noteConflicts = mergeReadingNotes(latest.notes, incoming.notes, () => "preview-copy").conflicts;
      const tourConflicts = mergeSavedTours(latest.tours, incoming.tours).conflicts;
      const conflicts = noteConflicts + tourConflicts;
      const conflictFingerprint = readingArtifactConflictFingerprint(latest.notes, incoming.notes, latest.tours, incoming.tours);
      setImportPreview({ data: incoming, crossTarget, conflicts, conflictFingerprint, ...target });
      setError("");
    } catch (cause) { if ((cause as Error)?.name !== "AbortError" && requestId === importSequence.current) { setImportPreview(null); setError(cause instanceof Error ? cause.message : "无法读取导入文件。"); } }
    finally { if (importController.current === controller) importController.current = null; }
  };
  const confirmImport = async () => {
    if (clearing || !importPreview || importConfirmBusy) return;
    if (importPreview.crossTarget && !window.confirm("此记录来自其他仓库或 ref。仍要导入到当前工作区吗？旧源码位置将重新核对。")) return;
    const targetRepositoryId = repository.id;
    const targetRevision = repository.revision ?? repository.version;
    const expectedTarget = { repositoryId: targetRepositoryId, workspaceId, revision: targetRevision, sessionVersion, clearGeneration };
    if (!sameTarget(importPreview, expectedTarget)) { setError("仓库会话或内容已变化，请重新生成导入预览。"); return; }
    const controller = new AbortController(); importController.current?.abort(); importController.current = controller;
    const requestId = ++importSequence.current;
    setImportConfirmBusy(true); setError("");
    try {
      const referencedIds = new Set<string>();
      for (const note of importPreview.data.notes) referencedIds.add(note.fileId);
      for (const tour of importPreview.data.tours) {
        for (const step of tour.steps) { referencedIds.add(step.focusFileId); referencedIds.add(step.reference.fileId); }
        for (const step of tour.sourceSteps ?? []) for (const reference of step.references ?? []) referencedIds.add(reference.fileId);
        for (const context of tour.contextFiles ?? []) referencedIds.add(context.fileId);
      }
      const lineCounts = new Map<string, number>();
      await Promise.all([...referencedIds].map(async (fileId) => {
        if (!filesById.has(fileId)) return;
        try {
          const source = await localRepositoryProvider.getSource(targetRepositoryId, targetRevision, fileId, controller.signal);
          lineCounts.set(fileId, source.split(/\r?\n/).length);
        } catch { /* Keep the note text, but do not enable an unverified source jump. */ }
      }));
      if (controller.signal.aborted) return;
      if (controller.signal.aborted || requestId !== importSequence.current || !sameTarget(currentTargetRef.current, expectedTarget)) throw new Error("仓库会话或内容已变化，导入未提交。请重新生成预览。");
      const checkedNotes = importPreview.data.notes.map((note) => {
        const file = filesById.get(note.fileId);
        const stale = !file || (file.contentHash ?? "") !== note.contentHash || !isReadingRangeValid(lineCounts.get(note.fileId) ?? 0, note.startLine, note.endLine);
        return { ...note, ...(stale ? { stale: true } : { stale: false }) };
      });
      const checkedTours = importPreview.data.tours.map((tour) => {
        const invalidStep = tour.steps.some((step) => !filesById.has(step.focusFileId) || !filesById.has(step.reference.fileId) || !isReadingRangeValid(lineCounts.get(step.reference.fileId) ?? 0, step.reference.line, step.reference.endLine));
        const changedContext = tour.contextFiles.some((context) => filesById.get(context.fileId)?.contentHash !== context.contentHash);
        return { ...tour, repositoryId: targetRepositoryId, revision: targetRevision, ...(invalidStep || changedContext ? { stale: true } : { stale: false }) };
      });
      const latest = latestArtifactsRef.current;
      const nextFingerprint = readingArtifactConflictFingerprint(latest.notes, checkedNotes, latest.tours, checkedTours);
      if (nextFingerprint !== importPreview.conflictFingerprint) {
        const noteConflicts = mergeReadingNotes(latest.notes, checkedNotes, () => "preview-copy").conflicts;
        const tourConflicts = mergeSavedTours(latest.tours, checkedTours).conflicts;
        setImportPreview({ ...importPreview, data: { ...importPreview.data, notes: checkedNotes, tours: checkedTours }, conflicts: noteConflicts + tourConflicts, conflictFingerprint: nextFingerprint });
        setError("阅读记录在预览后发生变化，冲突预览已更新。请再次确认导入。");
        return;
      }
      const noteMerge = mergeReadingNotes(latest.notes, checkedNotes, () => globalThis.crypto.randomUUID());
      const importedNotes = noteMerge.records.filter((note) => !latest.notes.some((existing) => existing.id === note.id));
      const tourMerge = mergeSavedTours(latest.tours, checkedTours);
      const importedTours = tourMerge.records.filter((tour) => !latest.tours.some((existing) => existing.signature === tour.signature));
      let notesSaved = await onSaveNotes(noteMerge.records, expectedTarget);
      if (controller.signal.aborted || requestId !== importSequence.current || !sameTarget(currentTargetRef.current, expectedTarget)) return;
      const afterNoteSave = latestArtifactsRef.current;
      const reconciledNotes = mergeReadingNotes(afterNoteSave.notes, importedNotes, () => globalThis.crypto.randomUUID());
      if (reconciledNotes.added) notesSaved = await onSaveNotes(reconciledNotes.records, expectedTarget) && notesSaved;
      const reconciledTours = mergeSavedTours(afterNoteSave.tours, importedTours);
      let toursSaved = await onSaveTours(reconciledTours.records, expectedTarget);
      if (controller.signal.aborted || requestId !== importSequence.current || !sameTarget(currentTargetRef.current, expectedTarget)) return;
      const afterTourSave = latestArtifactsRef.current;
      const finalTours = mergeSavedTours(afterTourSave.tours, importedTours);
      if (finalTours.added) toursSaved = await onSaveTours(finalTours.records, expectedTarget) && toursSaved;
      setImportPreview(null);
      const importedMessage = `已导入 ${noteMerge.added + reconciledNotes.added} 条笔记和 ${tourMerge.added} 条路线；${noteMerge.conflicts + reconciledNotes.conflicts + tourMerge.conflicts + reconciledTours.conflicts + finalTours.conflicts} 条冲突已作为副本保留，完全相同的记录已跳过。`;
      setError(notesSaved && toursSaved ? importedMessage : `${importedMessage} 部分内容尚未保存到本地，请检查保存状态后重试。`);
    } catch (cause) {
      if ((cause as Error)?.name !== "AbortError") setError(cause instanceof Error ? cause.message : "无法完成导入。原有记录没有更改。");
    } finally { if (importController.current === controller) importController.current = null; if (requestId === importSequence.current) setImportConfirmBusy(false); }
  };
  const beginEditRoute = (route: AiRouteRecord) => setRouteDraft({
    sourceSignature: route.signature, repositoryId: repository.id, revision: repository.revision ?? repository.version,
    title: route.title, goal: route.goal ?? "",
    steps: route.steps.map((step, index) => ({ references: route.sourceSteps?.[index]?.references ?? [{ fileId: step.reference.fileId, startLine: step.reference.line, endLine: step.reference.endLine }], originalFileId: step.focusFileId, originalStartLine: step.reference.line, originalEndLine: step.reference.endLine, fileId: step.focusFileId, purpose: step.description, relationship: step.relationship ?? "", question: step.question ?? "", startLine: step.reference.fileId === step.focusFileId ? step.reference.line : 1, ...(step.reference.endLine ? { endLine: step.reference.endLine } : {}) })),
  });
  const moveDraftStep = (index: number, delta: -1 | 1) => setRouteDraft((draft) => {
    if (!draft) return draft;
    const target = index + delta;
    if (target < 0 || target >= draft.steps.length) return draft;
    const steps = [...draft.steps]; [steps[index], steps[target]] = [steps[target], steps[index]];
    return { ...draft, steps };
  });
  const saveRouteDraft = async () => {
    if (clearing || !routeDraft || routeDraft.repositoryId !== repository.id || routeDraft.revision !== (repository.revision ?? repository.version)) { setError("仓库内容或保存状态已变化，请重新打开路线编辑后再保存。"); return; }
    if (!routeDraft.title.trim() || routeDraft.steps.length < 1 || routeDraft.steps.length > 7) { setError("路线需要标题，并至少包含一个步骤。"); return; }
    const controller = new AbortController(); routeEditController.current?.abort(); routeEditController.current = controller; setRouteSaveBusy(true); setError("");
    try {
      const referencesFor = (step: RouteDraft["steps"][number]) => step.references.map((reference) => reference.fileId === step.originalFileId && reference.startLine === step.originalStartLine && (reference.endLine ?? undefined) === step.originalEndLine ? { fileId: step.fileId, startLine: step.startLine, endLine: step.endLine } : reference);
      const uniqueFileIds = [...new Set(routeDraft.steps.flatMap((step) => referencesFor(step).map((reference) => reference.fileId)))];
      const lineCounts = new Map<string, number>();
      for (const fileId of uniqueFileIds) {
        if (!filesById.has(fileId)) throw new Error(`路线文件不存在：${fileId}`);
        const source = await localRepositoryProvider.getSource(repository.id, repository.revision, fileId, controller.signal);
        lineCounts.set(fileId, source.split(/\r?\n/).length);
      }
      if (controller.signal.aborted) return;
      for (const [index, step] of routeDraft.steps.entries()) {
        if (referencesFor(step).some((reference) => !isReadingRangeValid(lineCounts.get(reference.fileId) ?? 0, reference.startLine, reference.endLine ?? undefined))) throw new Error(`第 ${index + 1} 步的源码行范围已失效：${step.fileId}:${step.startLine}`);
      }
      const contextFiles = uniqueFileIds.map((fileId) => ({ fileId, contentHash: filesById.get(fileId)?.contentHash ?? "" }));
      const route = createAiRouteRecord({
        repositoryId: repository.id, entryFileId: routeDraft.steps[0].fileId, revision: repository.revision ?? repository.version,
        title: routeDraft.title.trim(), goal: routeDraft.goal.trim() || undefined,
        steps: routeDraft.steps.map((step) => ({ fileId: step.fileId, purpose: step.purpose.trim() || `阅读 ${filesById.get(step.fileId)?.name ?? step.fileId}`, ...(step.relationship.trim() ? { relationship: step.relationship.trim() } : {}), ...(step.question.trim() ? { question: step.question.trim() } : {}), references: referencesFor(step) })),
        contextFiles,
      }, (fileId) => filesById.get(fileId)?.name ?? fileId);
      const next = [...latestArtifactsRef.current.tours.filter((item) => item.signature !== routeDraft.sourceSignature && item.signature !== route.signature), route];
      const saved = await onSaveTours(next, activeTarget);
      if (!sameTarget(activeTarget, currentTargetRef.current)) return;
      onActivateTour(route); setRouteDraft(null); setError(saved ? "路线已更新；每一步引用均已按当前源码行范围校验。" : "路线已更新并保留在页面；请检查保存状态并重试。");
    } catch (cause) {
      if ((cause as Error)?.name !== "AbortError") setError(cause instanceof Error ? cause.message : "无法保存路线。");
    } finally { if (routeEditController.current === controller) routeEditController.current = null; setRouteSaveBusy(false); }
  };

  return <section className="reading-artifacts" aria-label="阅读笔记和路线">
    <div className="reading-artifacts-heading"><strong>阅读笔记与路线</strong><div><button type="button" onClick={exportMarkdown} disabled={!exportNotes.length && !exportTours.length} title="导出所选内容为 Markdown"><Download size={14} />Markdown</button><button type="button" onClick={exportJson} disabled={!exportNotes.length && !exportTours.length} title="导出所选内容为 JSON"><FileDown size={14} />JSON</button><label className="reading-import-button"><FileDown size={14} />导入<input type="file" accept="application/json,.json" onChange={(event) => void readImport(event)} /></label></div></div>
    <p className="reading-export-warning">导出不附源码副本；笔记和生成的路线说明文字可能包含代码摘录。</p>
    <details className="reading-export-selection"><summary>选择导出内容 · 笔记 {exportNotes.length}/{notes.length} · 路线 {exportTours.length}/{tours.length}</summary><div><strong>笔记与书签</strong>{orderedNotes.length ? orderedNotes.map((note) => <label key={`export-note:${note.id}`}><input type="checkbox" aria-label={`导出笔记：${note.path}:${note.startLine} ${note.text.slice(0, 40)}`} checked={exportNoteSelection[note.id] !== false} onChange={(event) => setExportNoteSelection((current) => ({ ...current, [note.id]: event.target.checked }))} />{note.path}:{note.startLine} · {note.text.slice(0, 70)}</label>) : <small>当前没有笔记。</small>}<strong>阅读路线</strong>{tours.length ? tours.map((tour) => <label key={`export-tour:${tour.signature}`}><input type="checkbox" aria-label={`导出路线：${tour.title}`} checked={exportTourSelection[tour.signature] !== false} onChange={(event) => setExportTourSelection((current) => ({ ...current, [tour.signature]: event.target.checked }))} />{tour.title}</label>) : <small>当前没有路线。</small>}</div></details>
    <div className="reading-note-editor"><select aria-label="记录类型" value={kind} disabled={clearing} onChange={(event) => setKind(event.target.value as ReadingNote["kind"])}><option value="note">笔记</option><option value="bookmark">书签</option><option value="question">待理解</option></select><textarea aria-label="阅读笔记内容" value={text} disabled={clearing} maxLength={20_000} onChange={(event) => setText(event.target.value)} placeholder={`为 ${currentFile.path || "当前文件"} 添加记录；默认关联第 ${focusedLine?.fileId === currentFile.id ? focusedLine.line : 1} 行`} /><button type="button" onClick={addNote} disabled={clearing || !text.trim()}><Plus size={14} />保存记录</button></div>
    {orderedNotes.length > 0 ? <div className="reading-note-list">{orderedNotes.map((note) => {
      const file = filesById.get(note.fileId); const stale = Boolean(note.stale) || !file || (file.contentHash ?? "") !== note.contentHash;
      return <article key={note.id} className={stale ? "is-stale" : ""}><div><strong>{note.kind === "bookmark" ? "书签" : note.kind === "question" ? "待理解" : "笔记"}</strong><button type="button" disabled={stale} onClick={() => onOpenReference({ fileId: note.fileId, line: note.startLine, ...(note.endLine ? { endLine: note.endLine } : {}) })}>{note.path}:{note.startLine}{note.endLine ? `–${note.endLine}` : ""}</button><button type="button" aria-label="删除记录" disabled={clearing} onClick={() => void onSaveNotes(notes.filter((item) => item.id !== note.id), activeTarget)}><Trash2 size={13} /></button></div><p>{note.text}</p>{stale && <small>关联源码已变化或文件不存在；文字保留，旧位置已停用。</small>}</article>;
    })}</div> : <p className="reading-empty">还没有阅读记录。可以先定位源码行，再添加笔记、书签或待理解问题。</p>}
    {notes.length > 0 && <details className="manual-tour-builder"><summary>用阅读记录组装手动路线</summary><label>路线标题<input value={manualTitle} maxLength={120} onChange={(event) => setManualTitle(event.target.value)} placeholder="例如：理解请求处理" /></label><label>阅读目标<input value={manualGoal} maxLength={300} onChange={(event) => setManualGoal(event.target.value)} placeholder="可选" /></label><div>{orderedNotes.map((note) => <label key={`route:${note.id}`}><input type="checkbox" checked={selectedNoteIds.includes(note.id)} disabled={Boolean(note.stale || !filesById.has(note.fileId) || filesById.get(note.fileId)?.contentHash !== note.contentHash)} onChange={(event) => setSelectedNoteIds((current) => event.target.checked ? [...current, note.id] : current.filter((id) => id !== note.id))} />{note.path}:{note.startLine} · {note.text.slice(0, 80)}</label>)}</div><button type="button" disabled={!selectedNoteIds.length} onClick={createManualTour}>创建并开始路线</button></details>}
    {tours.length > 0 && <details className="saved-tour-list"><summary>已保存路线 · {tours.length}</summary>{tours.map((tour) => {
      const current = routeIsCurrent(tour);
      return <article key={tour.signature} className={!current ? "is-stale" : ""}><div><strong>{tour.title}</strong><button type="button" disabled={!current} onClick={() => onActivateTour(tour)}>打开路线</button><button type="button" onClick={() => beginEditRoute(tour)}>编辑</button></div>{tour.goal && <small>{tour.goal}</small>}<p>{tour.steps.length} 步 · {tour.steps[0]?.focusFileId}</p>{!current && <small>路线的源码依据已变化或未通过导入校验；旧行号已停用，可编辑并重新校验。</small>}</article>;
    })}</details>}
    {routeDraft && <WorkspaceDialog onDismiss={() => { routeEditController.current?.abort(); setRouteDraft(null); }} className="route-editor" aria-label="编辑阅读路线">
      <strong>编辑路线并校验引用</strong>
      <label>路线标题<input value={routeDraft.title} maxLength={120} onChange={(event) => setRouteDraft((draft) => draft ? { ...draft, title: event.target.value } : draft)} /></label>
      <label>阅读目标<input value={routeDraft.goal} maxLength={300} onChange={(event) => setRouteDraft((draft) => draft ? { ...draft, goal: event.target.value } : draft)} /></label>
      <ol>{routeDraft.steps.map((step, index) => <li key={`${step.fileId}:${index}`}>
        <div className="route-editor-order"><strong>第 {index + 1} 步</strong><button type="button" disabled={index === 0} aria-label="上移步骤" onClick={() => moveDraftStep(index, -1)}>上移</button><button type="button" disabled={index === routeDraft.steps.length - 1} aria-label="下移步骤" onClick={() => moveDraftStep(index, 1)}>下移</button></div>
        <label>步骤文件<select aria-label={`第 ${index + 1} 步文件`} value={step.fileId} onChange={(event) => setRouteDraft((draft) => draft ? { ...draft, steps: draft.steps.map((item, stepIndex) => stepIndex === index ? { ...item, fileId: event.target.value, startLine: 1, endLine: undefined } : item) } : draft)}>{[...filesById.values()].sort((a, b) => a.path.localeCompare(b.path)).map((file) => <option key={file.id} value={file.id}>{file.path}</option>)}</select></label>
        <label>阅读目的<textarea value={step.purpose} maxLength={1_000} onChange={(event) => setRouteDraft((draft) => draft ? { ...draft, steps: draft.steps.map((item, stepIndex) => stepIndex === index ? { ...item, purpose: event.target.value } : item) } : draft)} /></label>
        <label>源码行<input type="number" min={1} value={step.startLine} onChange={(event) => setRouteDraft((draft) => draft ? { ...draft, steps: draft.steps.map((item, stepIndex) => stepIndex === index ? { ...item, startLine: Number(event.target.value) } : item) } : draft)} /></label>
        <label>与上一步的关系<input value={step.relationship} maxLength={500} onChange={(event) => setRouteDraft((draft) => draft ? { ...draft, steps: draft.steps.map((item, stepIndex) => stepIndex === index ? { ...item, relationship: event.target.value } : item) } : draft)} /></label>
        <label>检查理解的问题<input value={step.question} maxLength={500} onChange={(event) => setRouteDraft((draft) => draft ? { ...draft, steps: draft.steps.map((item, stepIndex) => stepIndex === index ? { ...item, question: event.target.value } : item) } : draft)} /></label>
      </li>)}</ol>
      <p>保存时会重新读取源码并校验每步行号。修改后的路线会单独记录进度，原路线进度仍保留。</p>
      <button type="button" disabled={clearing || routeSaveBusy || routeDraft.steps.length < 1 || routeDraft.steps.length > 7} onClick={() => void saveRouteDraft()}>{routeSaveBusy ? "正在校验…" : "校验并保存路线"}</button><button type="button" disabled={routeSaveBusy} onClick={() => { routeEditController.current?.abort(); setRouteDraft(null); }}>取消</button>
    </WorkspaceDialog>}
    {activeImportPreview && <WorkspaceDialog onDismiss={() => { importController.current?.abort(); importSequence.current += 1; setImportPreview(null); }} className="reading-import-preview" aria-label="导入预览"><strong>导入预览</strong><p>{activeImportPreview.data.notes.length} 条笔记 · {activeImportPreview.data.tours.length} 条路线 · {activeImportPreview.conflicts} 条记录冲突</p>{activeImportPreview.crossTarget && <p role="alert">来源工作区或 Git 版本标识不同，需要明确确认；无效源码位置会保留说明并停用跳转。</p>}<p>导入位置会逐条检查；确认时会重新核对仓库、引用和记录冲突。</p><button type="button" disabled={clearing || importConfirmBusy} onClick={() => void confirmImport()}>{importConfirmBusy ? "正在重新校验…" : "确认导入"}</button><button type="button" disabled={importConfirmBusy} onClick={() => setImportPreview(null)}>取消</button></WorkspaceDialog>}
    {error && <p role="status" className="reading-feedback">{error}</p>}
  </section>;
}
