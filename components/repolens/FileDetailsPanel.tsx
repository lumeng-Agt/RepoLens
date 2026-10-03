import type { FormEvent, RefObject, ReactNode } from "react";
import Prism, { type Token, type TokenStream } from "prismjs";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-css";
import "prismjs/components/prism-python";
import "prismjs/components/prism-go";
import { BookOpenText, ChevronRight, Code2, FileCode2, FileText, Waypoints, X } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AiResultView, type AiResultRecord } from "@/components/repolens/AiResultView";
import { QuestionPanel } from "@/components/repolens/QuestionPanel";
import type { AiLineRange, AiMode, AiScopeCandidate } from "@/data/explanation-provider";
import type { AiPreview, FileRecord, RepositorySnapshot, SourceReference } from "@/data/model";

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

function ReferenceButton({ icon, title, caption, onClick }: { icon: ReactNode; title: string; caption: string; onClick: () => void }) {
  return <button className="reference-row" onClick={onClick}><span className="reference-icon">{icon}</span><span className="reference-copy"><strong>{title}</strong><small>{caption}</small></span><ChevronRight size={14} className="reference-arrow" /></button>;
}

export function FileDetailsPanel({ repository, currentFile, filesById, mobileView, detailTab, onDetailTabChange, onOpenReference,
  aiSettings, aiSettingsBusy, onBaseUrlChange, onModelChange, onApiKeyChange, onSaveSettings, onPreviewAi, aiBusy, aiPreview, aiCandidates,
  pendingAiMode, selectedAiFiles, selectedAiRanges, onToggleAiFile, onAiRangeChange, onGenerateAi, onCancelAi, aiMessage, aiSettingsReadError, aiSettingsSaveError, aiResult, aiStale,
  sourceText, sourceStatus, sourceError, focusedLine, onClearFocus, codeViewportRef,
}: {
  repository: RepositorySnapshot; currentFile: FileRecord; filesById: Map<string, FileRecord>; mobileView: "files" | "graph" | "details"; detailTab: string;
  onDetailTabChange: (tab: string) => void; onOpenReference: (reference: SourceReference) => void;
  aiSettings: { baseUrl: string; model: string; apiKey: string; configured: boolean };
  aiSettingsBusy: boolean;
  onBaseUrlChange: (value: string) => void; onModelChange: (value: string) => void; onApiKeyChange: (value: string) => void;
  onSaveSettings: (event: FormEvent<HTMLFormElement>) => void; onPreviewAi: (mode: AiMode, fileIds?: string[]) => void;
  aiPreview: AiPreview | null;
  aiBusy: boolean; aiCandidates: AiScopeCandidate[]; pendingAiMode: AiMode | null; selectedAiFiles: string[];
  selectedAiRanges: Record<string, AiLineRange>; onToggleAiFile: (fileId: string, checked: boolean) => void;
  onAiRangeChange: (fileId: string, range: AiLineRange) => void; onGenerateAi: () => void; onCancelAi: () => void;
  aiMessage: string; aiSettingsReadError: string | null; aiSettingsSaveError: string | null; aiResult: AiResultRecord | null; aiStale: boolean;
  sourceText: string; sourceStatus: "loading" | "loaded" | "error"; sourceError?: string;
  focusedLine: SourceReference | null; onClearFocus: () => void; codeViewportRef: RefObject<HTMLDivElement | null>;
}) {
  const outgoing = repository.dependencies.filter((edge) => edge.fromId === currentFile.id);
  const incoming = repository.dependencies.filter((edge) => edge.toId === currentFile.id);
  const unresolved = repository.unresolved?.filter((edge) => edge.fileId === currentFile.id) ?? [];
  const repositoryDiagnostics = [...new Map((repository.diagnostics ?? []).map((item) => [`${item.path ?? ""}\u0000${item.message}`, item])).values()];
  const sourceLines = highlightedLines(sourceText, currentFile.language ?? "");

  return <aside className={`details-pane${mobileView !== "details" ? " mobile-hidden" : ""}`} aria-label="文件详情">
    <div className="detail-file-heading"><span className={`detail-file-icon${currentFile.kind === "style" ? " is-style" : ""}`}>{currentFile.kind === "style" ? <FileText size={18} /> : <FileCode2 size={18} />}</span><div className="detail-file-title"><span>{currentFile.path}</span><strong>{currentFile.name}</strong></div></div>
    <Tabs value={detailTab} onValueChange={onDetailTabChange} className="detail-tabs">
      <TabsList variant="line" aria-label="文件详情视图" className="detail-tab-list"><TabsTrigger value="guide"><BookOpenText size={14} />讲解</TabsTrigger><TabsTrigger value="source"><Code2 size={14} />源码</TabsTrigger>{repository.source === "local" && <TabsTrigger value="questions">问答</TabsTrigger>}</TabsList>
      <TabsContent value="guide" className="detail-scroll guide-scroll">
        <span className="section-overline">{repository.source === "sample" ? "预置导览" : "静态分析"} <span className="tiny-sparkle">✦</span></span>
        <h2 className="file-role-title">{currentFile.role ?? currentFile.name}</h2><p className="file-summary">{currentFile.summary ?? "当前展示由源码导入关系生成的静态分析。"}</p>
        {currentFile.symbols?.length ? <div className="symbol-summary"><strong>文件符号摘要</strong><div>{currentFile.symbols.map((symbol) => <code key={symbol}>{symbol}</code>)}</div></div> : null}
        {repository.source === "local" && <section className="repository-diagnostics" aria-label="仓库诊断">
          <details open={repositoryDiagnostics.length > 0}>
            <summary>仓库诊断 · {repositoryDiagnostics.length ? `${repositoryDiagnostics.length} 条` : "无诊断"}</summary>
            {repositoryDiagnostics.length > 0 ? <ul>{repositoryDiagnostics.map((item) => <li key={`${item.path ?? ""}:${item.message}`}>
              <code>{item.path || "仓库"}</code><span>{item.message}</span>
            </li>)}</ul> : <p>当前快照没有仓库级诊断。</p>}
          </details>
        </section>}
        {repository.source === "local" && <section className="ai-panel">
          <h3>AI 讲解（按需生成）</h3>
          <form onSubmit={onSaveSettings} className="ai-settings-form">
            <input aria-label="兼容服务地址" placeholder="https://api.example.com/v1" value={aiSettings.baseUrl} onChange={(event) => onBaseUrlChange(event.target.value)} />
            <input aria-label="模型名称" placeholder="模型名称" value={aiSettings.model} onChange={(event) => onModelChange(event.target.value)} />
            <input aria-label="API 密钥" type="password" autoComplete="off" placeholder={aiSettings.configured ? "密钥已在本地服务中配置" : "API 密钥（仅存于本地服务内存）"} value={aiSettings.apiKey} onChange={(event) => onApiKeyChange(event.target.value)} />
            <button type="submit" disabled={aiSettingsBusy}>{aiSettingsBusy ? "正在保存…" : "保存本地配置"}</button>
          </form>
          <div className="ai-actions"><button type="button" onClick={() => onPreviewAi("explanation")} disabled={aiBusy || !repository.files.length}>生成当前文件讲解</button><button type="button" onClick={() => onPreviewAi("route")} disabled={aiBusy || !repository.files.length}>生成阅读路线</button></div>
          {aiCandidates.length > 0 && pendingAiMode && <div className="ai-scope-picker">
            <strong>选择发送范围</strong><p>必须保留当前文件；最多 12 个文件、60,000 字符。可用行范围缩小单个文件。</p>
            {aiCandidates.map((candidate) => {
              const selected = selectedAiFiles.includes(candidate.fileId);
              const range = selectedAiRanges[candidate.fileId] ?? { startLine: 1, endLine: candidate.lineCount };
              const selectedOversizedLines = candidate.oversizedLines.filter((line) => selected && Number.isInteger(range.startLine) && Number.isInteger(range.endLine) && line >= range.startLine && line <= range.endLine);
              return <label key={candidate.fileId}>
                <input type="checkbox" checked={selected} disabled={candidate.fileId === currentFile.id} onChange={(event) => onToggleAiFile(candidate.fileId, event.target.checked)} />
                <span>{candidate.fileId}</span>
                <small>{candidate.lineCount} 行{candidate.oversizedLines.length ? ` · 超长行：${candidate.oversizedLines.join("、")}` : ""}</small>
                {selected && <span className="ai-range-fields">
                  <input aria-label={`${candidate.fileId} 起始行`} type="number" min={1} max={candidate.lineCount} value={range.startLine} onChange={(event) => onAiRangeChange(candidate.fileId, { ...range, startLine: Number(event.target.value) })} />
                  <span>至</span>
                  <input aria-label={`${candidate.fileId} 结束行`} type="number" min={range.startLine} max={candidate.lineCount} value={range.endLine} onChange={(event) => onAiRangeChange(candidate.fileId, { ...range, endLine: Number(event.target.value) })} />
                </span>}
                {selectedOversizedLines.length > 0 && <small role="alert">所选范围包含超长单行，需调整起止行将其排除。</small>}
              </label>;
            })}
            <button type="button" onClick={() => onPreviewAi(pendingAiMode, selectedAiFiles)} disabled={aiBusy || selectedAiFiles.length === 0 || aiCandidates.some((candidate) => {
              if (!selectedAiFiles.includes(candidate.fileId)) return false;
              const range = selectedAiRanges[candidate.fileId] ?? { startLine: 1, endLine: candidate.lineCount };
              return candidate.oversizedLines.some((line) => line >= range.startLine && line <= range.endLine);
            })}>预览所选范围</button>
          </div>}
          {aiPreview && <div className="ai-consent"><strong>发送前确认</strong><p>目标服务：{aiPreview.baseUrl} · 模型：{aiPreview.model}。将把 {aiPreview.files.length} 个文件、共 {aiPreview.characters.toLocaleString()} 个字符发送至该服务：</p><ul>{aiPreview.files.map((file) => <li key={file.fileId}>{file.fileId}（第 {file.startLine}–{file.endLine} 行）</li>)}</ul>{!aiSettings.configured ? <p>请先保存完整的本地模型配置并重新预览。</p> : <button onClick={onGenerateAi} disabled={aiBusy}>{aiBusy ? "正在请求…" : "确认发送并生成"}</button>}<button className="ai-cancel" onClick={onCancelAi}>{aiBusy ? "取消请求" : "取消"}</button></div>}
          {aiSettingsReadError && <p className="ai-feedback ai-settings-read-error" role="alert"><strong>读取本地模型配置失败：</strong>{aiSettingsReadError}</p>}
          {aiSettingsSaveError && <p className="ai-feedback ai-settings-save-error" role="alert"><strong>保存本地模型配置失败：</strong>{aiSettingsSaveError}</p>}
          {aiMessage && <p className="ai-feedback" role="status">{aiMessage}</p>}
          {aiResult && aiResult.__repositoryId === repository.id && (aiResult.__mode === "route" || aiResult.__entryFileId === currentFile.id) && <AiResultView result={aiResult} files={filesById} stale={aiStale} onOpenReference={onOpenReference} />}
        </section>}
        <div className="relation-section"><div className="section-heading"><span>直接导入</span><span className="relation-count">{outgoing.length}</span></div>
        {outgoing.length ? <div className="relation-list">{outgoing.map((edge) => { const target = filesById.get(edge.toId)!; const relation = edge.resolution === "package" ? "Go 包导入展开" : edge.typeOnly ? "类型引用" : edge.kind === "export" ? "再导出" : edge.kind === "dynamic" ? "动态导入" : edge.kind === "from-import" ? "Python 导入" : "静态导入"; return <ReferenceButton key={edge.id} icon={<Waypoints size={14} />} title={target.name} caption={`第 ${edge.reference.line} 行 · ${relation}`} onClick={() => onOpenReference(edge.reference)} />; })}</div> : <p className="no-relations">这个文件没有导入其他仓库文件。</p>}
        </div>
        <div className="relation-section incoming-section"><div className="section-heading"><span>被哪些文件引用</span><span className="relation-count">{incoming.length}</span></div>
          {incoming.length ? <div className="relation-list">{incoming.map((edge) => { const source = filesById.get(edge.fromId)!; return <ReferenceButton key={edge.id} icon={<FileCode2 size={14} />} title={source.name} caption={`第 ${edge.reference.line} 行 · 引用了此文件`} onClick={() => onOpenReference(edge.reference)} />; })}</div> : <p className="no-relations">没有其他文件导入它。</p>}
        </div>
        {repository.source === "local" && <div className="relation-section"><div className="section-heading"><span>未解析与外部引用</span><span className="relation-count">{unresolved.length}</span></div>
          {unresolved.length ? <div className="diagnostic-list">{unresolved.map((item) => <button key={`${item.specifier}-${item.line}`} onClick={() => onOpenReference({ fileId: currentFile.id, line: item.line })}><strong>{item.kind === "standard-library" ? "标准库" : item.kind === "external-module" || item.external ? "外部依赖" : item.kind === "dynamic" ? "动态导入" : "未解析引用"}</strong><code>{item.specifier}</code><span>第 {item.line} 行</span></button>)}</div> : <p className="no-relations">没有待处理的引用。</p>}
        </div>}
        <button className="show-source-link" onClick={() => onOpenReference({ fileId: currentFile.id, line: 1 })}><Code2 size={14} />查看完整源码<ChevronRight size={14} /></button>
      </TabsContent>
      {repository.source === "local" && <TabsContent value="questions" className="detail-scroll question-scroll"><QuestionPanel repository={repository} currentFile={currentFile} filesById={filesById} onOpenReference={onOpenReference} /></TabsContent>}
      <TabsContent value="source" className="detail-scroll source-scroll" ref={codeViewportRef}>
        <div className="source-meta"><span>{(currentFile.language ?? (currentFile.kind === "style" ? "css" : "text")).toUpperCase()} 源文件</span><span>{sourceStatus === "loading" ? "读取中" : sourceStatus === "error" ? "读取失败" : `${sourceLines.length} 行`}</span></div>
        {sourceStatus === "loading" ? <div className="source-loading" role="status">正在从本地服务读取源码…</div> : sourceStatus === "error" ? <div className="source-loading" role="alert">{sourceError ?? "无法读取源码。"}</div> : sourceText.length === 0 ? <div className="source-loading">{repository.files.length ? "这是一个空源码文件。" : "仓库中没有可显示的源码文件。"}</div> : <pre className="source-code" aria-label={`${currentFile.path} 源码`}><code>{sourceLines.map(({ number, segments }) => {
          const isFocused = focusedLine?.fileId === currentFile.id && number >= focusedLine.line && number <= (focusedLine.endLine ?? focusedLine.line);
          return <span key={number} id={`source-line-${number}`} className={`source-line${isFocused ? " is-focused" : ""}`}><span className="line-number">{String(number).padStart(2, "0")}</span><span className="line-content">{segments.map((segment, index) => <span key={`${number}-${index}`} className={segment.tokens.length ? `token ${segment.tokens.join(" ")}` : undefined}>{segment.text}</span>)}</span></span>;
        })}</code></pre>}
        {focusedLine?.fileId === currentFile.id && <div className="source-focus-note"><span><span className="focus-note-dot" />导览定位 · 第 {focusedLine.line} 行</span><button onClick={onClearFocus} aria-label="清除源码定位"><X size={13} /></button></div>}
      </TabsContent>
    </Tabs>
    <div className="detail-bottom-note"><span className="detail-note-mark">i</span><span>{repository.source === "sample" ? "这是内置示例的预置说明，不是 AI 生成内容。" : "静态引用来自本地源码；AI 请求只会在确认后发送。"}</span></div>
  </aside>;
}
