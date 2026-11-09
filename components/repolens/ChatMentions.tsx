import { useMemo, useState } from "react";
import type { FileRecord } from "@/data/model";
import type { ChatAttachment } from "./chat-intent";

export function useChatMentions(files: FileRecord[]) {
  return useMemo(() => {
    const folders = new Set<string>();
    for (const file of files) { const parts = file.path.split("/"); parts.pop(); while (parts.length) { folders.add(parts.join("/")); parts.pop(); } }
    return (query: string) => {
      const needle = query.toLocaleLowerCase();
      const found: { label: string; kind: string; attachments: ChatAttachment[] }[] = [];
      for (const path of [...folders].sort()) { if (found.length >= 30) break; if (needle && path.toLocaleLowerCase().includes(needle)) found.push({ label: path, kind: "目录", attachments: files.filter(file => file.path.startsWith(`${path}/`)).map(file => ({ fileId: file.id, contentHash: file.contentHash ?? "" })) }); }
      for (const file of files) {
        if (file.path.toLocaleLowerCase().includes(needle)) found.push({ label: file.path, kind: "文件", attachments: [{ fileId: file.id, contentHash: file.contentHash ?? "" }] });
        for (const symbol of file.symbolDetails ?? []) {
          if (found.length >= 30) break;
          if (needle && symbol.name.toLocaleLowerCase().includes(needle)) found.push({ label: `${symbol.name} · ${file.path}:${symbol.startLine}`, kind: "符号", attachments: [{ fileId: file.id, contentHash: file.contentHash ?? "", startLine: symbol.startLine, endLine: symbol.endLine }] });
        }
        if (found.length >= 30) break;
      }
      return found;
    };
  }, [files]);
}

export function DirectoryAttachmentConfirmation({ attachments, onConfirm, onClose }: { attachments: ChatAttachment[]; onConfirm: () => void; onClose: () => void }) {
  const [shown] = useState(attachments);
  return <div className="chat-directory-confirm" role="group" aria-label="确认目录文件"><strong>加入 {shown.length} 个文件</strong><ul>{shown.map(file => <li key={file.fileId}>{file.fileId}</li>)}</ul>{shown.length > 12 && <p role="alert">目录超过 12 个文件，请改为逐个添加需要的文件。</p>}<button type="button" disabled={shown.length > 12} onClick={onConfirm}>加入上下文</button><button type="button" onClick={onClose}>取消</button></div>;
}
