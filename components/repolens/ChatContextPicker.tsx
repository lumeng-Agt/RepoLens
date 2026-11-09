import { useState } from "react";
import { Plus, X, FileCode2, ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { AiPreview, FileRecord } from "@/data/model";
import type { AiLineRange, AiScopeCandidate } from "@/data/explanation-provider";

export function ChatContextPicker({ open, onOpenChange, files, currentId, required, selected, manualIds, preview, candidates, ranges, busy, history, characters, endpoint, onSelect, onRange, onHistory, onApply, needsApply, selectionMode, onContextMode }: {
  open: boolean; onOpenChange: (open: boolean) => void; files: FileRecord[]; currentId: string; required: boolean;
  selected: string[]; manualIds: string[]; preview?: AiPreview; candidates: AiScopeCandidate[]; ranges: Record<string, AiLineRange>; busy: boolean;
  history: { id: string; role: string; content: string; selected: boolean }[]; characters?: number; endpoint?: string;
  onSelect: (ids: string[], manualId?: string) => void; onRange: (id: string, range: AiLineRange) => void;
  onHistory: (id: string, selected: boolean) => void; onApply: () => void; needsApply: boolean;
  selectionMode?: "auto" | "manual" | "none"; onContextMode?: (automatic: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const shown = selected.map(id => ({ id, name: files.find(file => file.id === id)?.name ?? id.split("/").pop() }));
  const matches = files.filter(file => !selected.includes(file.id) && file.path.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).slice(0, 100);
  const oversized = candidates.some(candidate => { const range = ranges[candidate.fileId] ?? candidate.suggestedRange ?? { startLine: 1, endLine: candidate.lineCount }; return selected.includes(candidate.fileId) && candidate.oversizedLines.some(line => line >= range.startLine && line <= range.endLine); });
  const source = (id: string) => id === currentId ? "当前文件" : manualIds.includes(id) ? "手动添加" : preview?.files.some(file => file.fileId === id) ? "自动选取" : "已选择";
  return <div className="chat-attachments">
    {selectionMode && <DropdownMenu><DropdownMenuTrigger asChild><button type="button" className="chat-context-mode" disabled={busy} aria-label={`源码上下文：${selectionMode === "auto" ? "自动参考仓库" : selectionMode === "none" ? "仅对话" : "使用所选文件"}`}>{selectionMode === "auto" ? "自动参考仓库" : selectionMode === "none" ? "仅对话" : "使用所选文件"}<ChevronDown size={11}/></button></DropdownMenuTrigger><DropdownMenuContent align="start"><DropdownMenuItem onSelect={() => onContextMode?.(true)}>自动参考仓库</DropdownMenuItem><DropdownMenuItem onSelect={() => onContextMode?.(false)}>仅对话，不附源码</DropdownMenuItem></DropdownMenuContent></DropdownMenu>}
    {selectionMode && preview?.files.length === 0 && <small className="chat-no-source" title={preview.contextNotice}>未附源码</small>}
    {shown.slice(0, selectionMode === "auto" ? 0 : 2).map(file => <span key={file.id} className="chat-attachment" title={`${file.id} · ${source(file.id)}`}><FileCode2 size={12}/><span>{file.name}</span>{required && file.id === currentId ? <small>必需</small> : <button type="button" aria-label={`移除附件 ${file.id}`} disabled={busy} onClick={() => onSelect(selected.filter(id => id !== file.id))}><X size={12}/></button>}</span>)}
    <Popover open={open} onOpenChange={onOpenChange}><PopoverTrigger asChild><button type="button" className="chat-add-context" aria-label="添加文件" title="查看上下文或补充文件"><Plus size={13}/>{selectionMode === "auto" && shown.length ? `参考 ${shown.length} 个文件` : shown.length > 2 ? `另 ${shown.length - 2} 个文件` : "添加文件"}<ChevronDown size={11}/></button></PopoverTrigger>
      <PopoverContent className="chat-context-popover" side="top" align="start"><strong>{needsApply ? "选择发送范围" : "可选上下文"}</strong>{needsApply && <div className="ai-scope-picker">{candidates.map(candidate => <label key={candidate.fileId}><input type="checkbox" checked={selected.includes(candidate.fileId)} disabled={busy || required && candidate.fileId === currentId} onChange={event => onSelect(event.target.checked ? [...selected, candidate.fileId] : selected.filter(id => id !== candidate.fileId))}/>{candidate.fileId}</label>)}</div>}{oversized && <p role="alert">所选范围包含超长单行，需调整起止行将其排除。</p>}{selectionMode && <p>{selectionMode === "auto" ? "相关代码会自动查找，无需先选文件。也可以手动补充。" : selectionMode === "none" ? "本次不附带源码，可以直接聊天。" : "本次使用所选文件；可以移除全部文件后直接聊天。"}</p>}{preview?.contextNotice && <p>{preview.contextNotice}</p>}<p>{endpoint || "尚未设置模型"}</p><p>{characters === undefined ? "输入后自动整理上下文" : `本次发送 ${characters.toLocaleString()} 字符`} · 已选历史 {history.filter(item => item.selected).length} 条</p>
        <div className="chat-context-files">{selected.map(id => {
          const sent = preview?.files.find(file => file.fileId === id); const candidate = candidates.find(file => file.fileId === id);
          const alternatives = sent?.alternativeRanges ?? candidate?.alternativeRanges ?? [];
          const range = ranges[id] ?? { startLine: sent?.startLine ?? 1, endLine: sent?.endLine ?? candidate?.lineCount ?? 1 };
          return <div key={id} className="chat-context-file">{!!alternatives.length && <select aria-label={`${id} 命中片段`} disabled={busy} value="" onChange={event => { const r = alternatives[Number(event.target.value)]; if (r) onRange(id, { startLine: r.startLine, endLine: r.endLine }); }}><option value="">其他命中片段</option>{alternatives.map((r, index) => <option key={index} value={index}>{r.name} · {r.startLine}–{r.endLine}</option>)}</select>}<div><span title={id}>{id}</span><small>{source(id)}{required && id === currentId ? " · 必需" : ""}</small>{!(required && id === currentId) && <button type="button" aria-label={`移除文件 ${id}`} disabled={busy} onClick={() => onSelect(selected.filter(item => item !== id))}><X size={13}/></button>}</div>
            {(sent || candidate) && <div className="ai-range-fields"><input type="number" min={1} aria-label={`${id} 起始行`} disabled={busy} value={range.startLine} onChange={event => onRange(id, { ...range, startLine: Number(event.target.value) })}/><span>至</span><input type="number" min={range.startLine} aria-label={`${id} 结束行`} disabled={busy} value={range.endLine} onChange={event => onRange(id, { ...range, endLine: Number(event.target.value) })}/></div>}
            {!!(sent?.reasons ?? candidate?.reasons)?.length && <p>{(sent?.reasons ?? candidate?.reasons)?.join("、")}</p>}
          </div>;
        })}</div>
        <label className="chat-file-search">添加文件<input aria-label="筛选聊天附件" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索文件…"/></label>
        <div className="chat-file-results">{matches.map(file => <button type="button" key={file.id} disabled={busy || selected.length >= 12} onClick={() => onSelect([...selected, file.id], file.id)}><FileCode2 size={13}/><span>{file.path}</span><Plus size={13}/></button>)}{!matches.length && <p>没有可添加的文件</p>}</div>
        {!!history.length && <details><summary>携带的历史消息</summary>{history.map(item => <label key={item.id}><input type="checkbox" disabled={busy} checked={item.selected} onChange={event => onHistory(item.id, event.target.checked)}/><span>{item.role === "user" ? "你" : "AI"} · {item.content.slice(0, 70)}</span></label>)}</details>}
        <small>最多 12 个文件、60,000 字符。点击发送会交给所选模型。</small>
        {needsApply && <button className="chat-context-apply" type="button" disabled={busy || oversized || (!selected.length && selectionMode !== "none") || selected.length > 12} onClick={onApply}>应用范围</button>}
      </PopoverContent>
    </Popover>
  </div>;
}
