import { useEffect, useMemo, useState } from "react";
import { Telescope } from "lucide-react";
import type { AiRouteRecord, ReadingNote, RepositoryOverview as OverviewData, RepositorySnapshot } from "@/data/model";
import type { AiResultRecord } from "@/components/repolens/AiResultView";
import { localRepositoryProvider } from "@/data/providers";
import { RevisionComparisonPanel } from "@/components/repolens/RevisionComparisonPanel";

export function WorkspaceOverview({ repository, stepCount, compact = false, clearVersion = 0, notes, tours, results, statusMessage, onSelectFile, onDismissMessage }: { repository: RepositorySnapshot; stepCount: number; compact?: boolean; clearVersion?: number; notes: ReadingNote[]; tours: AiRouteRecord[]; results: AiResultRecord[]; statusMessage?: string; onSelectFile: (fileId: string) => void; onDismissMessage?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [remoteOverview, setRemoteOverview] = useState<OverviewData | null>(null);
  const [overviewError, setOverviewError] = useState<{ revision: string; message: string } | null>(null);
  const localFallback = useMemo<OverviewData>(() => {
    const incoming = new Set(repository.dependencies.map((edge) => edge.toId));
    const candidates = repository.files.filter((file) => !incoming.has(file.id) || /^(index|main|app|cli)\./i.test(file.name)).slice(0, 12).map((file) => ({ fileId: file.id, path: file.path, reason: incoming.has(file.id) ? "文件名符合常见入口命名" : "没有仓库内文件直接引用此文件" }));
    const directories = new Map<string, number>(); const languages = new Map<string, number>(); const tests: string[] = [];
    for (const file of repository.files) { const directory = file.path.split("/")[0]; if (directory !== file.path) directories.set(directory, (directories.get(directory) ?? 0) + 1); const language = file.language ?? file.kind; languages.set(language, (languages.get(language) ?? 0) + 1); if (/(^|[/_.-])(test|tests|spec|specs)([/_.-]|$)|\.(test|spec)\./i.test(file.path)) tests.push(file.path); }
    return { revision: repository.revision ?? repository.version, readme: null, manifests: repository.configPath ?? [], candidates, directories: [...directories].map(([name, files]) => ({ name, files })), languages: [...languages].map(([name, files]) => ({ name, files })), tests: tests.slice(0, 30), testCount: tests.length, diagnosticCount: repository.diagnostics?.length ?? 0, limitations: "入口是根据静态引用和文件名筛出的候选；依赖关系表示静态引用，不代表运行时调用。" };
  }, [repository]);
  useEffect(() => {
    if (!expanded || repository.source !== "local") return;
    const controller = new AbortController();
    const revision = repository.revision ?? repository.version;
    localRepositoryProvider.getOverview(repository.id, revision, controller.signal).then((value) => { setRemoteOverview(value); setOverviewError(null); }).catch((error: Error) => { if (error.name !== "AbortError") setOverviewError({ revision, message: error.message }); });
    return () => controller.abort();
  }, [expanded, repository.id, repository.revision, repository.source, repository.version]);
  const currentRevision = repository.revision ?? repository.version;
  const overview = repository.source === "local" ? remoteOverview?.revision === currentRevision ? remoteOverview : null : localFallback;
  const currentOverviewError = overviewError?.revision === currentRevision ? overviewError.message : "";
  return <section className={`workspace-overview${compact ? " is-compact" : ""}`} aria-label="仓库概览">
    <div className="workspace-overview-copy"><span className="workspace-context-label">{repository.origin?.kind === "github" ? `${repository.origin.resolvedRef} · ${repository.origin.commit.slice(0, 12)}` : repository.source === "local" ? "本地仓库 · 静态分析" : "内置示例"}</span></div>
    <div className="workspace-overview-actions">
      {statusMessage && <div className="workspace-message" role="status" title={statusMessage}><span>{statusMessage}</span>{onDismissMessage && <button type="button" aria-label="关闭提示" onClick={onDismissMessage}>×</button>}</div>}
      <details className="overview-disclosure" onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary><Telescope size={14} />仓库概览</summary>
        <div className="overview-popover">
          <div className="overview-popover-heading"><strong>{repository.name}</strong><span>{repository.files.length} 个源码文件 · {repository.dependencies.length} 条静态引用 · {stepCount} 个阅读步骤</span></div>
          {repository.origin?.kind === "github" && <section><h2>GitHub 来源</h2><a href={repository.origin.url} target="_blank" rel="noreferrer">{repository.origin.url}</a><p>ref · {repository.origin.resolvedRef}</p><p>commit · {repository.origin.commit}</p></section>}
          {currentOverviewError && <p role="alert">{currentOverviewError}</p>}
          {!overview && !currentOverviewError && <p role="status">正在加载仓库概览…</p>}
          {overview && <>
            <section><h2>README 摘要</h2>{overview.readme?.summary ? <pre>{overview.readme.summary}</pre> : <p>{repository.source === "sample" ? "内置示例没有 README 文件。" : "仓库根目录没有可安全读取的 README 文件。"}</p>}</section>
            <section><h2>技术与配置</h2><p>{overview.languages.map((item) => `${item.name} ${item.files}`).join(" · ") || "未识别出支持的语言"}</p><p>{overview.manifests.length ? `配置依据：${overview.manifests.join("、")}` : "未发现已支持的根配置文件。"}</p></section>
            <section><h2>入口候选</h2>{overview.candidates.length ? <ul>{overview.candidates.slice(0, 8).map((candidate) => <li key={candidate.fileId}><button type="button" onClick={() => onSelectFile(candidate.fileId)}><code>{candidate.path}</code><small>{candidate.reason}</small></button></li>)}</ul> : <p>没有足够依据判断入口文件。</p>}</section>
            <section><h2>目录与测试</h2><p>{overview.directories.map((item) => `${item.name}（${item.files}）`).join(" · ") || "仓库没有子目录"}</p><p>测试路径 {overview.testCount} 个{overview.tests.length ? `：${overview.tests.slice(0, 5).join("、")}` : ""}</p><p>静态分析诊断 {overview.diagnosticCount} 条</p></section>
            <p className="overview-limitations">{overview.limitations}</p>
          </>}
          {repository.source === "local" && <RevisionComparisonPanel key={`${clearVersion}:${repository.origin?.kind ?? repository.source}:${repository.id}:${repository.workspaceId ?? ""}:${repository.persistenceSessionId ?? ""}:${currentRevision}`} repository={repository} notes={notes} tours={tours} results={results} onSelectFile={onSelectFile} />}
        </div>
      </details>
    </div>
  </section>;
}
