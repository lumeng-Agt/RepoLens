import { useLayoutEffect, useRef, type ReactNode } from "react";
import { ArrowUp, ArrowDown, Square, ChevronDown } from "lucide-react";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import type { AiMode } from "@/data/explanation-provider";

export function ChatComposer({ id, value, mode, target, generating, disabled, ready, model, configured, context, status, away, onLatest, onChange, onMode, onSettings, onSend, onStop }: {
  id: string; value: string; mode: AiMode; target: string; generating: boolean; disabled: boolean; ready: boolean;
  model?: string; configured?: boolean; context: ReactNode; status?: string; away: boolean;
  onLatest: () => void; onChange: (text: string) => void; onMode: (mode: AiMode) => void; onSettings?: () => void; onSend: () => void; onStop: () => void;
}) {
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
      {mode === "explanation" && !generating ? <div className="chat-explanation-target"><strong>讲解文件</strong><span title={target}>{target}</span><button type="button" onClick={() => onMode("question")}>改为提问</button></div> : <><label className="sr-only" htmlFor={id}>提问或追问</label><textarea ref={input} id={id} aria-label="提问或追问" value={value} maxLength={mode === "route" ? 300 : 12000} disabled={disabled} onChange={event => onChange(event.target.value)} placeholder={generating ? "准备下一条问题…" : mode === "route" ? "想通过这条路线了解什么？" : mode === "investigation" ? "描述准备做的改动，例如给取消功能增加超时…" : "询问代码，或继续追问…"} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); if (ready && !disabled) onSend(); } }}/></>}
      <div className="copilot-composer-tools">
        <DropdownMenu><DropdownMenuTrigger asChild><button className="chat-task-button" type="button" aria-label="AI 任务" disabled={generating || disabled}>{mode === "explanation" ? "讲解文件" : mode === "route" ? "阅读路线" : mode === "investigation" ? "定位改动" : "提问"}<ChevronDown size={12}/></button></DropdownMenuTrigger><DropdownMenuContent align="start"><DropdownMenuItem onSelect={() => onMode("investigation")}>定位改动位置</DropdownMenuItem><DropdownMenuItem onSelect={() => onMode("question")}>提问</DropdownMenuItem><DropdownMenuItem onSelect={() => onMode("explanation")}>讲解当前文件</DropdownMenuItem><DropdownMenuItem onSelect={() => onMode("route")}>规划阅读路线</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
        <button type="button" className="chat-model-button" title="模型设置" onClick={onSettings}>{configured ? model : "设置模型"}<ChevronDown size={12}/></button><span className="chat-tools-spacer"/>
        {generating ? <button type="button" className="chat-send" aria-label="停止" title="停止生成" onClick={onStop}><Square size={14} fill="currentColor"/></button> : <button type="submit" className="chat-send" aria-label="发送" title={!configured ? "请先设置模型" : ready ? "发送" : "上下文准备好后即可发送"} disabled={disabled || !configured || !ready}><ArrowUp size={18}/></button>}
      </div>
    </form>
  </div>;
}
