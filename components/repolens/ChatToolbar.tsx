import { useState } from "react";
import { Plus, History, X, MoreHorizontal } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import type { QaConversation } from "./chat-types";

export function ChatToolbar({ conversations, activeId, generatingId, busy, onNew, onSelect, onDelete, onClose }: {
  conversations: QaConversation[]; activeId: string; generatingId?: string; busy: boolean;
  onNew: () => void; onSelect: (id: string) => void; onDelete: () => void; onClose?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const matches = conversations.filter(item => item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <header className="copilot-toolbar"><strong>聊天</strong><span className="chat-tools-spacer"/>
    <button type="button" aria-label="新对话" title="新对话" disabled={busy} onClick={onNew}><Plus size={17}/></button>
    <Popover open={open} onOpenChange={setOpen}><PopoverTrigger asChild><button type="button" aria-label="聊天历史" title="聊天历史"><History size={17}/></button></PopoverTrigger>
      <PopoverContent className="chat-history-menu" align="end"><strong>聊天历史</strong><input aria-label="搜索聊天历史" placeholder="搜索对话…" value={query} onChange={event => setQuery(event.target.value)}/>
        <div className="chat-history-list">{matches.length ? matches.map(item => <button type="button" key={item.id} className={item.id === activeId ? "is-current" : ""} aria-current={item.id === activeId ? "true" : undefined} disabled={busy} onClick={() => { onSelect(item.id); setOpen(false); }}><span>{item.title || "新对话"}</span><small>{generatingId === item.id ? "正在生成" : Number.isFinite(item.updatedAt) ? new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(item.updatedAt) : "时间未记录"}</small></button>) : <p>{query ? "没有匹配的对话" : "还没有对话"}</p>}</div>
        {activeId && <DropdownMenu><DropdownMenuTrigger asChild><button className="chat-history-actions" type="button" aria-label="会话菜单"><MoreHorizontal size={15}/>当前对话</button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem variant="destructive" disabled={busy} onSelect={() => { onDelete(); setOpen(false); }}>删除对话</DropdownMenuItem></DropdownMenuContent></DropdownMenu>}
      </PopoverContent></Popover>
    <button type="button" aria-label="收起 AI 面板" title="收起聊天，当前请求会继续" onClick={onClose}><X size={17}/></button>
  </header>;
}
