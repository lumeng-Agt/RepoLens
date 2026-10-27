"use client";

import { useState, type FormEvent, type RefObject } from "react";
import { BookOpen, FolderOpen, GitBranch, History, Settings2, Trash2 } from "lucide-react";
import { recentRepositoryOpenLocation, recentRepositoryTargetLabel } from "@/data/recent-repository-label.mjs";
import type { LocalWorkspaceState } from "@/data/providers";

type RecentRepository = LocalWorkspaceState["recentRepositories"][number];

export function RepositoryHome({
  path, busy, desktop, message, recentRepositories, guideButtonRef, ready, onPathChange, onPickDirectory, onOpen, onOpenRecent, onRemoveRecent, onTryExample, onOpenGuide, onOpenSettings,
}: {
  path: string;
  busy: boolean;
  desktop: boolean;
  message: string;
  recentRepositories: RecentRepository[];
  guideButtonRef: RefObject<HTMLButtonElement | null>;
  ready: boolean;
  onPathChange: (value: string) => void;
  onPickDirectory: () => void;
  onOpen: (event: FormEvent<HTMLFormElement>) => void;
  onOpenRecent: (location: string) => void;
  onRemoveRecent: (id: string) => Promise<void>;
  onTryExample: () => void;
  onOpenGuide: () => void;
  onOpenSettings: () => void;
}) {
  const [removingId, setRemovingId] = useState("");
  return <main className="repository-home" data-app-ready={ready ? "true" : "false"} aria-labelledby="repository-home-title">
    <header className="home-topbar">
      <div className="brand-lockup"><span className="brand-mark" aria-hidden="true"><GitBranch size={17} /></span><span className="brand-name">Repo<span>Lens</span></span></div>
      <div className="home-header-actions"><button ref={guideButtonRef} type="button" className="home-guide-link" onClick={onOpenGuide}><BookOpen size={15} />使用指南</button><button type="button" className="home-guide-link" onClick={onOpenSettings}><Settings2 size={15} />模型设置</button></div>
    </header>
    <div className="home-content">
      <section className="home-open-section">
        <div className="home-heading"><h1 id="repository-home-title">打开仓库，开始阅读</h1><p>选择本地目录，或输入 GitHub 仓库链接。</p></div>
        <form className="home-open-form" onSubmit={onOpen}>
          <label className="home-path-field"><span>仓库位置</span><input id="repository-path" autoFocus value={path} onChange={(event) => onPathChange(event.target.value)} placeholder={desktop ? "输入本地路径或 GitHub 链接" : "本地路径或 https://github.com/owner/repo"} aria-label="本地路径或 GitHub 仓库链接" /></label>
          {desktop && <button type="button" className="home-secondary-button home-pick-button" disabled={busy} onClick={onPickDirectory}><FolderOpen size={16} />选择文件夹</button>}
          <button type="submit" className="home-primary-button" disabled={busy || !path.trim()}>{busy ? "正在打开…" : <><FolderOpen size={16} />打开仓库</>}</button>
        </form>
        {message && <p className="home-feedback" role="status">{message}</p>}
        <div className="home-secondary-links"><button type="button" onClick={onTryExample}>打开示例</button><span aria-hidden="true">·</span><button type="button" onClick={onOpenGuide}>查看使用指南</button></div>
      </section>
      <section className="home-recent-section" aria-labelledby="recent-repositories-title">
        <div className="home-section-heading"><div><History size={16} /><h2 id="recent-repositories-title">最近打开</h2></div><span>{recentRepositories.length}/20</span></div>
        {recentRepositories.length ? <ul className="home-recent-list">{recentRepositories.map((recent) => <li key={recent.id}>
          <button type="button" className="home-recent-open" disabled={busy} onClick={() => onOpenRecent(recentRepositoryOpenLocation(recent))} title={recentRepositoryOpenLocation(recent)}>
            <strong>{recent.name}</strong><span>{recentRepositoryTargetLabel(recent)}</span>
          </button>
          <button type="button" className="home-recent-remove" aria-label={`从最近打开中移除 ${recent.name}`} disabled={busy || removingId === recent.id} onClick={() => { setRemovingId(recent.id); void onRemoveRecent(recent.targetId ?? recent.id).finally(() => setRemovingId("")); }}><Trash2 size={15} /></button>
        </li>)}</ul> : <p className="home-empty-recent">打开过的仓库会显示在这里。</p>}
      </section>
    </div>
    <footer className="home-footer">仓库内容只在本机分析。发送代码前会显示范围并要求确认。</footer>
  </main>;
}
