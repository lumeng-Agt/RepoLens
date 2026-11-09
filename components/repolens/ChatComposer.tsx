import type { FileRecord } from "@/data/model";
import type { ChatAttachment } from "./chat-intent";
import { useChatMentions, DirectoryAttachmentConfirmation } from "./ChatMentions";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, ArrowDown, Square, ChevronDown } from "lucide-react";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import type { AiMode } from "@/data/explanation-provider";

export function ChatComposer({ id, value, mode, target, generating, disabled, ready, model, configured, context, status, away, files = [], onAttach, onNew, onLatest, onChange, onMode, onSettings, onSend, onStop }: {
  files?: FileRecord[]; onAttach?: (attachments: ChatAttachment[]) => void; onNew?: () => void;
  id: string; value: string; mode: AiMode; target: string; generating: boolean; disabled: boolean; ready: boolean;
  model?: string; configured?: boolean; context: ReactNode; status?: string; away: boolean;
  onLatest: () => void; onChange: (text: string) => void; onMode: (mode: AiMode) => void; onSettings?: () => void; onSend: () => void; onStop: () => void;
}) {
  const [trigger, setTrigger] = useState<{ start: number; end: number; kind: string; query: string } | null>(null);
  const [choice, setChoice] = useState(0);
  const [directory, setDirectory] = useState<ChatAttachment[] | null>(null);
  const mentions = useChatMentions(files);
  const commands = [{ label: "/ask", mode: "question" }, { label: "/explain", mode: "explanation" }, { label: "/route", mode: "route" }, { label: "/investigate", mode: "investigation" }, { label: "/new", mode: "new" }];
  const options = trigger ? trigger.kind === "@" ? mentions(trigger.query) : commands.filter(item => item.label.startsWith(`/${trigger.query}`)) : [];
  const choose = (index: number) => {
    const item = options[index]; if (!item || !trigger || generating || disabled) return;
    const next = value.slice(0, trigger.start) + value.slice(trigger.end);
    onChange(next); setTrigger(null);
    if ("attachments" in item) { if (item.kind === "目录") setDirectory(item.attachments); else onAttach?.(item.attachments); }
    else if (item.mode === "new") onNew?.(); else onMode(item.mode as AiMode);
    requestAnimationFrame(() => input.current?.focus());
  };
  const detect = (text: string, caret: number) => {
    const match = text.slice(0, caret).match(/(?:^|\s)([@/])([^\s@]*)$/);
    setChoice(0); setTrigger(match && (match[1] !== "/" || commands.some(command => command.label.startsWith(`/${match[2]}`))) ? { start: caret - match[2].length - 1, end: caret, kind: match[1], query: match[2] } : null);
  };
  const input = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    let frame = 0;
    let measuredWidth = 0;
    const measure = () => {
      const width = element.getBoundingClientRect().width;
      // A retained workspace may mount while its panel still has zero width.
      if (width < 40) return;
      measuredWidth = width;
      element.style.height = "0px";
      element.style.height = `${Math.max(64, Math.min(156, element.scrollHeight))}px`;
    };
    measure();
    const observer = new ResizeObserver(() => {
      // Height changes are our own output; only width changes need remeasurement.
      if (Math.abs(element.getBoundingClientRect().width - measuredWidth) < 1) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(element);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [value, mode, generating]);
  return <div className="chat-composer-dock">
    {away && <button type="button" className="chat-jump-latest" onClick={onLatest}><ArrowDown size={13}/>回到最新消息</button>}
    {status && <p className="chat-preparation-status" role="status">{status}</p>}
    <form className="copilot-composer" aria-label="聊天输入" onSubmit={event => { event.preventDefault(); if (ready && !disabled) onSend(); }}>
      {context}
      {directory && <DirectoryAttachmentConfirmation attachments={directory} onConfirm={() => { onAttach?.(directory); setDirectory(null); }} onClose={() => setDirectory(null)}/>}
      {trigger && <div className="chat-mention-menu" role="listbox" aria-label={trigger.kind === "@" ? "添加上下文" : "快捷指令"}>{options.map((item, index) => <button type="button" role="option" disabled={generating || disabled} aria-selected={choice === index} key={item.label} onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}>{item.label}{"kind" in item && <small>{item.kind}</small>}</button>)}{!options.length && <p>没有匹配项</p>}</div>}
      {mode === "explanation" && !generating ? <div className="chat-explanation-target"><strong>讲解文件</strong><span title={target}>{target}</span><button type="button" onClick={() => onMode("question")}>改为提问</button></div> : <><label className="sr-only" htmlFor={id}>提问或追问</label><textarea ref={input} id={id} aria-label="提问或追问" value={value} maxLength={mode === "route" ? 300 : 12000} disabled={disabled} onChange={event => { onChange(event.target.value); detect(event.target.value, event.target.selectionStart); }} placeholder={generating ? "准备下一条问题…" : mode === "route" ? "想通过这条路线了解什么？" : mode === "investigation" ? "描述准备做的改动，例如给取消功能增加超时…" : "直接提问，或接着聊…"} onKeyDown={event => { if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return; if (trigger) { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setTrigger(null); return; } if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setChoice(index => Math.max(0, Math.min(options.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))); return; } if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && options.length) { event.preventDefault(); choose(choice); return; } } if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); if (ready && !disabled) onSend(); } }}/></>}
      <div className="copilot-composer-tools">
        <DropdownMenu><DropdownMenuTrigger asChild><button className="chat-task-button" type="button" aria-label="AI 任务" disabled={generating || disabled}>{mode === "explanation" ? "讲解文件" : mode === "route" ? "阅读路线" : mode === "investigation" ? "定位改动" : "提问"}<ChevronDown size={12}/></button></DropdownMenuTrigger><DropdownMenuContent align="start"><DropdownMenuItem onSelect={() => onMode("investigation")}>定位改动位置</DropdownMenuItem><DropdownMenuItem onSelect={() => onMode("question")}>提问</DropdownMenuItem><DropdownMenuItem onSelect={() => onMode("explanation")}>讲解当前文件</DropdownMenuItem><DropdownMenuItem onSelect={() => onMode("route")}>规划阅读路线</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
        <button type="button" className="chat-model-button" title="模型设置" onClick={onSettings}>{configured ? model : "设置模型"}<ChevronDown size={12}/></button><span className="chat-tools-spacer"/>
        {generating ? <button key="stop" type="button" className="chat-send" aria-label="停止" title="停止本次请求" onClick={event => { event.preventDefault(); onStop(); }}><Square size={14} fill="currentColor"/></button> : <button key="send" type="submit" className="chat-send" aria-label="发送" title={!configured ? "请先设置模型" : ready ? "发送" : "输入内容后发送"} disabled={disabled || !configured || !ready}><ArrowUp size={18}/></button>}
      </div>
    </form>
  </div>;
}
