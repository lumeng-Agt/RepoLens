import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ChevronDown, FileCode2, FileText, Folder, Search, SearchX, X } from "lucide-react";
import type { FileRecord, RepositorySnapshot, SearchRequest, SearchResponse } from "@/data/model";
import { localRepositoryProvider } from "@/data/providers";

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

export function DirectoryPanel({ repository, mobileView, searchQuery, onSearchChange, selectedFileId, collapsedFolders, onToggleFolder, onSelectFile, onOpenSearchResult, onAddSearchResult, searchInputRef }: {
  repository: RepositorySnapshot; mobileView: "files" | "graph" | "details"; searchQuery: string; onSearchChange: (value: string) => void;
  selectedFileId: string; collapsedFolders: string[]; onToggleFolder: (path: string) => void; onSelectFile: (file: FileRecord) => void;
  onOpenSearchResult: (fileId: string, line: number) => void; onAddSearchResult: (fileIds: string[]) => void;
  searchInputRef: RefObject<HTMLInputElement | null>;
}) {
  const [searchMode, setSearchMode] = useState<"files" | "content">("files");
  const [searchOptions, setSearchOptions] = useState({ matchCase: false, wholeWord: false, regex: false, excludeTests: false, pathPrefix: "", language: "" });
  const [searchPage, setSearchPage] = useState<SearchResponse | null>(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [selectedSearchFiles, setSelectedSearchFiles] = useState<string[]>([]);
  const searchSequence = useRef(0);
  const searchController = useRef<AbortController | null>(null);
  const invalidateSearch = () => {
    searchSequence.current += 1;
    searchController.current?.abort();
    searchController.current = null;
    setSearchPage(null); setSearchError(""); setSelectedSearchFiles([]);
  };
  const query = searchQuery.trim().toLowerCase();
  const currentSearchRevision = repository.revision ?? repository.version;
  const currentSearchPage = searchPage?.revision === currentSearchRevision ? searchPage : null;
  const searchResultsStale = Boolean(searchPage && !currentSearchPage);
  const rootFolder = useMemo(() => makeTree(repository.files, repository.name), [repository.files, repository.name]);
  const matchingIds = useMemo(() => new Set(repository.files.filter((file) => searchMode === "content" || !query || file.name.toLowerCase().includes(query) || file.path.toLowerCase().includes(query)).map((file) => file.id)), [repository.files, query, searchMode]);
  const languageOptions = useMemo(() => [...new Set(repository.files.map((file) => file.language).filter((value): value is string => Boolean(value)))].sort(), [repository.files]);
  useEffect(() => {
    const requestId = ++searchSequence.current;
    searchController.current?.abort();
    if (searchMode !== "content" || !searchQuery.trim()) return;
    const controller = new AbortController();
    searchController.current = controller;
    const timer = window.setTimeout(async () => {
      setSearchBusy(true); setSearchPage(null); setSearchError("");
      try {
        let value: SearchResponse;
        if (repository.source === "local") {
          const request: SearchRequest = { repositoryId: repository.id, revision: repository.revision ?? "", query: searchQuery.trim(), ...searchOptions };
          value = await localRepositoryProvider.searchContent(request, controller.signal);
        } else {
          const pattern = new RegExp(searchOptions.regex ? searchQuery : searchQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), `${searchOptions.matchCase ? "" : "i"}u`);
          const matcher = searchOptions.wholeWord && !searchOptions.regex ? new RegExp(`(?<![\\p{L}\\p{N}_])(?:${searchQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?![\\p{L}\\p{N}_])`, `${searchOptions.matchCase ? "" : "i"}u`) : pattern;
          const results = repository.files.filter((file) => file.source !== undefined && (!searchOptions.pathPrefix || file.path.startsWith(`${searchOptions.pathPrefix}/`)) && (!searchOptions.language || file.language === searchOptions.language) && (!searchOptions.excludeTests || !/(^|[/_.-])(test|tests|spec|specs)([/_.-]|$)|\.(test|spec)\./i.test(file.path)))
            .sort((a, b) => a.path.localeCompare(b.path)).flatMap((file) => (file.source ?? "").split("\n").flatMap((text, index) => {
              matcher.lastIndex = 0;
              const match = matcher.exec(text);
              if (!match) return [];
              const matchStartColumn = match.index;
              const matchEndColumn = match.index + match[0].length;
              const contextStartColumn = Math.max(0, matchStartColumn - 180);
              const contextEndColumn = Math.min(text.length, matchEndColumn + 180);
              return [{ fileId: file.id, path: file.path, language: file.language ?? "", line: index + 1, text: text.slice(contextStartColumn, contextEndColumn), contextStartColumn, contextEndColumn, lineLength: text.length, matchStartColumn, matchEndColumn }];
            }));
          value = { revision: repository.revision ?? repository.version, filesSearched: repository.files.length, offset: 0, pageSize: 100, total: results.length, results: results.slice(0, 100), hasMore: results.length > 100, capped: false };
        }
        if (!controller.signal.aborted && searchSequence.current === requestId) setSearchPage(value);
      } catch (error) { if (!controller.signal.aborted && searchSequence.current === requestId) setSearchError(error instanceof Error ? error.message : "源码搜索失败。"); }
      finally { if (!controller.signal.aborted && searchSequence.current === requestId) setSearchBusy(false); }
    }, 250);
    return () => { window.clearTimeout(timer); searchController.current?.abort(); searchController.current = null; controller.abort(); };
  }, [repository, searchMode, searchQuery, searchOptions]);
  const loadMoreSearch = async () => {
    if (!searchPage?.hasMore || searchBusy || repository.source !== "local") return;
    const requestId = searchSequence.current;
    const controller = new AbortController(); searchController.current?.abort(); searchController.current = controller; setSearchBusy(true); setSearchError("");
    try {
      const next = await localRepositoryProvider.searchContent({ repositoryId: repository.id, revision: repository.revision ?? "", query: searchQuery.trim(), ...searchOptions, offset: searchPage.offset + searchPage.results.length }, controller.signal);
      if (requestId === searchSequence.current && next.revision === (repository.revision ?? repository.version)) setSearchPage((current) => current ? { ...next, results: [...current.results, ...next.results] } : next);
    } catch (error) { if (!controller.signal.aborted && requestId === searchSequence.current) setSearchError(error instanceof Error ? error.message : "无法读取下一页搜索结果。"); }
    finally { if (searchController.current === controller) searchController.current = null; if (requestId === searchSequence.current) setSearchBusy(false); }
  };
  return <aside className={`files-pane${mobileView !== "files" ? " mobile-hidden" : ""}`} aria-label="文件目录">
<div className="pane-heading"><h2>文件</h2></div>
    <div className="search-mode-switch" role="group" aria-label="搜索范围"><button type="button" className={searchMode === "files" ? "is-active" : ""} onClick={() => { invalidateSearch(); setSearchMode("files"); }}>文件</button><button type="button" className={searchMode === "content" ? "is-active" : ""} onClick={() => { invalidateSearch(); setSearchMode("content"); }}>内容</button></div>
    <label className="search-field"><Search size={15} aria-hidden="true" /><input ref={searchInputRef} value={searchQuery} onChange={(event) => { invalidateSearch(); onSearchChange(event.target.value); }} placeholder={searchMode === "content" ? "搜索源码内容…" : "搜索文件…"} aria-label={searchMode === "content" ? "搜索源码内容" : "搜索文件名或路径"} />
      {searchQuery && <button type="button" aria-label="清除搜索" onClick={() => { invalidateSearch(); onSearchChange(""); }}><X size={14} /></button>}{!searchQuery && <kbd>/</kbd>}
    </label>
    {searchMode === "content" && <div className="content-search-filters">
      <input aria-label="搜索目录范围" placeholder="目录前缀（可选）" value={searchOptions.pathPrefix} onChange={(event) => { invalidateSearch(); setSearchOptions((previous) => ({ ...previous, pathPrefix: event.target.value })); }} />
      <select aria-label="按语言筛选" value={searchOptions.language} onChange={(event) => { invalidateSearch(); setSearchOptions((previous) => ({ ...previous, language: event.target.value })); }}><option value="">全部语言</option>{languageOptions.map((language) => <option key={language} value={language}>{language}</option>)}</select>
      <div><label><input type="checkbox" checked={searchOptions.matchCase} onChange={(event) => { invalidateSearch(); setSearchOptions((previous) => ({ ...previous, matchCase: event.target.checked })); }} />区分大小写</label><label><input type="checkbox" checked={searchOptions.wholeWord} onChange={(event) => { invalidateSearch(); setSearchOptions((previous) => ({ ...previous, wholeWord: event.target.checked })); }} />完整单词</label><label><input type="checkbox" checked={searchOptions.regex} onChange={(event) => { invalidateSearch(); setSearchOptions((previous) => ({ ...previous, regex: event.target.checked })); }} />正则</label><label><input type="checkbox" checked={searchOptions.excludeTests} onChange={(event) => { invalidateSearch(); setSearchOptions((previous) => ({ ...previous, excludeTests: event.target.checked })); }} />排除测试</label></div>
    </div>}
    <div className="tree-scroll"><div className="tree-root-label"><Folder size={15} /><span>{repository.name}</span><span className="tree-root-dot" /></div>
      {searchMode === "content" ? <div className="content-search-results" aria-live="polite">
        {searchBusy && <p role="status">正在搜索已索引源码…</p>}{searchError && <p role="alert">{searchError}</p>}
        {searchResultsStale && <p role="status">仓库快照已更新，旧搜索位置已停用，正在重新查询。</p>}
        {currentSearchPage && <><p className="content-search-summary">找到 {currentSearchPage.total} 处匹配 · 已检查 {currentSearchPage.filesSearched} 个文件{currentSearchPage.capped ? " · 已达到 10,000 条结果上限" : ""}</p>{currentSearchPage.results.length > 0 && <div className="content-search-bulk"><label><input type="checkbox" aria-label="全选当前页搜索文件" checked={currentSearchPage.results.every((result) => selectedSearchFiles.includes(result.fileId))} onChange={(event) => setSelectedSearchFiles(event.target.checked ? [...new Set([...selectedSearchFiles, ...currentSearchPage.results.map((result) => result.fileId)])] : selectedSearchFiles.filter((id) => !currentSearchPage.results.some((result) => result.fileId === id)))} />全选当前页</label><button type="button" disabled={!selectedSearchFiles.length} onClick={() => { onAddSearchResult(selectedSearchFiles); setSelectedSearchFiles([]); }}>加入问答范围（{selectedSearchFiles.length} 个文件）</button></div>}{currentSearchPage.results.map((result) => <article className="content-search-result" key={`${result.fileId}:${result.line}`}><label className="content-search-select"><input type="checkbox" aria-label={`选择 ${result.path} 第 ${result.line} 行`} checked={selectedSearchFiles.includes(result.fileId)} onChange={(event) => setSelectedSearchFiles((current) => event.target.checked ? [...new Set([...current, result.fileId])] : current.filter((id) => id !== result.fileId))} /></label><button type="button" className="content-search-hit" onClick={() => onOpenSearchResult(result.fileId, result.line)}><strong>{result.path}<small>:{result.line}</small></strong><code>{result.contextStartColumn > 1 && "…"}{result.text.slice(0, Math.max(0, result.matchStartColumn - result.contextStartColumn))}<mark>{result.text.slice(Math.max(0, result.matchStartColumn - result.contextStartColumn), Math.max(0, result.matchEndColumn - result.contextStartColumn + 1))}</mark>{result.text.slice(Math.max(0, result.matchEndColumn - result.contextStartColumn + 1))}{result.contextEndColumn < result.lineLength && "…"}</code></button><button type="button" className="content-search-add" onClick={() => onAddSearchResult([result.fileId])}>加入问答</button></article>)}{!currentSearchPage.results.length && !searchBusy && <div className="empty-search"><SearchX size={24} /><strong>没有找到匹配内容</strong><span>试试调整关键词或筛选条件</span></div>}{currentSearchPage.hasMore && repository.source === "local" && <button type="button" className="search-load-more" onClick={() => void loadMoreSearch()} disabled={searchBusy}>加载更多结果</button>}</>}
      </div> : <div className="tree-list" role="tree" aria-label={`${repository.name} 仓库文件`}>
        {!matchingIds.size ? <div className="empty-search"><SearchX size={24} /><strong>没有找到文件</strong><span>试试其他文件名或路径</span></div> : <TreeRows folder={rootFolder} depth={0} matchingIds={matchingIds} selectedId={selectedFileId} collapsed={collapsedFolders} query={query} onToggleFolder={onToggleFolder} onSelect={onSelectFile} />}
      </div>}
    </div>
<div className="sidebar-footnote"><span>{repository.source === "local" ? "本地静态分析 · 保存文件后自动更新" : "内置示例 · 未访问本地文件"}</span></div>
  </aside>;
}
