import { useMemo, type FormEvent, type RefObject } from "react";
import { ChevronDown, FileCode2, FileText, Folder, FolderOpen, Search, SearchX, Trash2, X } from "lucide-react";
import type { FileRecord, RepositorySnapshot } from "@/data/model";

type FolderEntry = { type: "folder"; name: string; path: string; children: TreeEntry[] };
type FileEntry = { type: "file"; file: FileRecord };
type TreeEntry = FolderEntry | FileEntry;

function makeTree(files: FileRecord[], name: string): FolderEntry {
  const root: FolderEntry = { type: "folder", name, path: name, children: [] };
  for (const file of files) {
    const parts = file.path.split("/"); let folder = root;
    for (const part of parts.slice(0, -1)) {
      const path = `${folder.path}/${part}`;
      let child = folder.children.find((entry): entry is FolderEntry => entry.type === "folder" && entry.path === path);
      if (!child) { child = { type: "folder", name: part, path, children: [] }; folder.children.push(child); }
      folder = child;
    }
    folder.children.push({ type: "file", file });
  }
  const sortEntries = (folder: FolderEntry) => {
    folder.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      const aName = a.type === "folder" ? a.name : a.file.name; const bName = b.type === "folder" ? b.name : b.file.name;
      return aName.localeCompare(bName);
    });
    folder.children.forEach((entry) => { if (entry.type === "folder") sortEntries(entry); });
  };
  sortEntries(root); return root;
}

function hasVisibleFile(folder: FolderEntry, matches: Set<string>): boolean {
  return folder.children.some((entry) => entry.type === "file" ? matches.has(entry.file.id) : hasVisibleFile(entry, matches));
}
function countVisibleFiles(folder: FolderEntry, matches: Set<string>): number {
  return folder.children.reduce((count, entry) => entry.type === "file" ? count + Number(matches.has(entry.file.id)) : count + countVisibleFiles(entry, matches), 0);
}

function TreeRows({ folder, depth, matchingIds, selectedId, collapsed, query, onToggleFolder, onSelect }: {
  folder: FolderEntry; depth: number; matchingIds: Set<string>; selectedId: string; collapsed: string[]; query: string;
  onToggleFolder: (path: string) => void; onSelect: (file: FileRecord) => void;
}) {
  return <>{folder.children.map((entry) => {
    if (entry.type === "folder") {
      const visible = entry.children.some((child) => child.type === "folder" ? hasVisibleFile(child, matchingIds) : matchingIds.has(child.file.id));
      if (!visible) return null;
      const isCollapsed = !query && collapsed.includes(entry.path);
      const shownName = entry.path === "taskflow/src" ? "src" : entry.name;
      return <div key={entry.path} className="tree-folder-group">
        <button className="tree-row folder-row" style={{ "--tree-depth": depth } as React.CSSProperties} onClick={() => onToggleFolder(entry.path)} aria-expanded={!isCollapsed}>
          <ChevronDown size={13} className={isCollapsed ? "tree-chevron is-collapsed" : "tree-chevron"} /><Folder size={14} className="folder-icon" /><span>{shownName}</span><span className="tree-folder-count">{countVisibleFiles(entry, matchingIds)}</span>
        </button>
        {!isCollapsed && <TreeRows folder={entry} depth={depth + 1} matchingIds={matchingIds} selectedId={selectedId} collapsed={collapsed} query={query} onToggleFolder={onToggleFolder} onSelect={onSelect} />}
      </div>;
    }
    if (!matchingIds.has(entry.file.id)) return null;
    const active = selectedId === entry.file.id; const Icon = entry.file.kind === "style" ? FileText : FileCode2;
    return <button id={`tree-file-${entry.file.id}`} key={entry.file.id} role="treeitem" aria-selected={active} className={`tree-row file-row${active ? " is-active" : ""}`} style={{ "--tree-depth": depth } as React.CSSProperties} onClick={() => onSelect(entry.file)}>
      <span className="tree-indent" /><Icon size={14} className={entry.file.kind === "style" ? "file-icon is-style" : "file-icon"} /><span className="tree-file-name">{entry.file.name}</span>{active && <span className="tree-active-dot" />}
    </button>;
  })}</>;
}

export function DirectoryPanel({ repository, mobileView, searchQuery, onSearchChange, repoPath, onRepoPathChange, repoBusy, repoMessage, desktopMode, onPickDirectory, onOpenRepository, onRescan, recentRepositories = [], onOpenRecent, onRemoveRecent, onClearRepositoryData, onClearSavedData, selectedFileId, collapsedFolders, onToggleFolder, onSelectFile, searchInputRef }: {
  repository: RepositorySnapshot; mobileView: "files" | "graph" | "details"; searchQuery: string; onSearchChange: (value: string) => void;
  repoPath: string; onRepoPathChange: (value: string) => void; repoBusy: boolean; repoMessage: string;
  desktopMode: boolean; onPickDirectory: () => void;
  onOpenRepository: (event: FormEvent<HTMLFormElement>) => void; onRescan: () => void;
  recentRepositories?: { id: string; name: string; location: string; kind: "local" | "github"; lastOpenedAt: number }[];
  onOpenRecent?: (location: string) => void; onRemoveRecent?: (id: string) => void; onClearRepositoryData?: () => void; onClearSavedData?: () => void;
  selectedFileId: string; collapsedFolders: string[]; onToggleFolder: (path: string) => void; onSelectFile: (file: FileRecord) => void;
  searchInputRef: RefObject<HTMLInputElement | null>;
}) {
  const query = searchQuery.trim().toLowerCase();
  const rootFolder = useMemo(() => makeTree(repository.files, repository.name), [repository.files, repository.name]);
  const matchingIds = useMemo(() => new Set(repository.files.filter((file) => !query || file.name.toLowerCase().includes(query) || file.path.toLowerCase().includes(query)).map((file) => file.id)), [repository.files, query]);
  return <aside className={`files-pane${mobileView !== "files" ? " mobile-hidden" : ""}`} aria-label="文件目录">
    <div className="pane-heading"><div><span className="pane-overline">WORKSPACE</span><h1>文件目录</h1></div><span className="file-count">{repository.files.length}</span></div>
    <form className="repository-open-form" onSubmit={onOpenRepository}>
      <label htmlFor="repository-path">本地仓库路径或 GitHub 链接</label>
      <input id="repository-path" value={repoPath} onChange={(event) => onRepoPathChange(event.target.value)} placeholder="D:\\coding\\project 或 https://github.com/owner/repo" />
      {desktopMode && <button type="button" onClick={onPickDirectory} disabled={repoBusy}><FolderOpen size={15} />选择本地目录</button>}
      <button type="submit" disabled={repoBusy || !repoPath.trim()}>{repoBusy ? "正在获取并扫描…" : "打开仓库"}</button>
      {repository.source === "local" && <button type="button" onClick={onRescan} disabled={repoBusy}>{repository.origin?.kind === "github" ? "检查远端更新" : "重新扫描"}</button>}
    </form>
    {repository.origin?.kind === "github" && <div className="github-origin" aria-label="GitHub 来源信息">
      <a href={repository.origin.url} target="_blank" rel="noreferrer">{repository.origin.url}</a>
      <span>ref · {repository.origin.resolvedRef}</span>
      <span>commit · {repository.origin.commit.slice(0, 12)}</span>
    </div>}
    {repoMessage && <div className="repo-message" role="status">{repoMessage}</div>}
    {desktopMode && <section className="recent-repositories" aria-label="最近打开的仓库及本地保存">
      <div className="recent-repositories-heading"><strong>最近仓库</strong><span>{recentRepositories.length}/20</span></div>
      {recentRepositories.length > 0 && <ul>{recentRepositories.map((recent) => <li key={recent.id}>
        <button className="recent-repository-open" type="button" disabled={repoBusy} onClick={() => onOpenRecent?.(recent.location)} title={recent.location}>
          <span>{recent.name}</span><small>{recent.kind === "github" ? "GitHub" : recent.location}</small>
        </button>
        <button type="button" className="recent-repository-remove" aria-label={`从最近仓库移除 ${recent.name}`} onClick={() => onRemoveRecent?.(recent.id)}><Trash2 size={13} /></button>
      </li>)}</ul>}
      {repository.source === "local" && <button className="clear-saved-data" type="button" onClick={onClearRepositoryData}>清除此仓库的保存数据</button>}
      <button className="clear-saved-data" type="button" onClick={onClearSavedData}>清除全部本地保存数据</button>
    </section>}
    <label className="search-field"><Search size={15} aria-hidden="true" /><input ref={searchInputRef} value={searchQuery} onChange={(event) => onSearchChange(event.target.value)} placeholder="搜索文件…" aria-label="搜索文件名或路径" />
      {searchQuery && <button type="button" aria-label="清除搜索" onClick={() => onSearchChange("")}><X size={14} /></button>}{!searchQuery && <kbd>/</kbd>}
    </label>
    <div className="tree-scroll"><div className="tree-root-label"><Folder size={15} /><span>{repository.name}</span><span className="tree-root-dot" /></div>
      <div className="tree-list" role="tree" aria-label={`${repository.name} 仓库文件`}>
        {!matchingIds.size ? <div className="empty-search"><SearchX size={24} /><strong>没有找到文件</strong><span>试试其他文件名或路径</span></div> : <TreeRows folder={rootFolder} depth={0} matchingIds={matchingIds} selectedId={selectedFileId} collapsed={collapsedFolders} query={query} onToggleFolder={onToggleFolder} onSelect={onSelectFile} />}
      </div>
    </div>
    <div className="sidebar-footnote"><span className="footnote-glyph">i</span><span>{repository.origin?.kind === "github" ? <>远端快照 · 点击“检查远端更新”获取最新提交</> : repository.source === "local" ? <>本地静态分析 · 保存时自动更新</> : <>目录内容来自内置示例<br />尚未读取本地仓库</>}</span></div>
  </aside>;
}
