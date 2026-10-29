import { useState } from "react";
import { Plus, X, FileCode2, ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { AiPreview, FileRecord } from "@/data/model";
import type { AiLineRange, AiScopeCandidate } from "@/data/explanation-provider";

export function ChatContextPicker({ open, onOpenChange, files, currentId, required, selected, manualIds, preview, candidates, ranges, busy, history, characters, endpoint, onSelect, onRange, onHistory, onApply, needsApply }: {
  open: boolean; onOpenChange: (open: boolean) => void; files: FileRecord[]; currentId: string; required: boolean;
  selected: string[]; manualIds: string[]; preview?: AiPreview; candidates: AiScopeCandidate[]; ranges: Record<string, AiLineRange>; busy: boolean;
  history: { id: string; role: string; content: string; selected: boolean }[]; characters?: number; endpoint?: string;
  onSelect: (ids: string[], manualId?: string) => void; onRange: (id: string, range: AiLineRange) => void;
  onHistory: (id: string, selected: boolean) => void; onApply: () => void; needsApply: boolean;
}) {
  const [query, setQuery] = useState("");
  const shown = selected.map(id => ({ id, name: files.find(file => file.id === id)?.name ?? id.split("/").pop() }));
  const matches = files.filter(file => !selected.includes(file.id) && file.path.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).slice(0, 100);
  const source = (id: string) => id === currentId ? "当前文件" : manualIds.includes(id) ? "手动添加" : preview?.files.some(file => file.fileId === id) ? "自动选取" : "已选择";
  return <div className="chat-attachments">
    {shown.slice(0, 2).map(file => <span key={file.id} className="chat-attachment" title={`${file.id} · ${source(file.id)}`}><FileCode2 size={12}/><span>{file.name}</span>{required && file.id === currentId ? <small>必需</small> : <button type="button" aria-label={`移除附件 ${file.id}`} disabled={busy} onClick={() => onSelect(selected.filter(id => id !== file.id))}><X size={12}/></button>}</span>)}
    <Popover open={open} onOpenChange={onOpenChange}><PopoverTrigger asChild><button type="button" className="chat-add-context" aria-label="添加文件" title="添加文件和调整上下文"><Plus size={13}/>{shown.length > 2 ? `另 ${shown.length - 2} 个文件` : "添加文件"}<ChevronDown size={11}/></button></PopoverTrigger>
      <PopoverContent className="chat-context-popover" side="top" align="start"><strong>发送上下文</strong><p>{endpoint || "尚未设置模型"}</p><p>{characters === undefined ? "发送范围尚未准备好" : `本次发送 ${characters.toLocaleString()} 字符`} · 已选历史 {history.filter(item => item.selected).length} 条</p>
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
        {needsApply && <button className="chat-context-apply" type="button" disabled={busy || !selected.length || selected.length > 12} onClick={onApply}>应用范围</button>}
      </PopoverContent>
    </Popover>
  </div>;
}
