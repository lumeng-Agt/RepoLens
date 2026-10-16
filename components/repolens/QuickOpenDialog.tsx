"use client";

import { FileCode2, Search } from "lucide-react";
import type { FileRecord } from "@/data/model";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";

export function QuickOpenDialog({ open, files, onOpenChange, onSelectFile }: {
  open: boolean;
  files: FileRecord[];
  onOpenChange: (open: boolean) => void;
  onSelectFile: (file: FileRecord) => void;
}) {
  return <CommandDialog open={open} onOpenChange={onOpenChange} title="快速打开文件" description="按文件路径或符号搜索仓库中的代码文件。">
    <CommandInput placeholder="输入文件名、路径或符号…" aria-label="快速打开文件或符号" />
    <CommandList>
      <CommandEmpty>没有匹配的文件或符号。</CommandEmpty>
      <CommandGroup heading="仓库文件">
        {files.map((file) => <CommandItem key={file.id} value={`${file.path} ${(file.symbols ?? []).join(" ")}`} onSelect={() => { onSelectFile(file); onOpenChange(false); }}>
          <FileCode2 aria-hidden="true" /><span>{file.path}</span>{file.symbols?.length ? <small>{file.symbols.slice(0, 3).join(" · ")}</small> : null}
        </CommandItem>)}
      </CommandGroup>
    </CommandList>
    <div className="quick-open-hint"><Search size={13} />可搜索文件路径和已解析的符号摘要</div>
  </CommandDialog>;
}
