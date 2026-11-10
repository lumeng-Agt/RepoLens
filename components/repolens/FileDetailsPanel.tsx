import { useEffect, useMemo, useState, useRef, type RefObject, type ReactNode } from "react";
import Prism, { type Token, type TokenStream } from "prismjs";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-css";
import "prismjs/components/prism-python";
import "prismjs/components/prism-go";
import { BookOpenText, ChevronRight, Code2, FileCode2, FileText, MessageSquare, Waypoints, X } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AiResultView, type AiResultRecord } from "@/components/repolens/AiResultView";
import { ReadingArtifactsPanel } from "@/components/repolens/ReadingArtifactsPanel";
import type { AiMode } from "@/data/explanation-provider";
import type { AiRouteRecord, FileRecord, ReadingNote, RepositorySnapshot, SourceReference } from "@/data/model";
import { visibleLineWindow } from "@/data/source-window.mjs";

const HIGHLIGHT_CACHE_LIMIT = 4;
const HIGHLIGHT_CACHE_CHAR_LIMIT = 300_000;
const highlightedCache = new Map<string, { source: string; lines: ReturnType<typeof highlightedLines> }>();

function sourceGrammar(language: string) {
  if (language === "tsx") return Prism.languages.tsx;
  if (language === "jsx") return Prism.languages.jsx;
  if (["ts", "mts", "cts"].includes(language)) return Prism.languages.typescript;
  if (["js", "mjs", "cjs"].includes(language)) return Prism.languages.javascript;
  if (["css", "scss", "sass", "less"].includes(language)) return Prism.languages.css;
  if (language === "python" || language === "py" || language === "pyi") return Prism.languages.python;
  if (language === "go") return Prism.languages.go;
  return undefined;
}
function highlightedLines(source: string, language: string) {
  const lines: { text: string; tokens: string[] }[][] = [[]];
  const visit = (items: TokenStream, classes: string[]) => {
    for (const item of (Array.isArray(items) ? items : [items])) {
      if (typeof item === "string") {
        const parts = item.split("\n");
        parts.forEach((part, index) => { if (part) lines[lines.length - 1].push({ text: part, tokens: classes }); if (index < parts.length - 1) lines.push([]); });
      } else { const token = item as Token; visit(token.content, [...classes, String(token.type)]); }
    }
  };
  const grammar = sourceGrammar(language);
  if (grammar) visit(Prism.tokenize(source, grammar), []); else visit([source], []);
  return lines.map((segments, index) => ({ number: index + 1, segments }));
}

function cachedHighlightedLines(source: string, language: string) {
  // Keep large files out of the cross-file cache so syntax tokens do not retain
  // several copies of megabyte-sized source buffers in memory.
  if (source.length > HIGHLIGHT_CACHE_CHAR_LIMIT) return highlightedLines(source, language);
  const key = `${language}:${source.length}:${source.slice(0, 96)}:${source.slice(-96)}`;
  const cached = highlightedCache.get(key);
  if (cached?.source === source) {
    highlightedCache.delete(key);
    highlightedCache.set(key, cached);
    return cached.lines;
  }
  const lines = highlightedLines(source, language);
  highlightedCache.set(key, { source, lines });
  while (highlightedCache.size > HIGHLIGHT_CACHE_LIMIT) highlightedCache.delete(highlightedCache.keys().next().value!);
  return lines;
}

function SourceCodeView({ lines, path, sourceText, focusedLine, viewportRef, onSelection }: {
  lines: ReturnType<typeof highlightedLines>;
  path: string;
  sourceText: string;
  focusedLine: SourceReference | null;
  viewportRef: RefObject<HTMLDivElement | null>; onSelection?: (start: number, end: number) => void;
}) {
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const anchor = useRef(1);
  const capture = () => {
    const selected = window.getSelection();
    const lineFor = (node: Node | null) => (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>("[data-source-line]");
    const first = lineFor(selected?.anchorNode ?? null); const last = lineFor(selected?.focusNode ?? null);
    if (!selected?.isCollapsed && first && last && viewportRef.current?.contains(first) && viewportRef.current.contains(last)) setSelection({ start: Math.min(Number(first.dataset.sourceLine), Number(last.dataset.sourceLine)), end: Math.max(Number(first.dataset.sourceLine), Number(last.dataset.sourceLine)) });
  };
  const [scrollState, setScrollState] = useState({ top: 0, height: 0 });
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = { top: viewport.scrollTop, height: viewport.clientHeight };
        setScrollState((current) => current.top === next.top && current.height === next.height ? current : next);
      });
    };
    update();
    viewport.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); viewport.removeEventListener("scroll", update); };
  }, [viewportRef]);

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === "l" && selection && viewportRef.current?.contains(document.activeElement)) { event.preventDefault(); onSelection?.(selection.start, selection.end); }
    };
    window.addEventListener("keydown", handle); return () => window.removeEventListener("keydown", handle);
  }, [selection, onSelection, viewportRef]);
  const virtualized = lines.length > 1_200;
  const range = virtualized ? visibleLineWindow({ lineCount: lines.length, scrollTop: scrollState.top, viewportHeight: scrollState.height }) : { start: 0, end: lines.length, top: 0, bottom: 0 };
  const visibleLines = lines.slice(range.start, range.end);
  return <><div className="source-selection-actions" onMouseUp={capture}>
    {selection && <div role="toolbar" aria-label="源码选段操作"><span>第 {selection.start}–{selection.end} 行</span><button type="button" onClick={() => onSelection?.(selection.start, selection.end)}>加入聊天</button><button type="button" onClick={() => onSelection?.(-selection.start, selection.end)}>解释这段代码</button><button type="button" onClick={() => onSelection?.(selection.start, -selection.end)}>添加笔记</button><button type="button" aria-label="取消选段" onClick={() => setSelection(null)}>×</button></div>}
    {virtualized && <pre className="source-accessible-copy" tabIndex={0} aria-label={`${path} 完整源码，${lines.length} 行`}>{sourceText}</pre>}<pre className={`source-code${virtualized ? " is-virtualized" : ""}`} aria-hidden={virtualized} tabIndex={0} aria-label={`${path} 源码`}><code>
    {range.top > 0 && <span className="source-window-spacer" aria-hidden="true" style={{ height: range.top }} />}
    {visibleLines.map(({ number, segments }) => {
      const isFocused = focusedLine && number >= focusedLine.line && number <= (focusedLine.endLine ?? focusedLine.line);
      return <span key={number} id={`source-line-${number}`} data-source-line={number} className={`source-line${selection && number >= selection.start && number <= selection.end ? " is-selected" : ""}${isFocused ? " is-focused" : ""}`}><button type="button" className="line-number" aria-label={`选择第 ${number} 行`} onClick={event => { if (!event.shiftKey) anchor.current = number; setSelection({ start: Math.min(anchor.current, number), end: Math.max(anchor.current, number) }); }}>{String(number).padStart(2, "0")}</button><span className="line-content">{segments.map((segment, index) => <span key={`${number}-${index}`} className={segment.tokens.length ? `token ${segment.tokens.join(" ")}` : undefined}>{segment.text}</span>)}</span></span>;
    })}
    {range.bottom > 0 && <span className="source-window-spacer" aria-hidden="true" style={{ height: range.bottom }} />}
  </code></pre></div></>;
}

function ReferenceButton({ icon, title, caption, onClick }: { icon: ReactNode; title: string; caption: string; onClick: () => void }) {
  return <button className="reference-row" onClick={onClick}><span className="reference-icon">{icon}</span><span className="reference-copy"><strong>{title}</strong><small>{caption}</small></span><ChevronRight size={14} className="reference-arrow" /></button>;
}

export function FileDetailsPanel({ repository, currentFile, filesById, mobileView, detailTab, onDetailTabChange, onOpenAi, onChatSelection, onOpenReference, backendAvailable = true,
  aiSettings, onOpenModelSettings, onOpenRepository, canOpenRepository, onPreviewAi,
  aiResult, aiStale,
  sourceText, sourceStatus, sourceError, focusedLine, onClearFocus, codeViewportRef, readingNotes, savedTours, sessionVersion, savedDataClearGeneration, savedDataClearBusy, onSaveReadingNotes, onSaveTours, onActivateTour, onGuideNoteCreated,
}: {
  repository: RepositorySnapshot; currentFile: FileRecord; filesById: Map<string, FileRecord>; mobileView: "files" | "graph" | "details"; detailTab: string; backendAvailable?: boolean;
  onChatSelection?: (start: number, end: number) => void;
  onDetailTabChange: (tab: string) => void; onOpenAi: () => void; onOpenReference: (reference: SourceReference) => void;
  aiSettings: { baseUrl: string; model: string; apiKey: string; configured: boolean };
  onOpenModelSettings: () => void; onOpenRepository: () => void; canOpenRepository: boolean; onPreviewAi: (mode: AiMode, fileIds?: string[], goal?: string) => void;
  aiResult: AiResultRecord | null; aiStale: boolean;
  sourceText: string; sourceStatus: "loading" | "loaded" | "error"; sourceError?: string;
  focusedLine: SourceReference | null; onClearFocus: () => void; codeViewportRef: RefObject<HTMLDivElement | null>;
  readingNotes: ReadingNote[]; savedTours: AiRouteRecord[]; sessionVersion: number; savedDataClearGeneration: number; savedDataClearBusy: boolean; onSaveReadingNotes: (notes: ReadingNote[], expected?: { repositoryId: string; workspaceId: string; sessionVersion: number; clearGeneration: number }) => Promise<boolean>; onSaveTours: (tours: AiRouteRecord[], expected?: { repositoryId: string; workspaceId: string; sessionVersion: number; clearGeneration: number }) => Promise<boolean>; onActivateTour: (route: AiRouteRecord) => void; onGuideNoteCreated?: () => void;
}) {

  const outgoing = repository.dependencies.filter((edge) => edge.fromId === currentFile.id);
  const incoming = repository.dependencies.filter((edge) => edge.toId === currentFile.id);
  const unresolved = repository.unresolved?.filter((edge) => edge.fileId === currentFile.id) ?? [];
  const repositoryDiagnostics = [...new Map((repository.diagnostics ?? []).map((item) => [`${item.path ?? ""}\u0000${item.message}`, item])).values()];
  const sourceLines = useMemo(() => detailTab === "source" && sourceStatus === "loaded" ? cachedHighlightedLines(sourceText, currentFile.language ?? "") : [], [detailTab, sourceStatus, sourceText, currentFile.language]);

  return <aside className={`details-pane${mobileView !== "details" ? " mobile-hidden" : ""}`} aria-label="文件详情">
    <div className="detail-file-heading">{repository.source === "local" && !repository.origin && <button type="button" title={(typeof window !== "undefined" && window.repoLens) ? "在 VS Code 中打开" : "复制源码位置"} onClick={() => {
      const line = focusedLine?.fileId === currentFile.id ? focusedLine.line : 1;
      if (window.repoLens) void window.repoLens.openInEditor({ repositoryId: repository.id, revision: repository.revision ?? repository.version, persistenceSessionId: repository.persistenceSessionId, fileId: currentFile.id, contentHash: currentFile.contentHash ?? "", line }).catch((error: Error) => window.alert(error.message));
      else void Promise.resolve().then(() => navigator.clipboard.writeText(`${repository.name} / ${currentFile.path}:${line} · ${repository.revision ?? repository.version}`)).catch(() => window.alert("未能复制源码位置，请检查剪贴板权限后重试。"));
    }}>{(typeof window !== "undefined" && window.repoLens) ? "VS Code" : "复制位置"}</button>}<span className={`detail-file-icon${currentFile.kind === "style" ? " is-style" : ""}`}>{currentFile.kind === "style" ? <FileText size={18} /> : <FileCode2 size={18} />}</span><div className="detail-file-title"><span>{currentFile.path}</span><strong>{currentFile.name}</strong></div></div>
    <Tabs value={detailTab} onValueChange={onDetailTabChange} className="detail-tabs">
      <TabsList variant="line" aria-label="文件详情视图" className="detail-tab-list"><TabsTrigger value="guide"><BookOpenText size={14} />讲解</TabsTrigger><TabsTrigger value="source"><Code2 size={14} />源码</TabsTrigger>{repository.source === "local" && <button type="button" className="detail-tab-action" onClick={() => onOpenAi()} aria-label="打开聊天"><MessageSquare size={13} />打开聊天</button>}</TabsList>
      <TabsContent value="guide" className="detail-scroll guide-scroll">
        {repository.source === "sample" && <section className="ai-panel ai-sample-panel" aria-label="AI 讲解">
          <div className="ai-panel-heading"><h3>AI 辅助阅读</h3></div>
          <p className="ai-sample-description">当前是预置的示例讲解。打开自己的仓库后，可使用 AI 生成讲解和阅读路线。</p>
          <div className="ai-actions"><button type="button" disabled={!canOpenRepository} onClick={onOpenRepository}>打开自己的仓库</button></div>
        </section>}
        {repository.source === "local" && <section className="ai-panel" aria-label="AI 讲解">
          <div className="ai-panel-heading"><h3>AI 辅助阅读</h3><span className="ai-panel-actions"><button type="button" className="ai-settings-link" onClick={() => onOpenAi()}>打开 AI 侧栏</button><button type="button" className="ai-settings-link" onClick={onOpenModelSettings}>模型设置</button></span></div>
          <p className="ai-model-summary" role="status">{aiSettings.configured ? `已配置 · ${aiSettings.model}` : "尚未配置模型"}</p>
          {!backendAvailable && <p role="alert" className="ai-feedback">本地服务已停止。重新启动 RepoLens 后可继续使用本地功能。</p>}
          <div className="ai-actions"><button type="button" disabled={!backendAvailable} onClick={() => onPreviewAi("explanation")}>生成当前文件讲解</button><button type="button" disabled={!backendAvailable} onClick={() => onPreviewAi("route")}>生成阅读路线</button></div>
          {aiResult && aiResult.__repositoryId === repository.id && (aiResult.__mode === "route" || aiResult.__entryFileId === currentFile.id) && <AiResultView result={aiResult} files={filesById} stale={aiStale} onOpenReference={onOpenReference} />}
        </section>}
        <span className="section-overline">{repository.source === "sample" ? "示例导览" : "静态分析"} <span className="tiny-sparkle">✦</span></span>
        <h2 className="file-role-title">{currentFile.role ?? currentFile.name}</h2><p className="file-summary">{currentFile.summary ?? "此处根据源码中的导入关系展示静态分析结果。"}</p>
        {currentFile.symbolDetails?.length ? <div className="symbol-summary"><strong>符号大纲</strong><div>{currentFile.symbolDetails.map((symbol) => <button type="button" key={`${symbol.name}:${symbol.startLine}`} onClick={() => onOpenReference({ fileId: currentFile.id, line: symbol.startLine, endLine: symbol.endLine })} title={`第 ${symbol.startLine}–${symbol.endLine} 行`}><code>{symbol.name}</code><small>{symbol.kind} · 第 {symbol.startLine} 行</small></button>)}</div></div> : currentFile.symbols?.length ? <div className="symbol-summary"><strong>符号摘要</strong><div>{currentFile.symbols.map((symbol) => <code key={symbol}>{symbol}</code>)}</div></div> : null}
        {repository.source === "local" && <section className="repository-diagnostics" aria-label="仓库诊断">
          <details open={repositoryDiagnostics.length > 0}>
            <summary>仓库诊断 · {repositoryDiagnostics.length ? `${repositoryDiagnostics.length} 条` : "无诊断"}</summary>
            {repositoryDiagnostics.length > 0 ? <ul>{repositoryDiagnostics.map((item) => <li key={`${item.path ?? ""}:${item.message}`}>
              <code>{item.path || "仓库"}</code><span>{item.message}</span>
            </li>)}</ul> : <p>当前仓库没有诊断。</p>}
          </details>
        </section>}
        {repository.source === "local" && <ReadingArtifactsPanel repository={repository} currentFile={currentFile} filesById={filesById} focusedLine={focusedLine} notes={readingNotes} tours={savedTours} sessionVersion={sessionVersion} clearGeneration={savedDataClearGeneration} clearing={savedDataClearBusy} onSaveNotes={onSaveReadingNotes} onSaveTours={onSaveTours} onActivateTour={onActivateTour} onOpenReference={onOpenReference} onNoteCreated={onGuideNoteCreated} />}
        <div className="relation-section"><div className="section-heading"><span>直接导入</span><span className="relation-count">{outgoing.length}</span></div>
        {outgoing.length ? <div className="relation-list">{outgoing.map((edge) => { const target = filesById.get(edge.toId)!; const relation = edge.resolution === "package" ? "Go 包导入展开" : edge.typeOnly ? "类型引用" : edge.kind === "export" ? "再导出" : edge.kind === "dynamic" ? "动态导入" : edge.kind === "from-import" ? "Python 子模块导入" : "静态导入"; const basis = edge.resolutionBasis === "relative-path" ? "相对路径解析" : edge.resolutionBasis === "config-alias" ? "配置别名解析" : edge.resolutionBasis === "python-module" ? "Python 模块解析" : edge.resolutionBasis === "python-submodule" ? "Python 子模块解析" : edge.resolutionBasis === "go-package-expanded" ? "Go 包展开" : edge.resolutionBasis === "typescript-resolution" ? "TypeScript 模块解析" : "静态导入关系"; return <ReferenceButton key={edge.id} icon={<Waypoints size={14} />} title={target.name} caption={`第 ${edge.reference.line} 行 · ${relation} · ${basis}`} onClick={() => onOpenReference(edge.reference)} />; })}</div> : <p className="no-relations">这个文件没有导入其他仓库文件。</p>}
        </div>
        <div className="relation-section incoming-section"><div className="section-heading"><span>被哪些文件引用</span><span className="relation-count">{incoming.length}</span></div>
          {incoming.length ? <div className="relation-list">{incoming.map((edge) => { const source = filesById.get(edge.fromId)!; return <ReferenceButton key={edge.id} icon={<FileCode2 size={14} />} title={source.name} caption={`第 ${edge.reference.line} 行 · 引用了此文件`} onClick={() => onOpenReference(edge.reference)} />; })}</div> : <p className="no-relations">没有其他文件引用它。</p>}
        </div>
        {repository.source === "local" && <div className="relation-section"><div className="section-heading"><span>未解析与外部引用</span><span className="relation-count">{unresolved.length}</span></div>
          {unresolved.length ? <div className="diagnostic-list">{unresolved.map((item) => <button key={`${item.specifier}-${item.line}`} onClick={() => onOpenReference({ fileId: currentFile.id, line: item.line })}><strong>{item.kind === "standard-library" ? "标准库" : item.kind === "external-module" || item.external ? "外部依赖" : item.kind === "dynamic" ? "动态导入" : "未解析引用"}</strong><code>{item.specifier}</code><span>第 {item.line} 行</span></button>)}</div> : <p className="no-relations">没有待处理的引用。</p>}
        </div>}
        <button className="show-source-link" onClick={() => onOpenReference({ fileId: currentFile.id, line: 1 })}><Code2 size={14} />查看完整源码<ChevronRight size={14} /></button>
      </TabsContent>
      <TabsContent value="source" className="detail-scroll source-scroll" ref={codeViewportRef}>
        <div className="source-meta"><span>{(currentFile.language ?? (currentFile.kind === "style" ? "css" : "text")).toUpperCase()} 源文件</span><span>{sourceStatus === "loading" ? "读取中" : sourceStatus === "error" ? "读取失败" : `${sourceLines.length} 行`}</span></div>
        {sourceStatus === "loading" ? <div className="source-loading" role="status">正在从本地服务读取源码…</div> : sourceStatus === "error" ? <div className="source-loading" role="alert">{sourceError ?? "无法读取源码。"}</div> : sourceText.length === 0 ? <div className="source-loading">{repository.files.length ? "这是一个空源码文件。" : "仓库中没有可显示的源码文件。"}</div> : <SourceCodeView key={`${currentFile.id}:${currentFile.contentHash}`} onSelection={onChatSelection} lines={sourceLines} path={currentFile.path} sourceText={sourceText} focusedLine={focusedLine?.fileId === currentFile.id ? focusedLine : null} viewportRef={codeViewportRef} />}
        {focusedLine?.fileId === currentFile.id && <div className="source-focus-note"><span><span className="focus-note-dot" />源码定位 · 第 {focusedLine.line} 行</span><button onClick={onClearFocus} aria-label="清除源码定位"><X size={13} /></button></div>}
      </TabsContent>
    </Tabs>
    <div className="detail-bottom-note"><span className="detail-note-mark">i</span><span>{repository.source === "sample" ? "这是内置示例说明，不是 AI 生成内容。" : "静态引用根据本地源码解析；源码只会在确认后发送给模型。"}</span></div>
  </aside>;
}
