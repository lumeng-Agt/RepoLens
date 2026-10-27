import type { MouseEvent, RefObject } from "react";
import { memo, useEffect, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  type Edge,
  type Node,
  type NodeProps,
  type OnNodesChange,
  type ReactFlowInstance,
} from "@xyflow/react";
import { ArrowDownUp, Crosshair, FileCode2, FileText, RotateCcw, Search, Waypoints } from "lucide-react";
import type { DependencyEdge, FileRecord, RepositorySnapshot } from "@/data/model";
import { findCycleForFile, findDependencyPath, findPotentialImpact } from "@/data/dependency-query.mjs";

export type GraphNodeData = { file: FileRecord; selected: boolean; compact: boolean; queryHighlighted?: boolean };
export type GraphNode = Node<GraphNodeData, "fileCard">;

const GraphFileCard = memo(function GraphFileCard({ data, selected }: NodeProps<GraphNode>) {
  const { file } = data;
  const Icon = file.kind === "style" ? FileText : FileCode2;
  return <div className={`graph-file-card${selected ? " is-selected" : ""}${data.compact ? " is-compact" : ""}${data.queryHighlighted ? " is-query-highlighted" : ""}`}>
    <Handle type="target" position={Position.Left} />
    <span className={`graph-file-icon${file.kind === "style" ? " is-style" : ""}`}><Icon size={15} aria-hidden="true" /></span>
    <span className="graph-file-copy"><span className="graph-file-name">{file.name}</span><span className="graph-file-role">{file.role}</span></span>
    {selected && <span className="graph-selected-dot" aria-label="当前文件" />}
    <Handle type="source" position={Position.Right} />
  </div>;
}, (previous, next) => previous.selected === next.selected
  && previous.data.compact === next.data.compact
  && previous.data.file.id === next.data.file.id
  && previous.data.file.name === next.data.file.name
  && previous.data.file.kind === next.data.file.kind
  && previous.data.file.role === next.data.file.role
  && previous.data.queryHighlighted === next.data.queryHighlighted);

const nodeTypes = { fileCard: GraphFileCard };
const resolutionBasisLabels: Record<string, string> = {
  "relative-path": "相对路径解析",
  "config-alias": "配置别名解析",
  "python-module": "Python 模块解析",
  "python-submodule": "Python 子模块解析",
  "go-package-expanded": "Go 包展开",
  "typescript-resolution": "TypeScript 模块解析",
};

function GraphFlowCanvas({ nodes, edges, onNodesChange, onNodeClick, onInit, showAll }: {
  nodes: GraphNode[]; edges: Edge[]; onNodesChange: OnNodesChange<GraphNode>;
  onNodeClick: (event: MouseEvent, node: GraphNode) => void;
  onInit: (instance: ReactFlowInstance<GraphNode>) => void; showAll: boolean;
}) {
  const nodesInitialized = useNodesInitialized();
  return <div className="graph-flow-host" data-nodes-initialized={nodesInitialized}>
    <ReactFlow
      nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onNodeClick={onNodeClick} onInit={onInit}
      minZoom={showAll ? 0.08 : 0.28} maxZoom={1.65}
      nodesDraggable={nodesInitialized} nodesConnectable={false} elementsSelectable={false} deleteKeyCode={null}
      proOptions={{ hideAttribution: false }} defaultEdgeOptions={{ selectable: false, focusable: false, deletable: false }}
      aria-label="代码文件之间的静态引用关系，选择节点查看详情"
    ><Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--border)" /><Controls showInteractive={false} position="bottom-right" fitViewOptions={{ padding: 0.18, minZoom: 0.08, maxZoom: 1.35 }} /></ReactFlow>
  </div>;
}

export function GraphPanel({
  mobileView, directory, directories, graphLabel, scopedFileCount, hiddenCount, showAll,
  graphReady, graphActive, canvasRef, nodes, edges, repository, currentFileId, onOpenReference, onNodesChange, onNodeClick, onInit, onDirectoryChange, onToggleScope, onLocateCurrent, onResetLayout, disabled = false,
}: {
  mobileView: "files" | "graph" | "details";
  directory: string;
  directories: string[];
  graphLabel: string;
  scopedFileCount: number;
  hiddenCount: number;
  showAll: boolean;
  graphReady: boolean;
  graphActive: boolean;
  canvasRef: RefObject<HTMLDivElement | null>;
  nodes: GraphNode[];
  edges: Edge[];
  repository: RepositorySnapshot;
  currentFileId: string;
  onOpenReference: (reference: { fileId: string; line: number; endLine?: number }) => void;
  onNodesChange: OnNodesChange<GraphNode>;
  onNodeClick: (event: MouseEvent, node: GraphNode) => void;
  onInit: (instance: ReactFlowInstance<GraphNode>) => void;
  onDirectoryChange: (directory: string) => void;
  onToggleScope: () => void;
  onLocateCurrent: () => void;
  onResetLayout: () => void;
  disabled?: boolean;
}) {
  const [hasMountedFlow, setHasMountedFlow] = useState(false);
  const [queryMode, setQueryMode] = useState<"path" | "impact" | "cycle">("path");
  const [direction, setDirection] = useState<"imports" | "imported-by">("imports");
  const [fromSelection, setFromSelection] = useState<{ currentFileId: string; value: string }>({ currentFileId, value: currentFileId });
  const [toId, setToId] = useState("");
  const [queryResult, setQueryResult] = useState<{ fileIds: string[]; edgeIds: string[]; label: string; edges: DependencyEdge[]; revision: string; directory: string } | null>(null);
  const scopedFiles = useMemo(() => repository.files.filter((file) => !directory || file.id.startsWith(`${directory}/`)).sort((a, b) => a.path.localeCompare(b.path)), [repository.files, directory]);
  const scopedSnapshot = useMemo(() => { const ids = new Set(scopedFiles.map((file) => file.id)); return { ...repository, files: scopedFiles, dependencies: repository.dependencies.filter((edge) => ids.has(edge.fromId) && ids.has(edge.toId)) }; }, [repository, scopedFiles]);
  const fromId = fromSelection.currentFileId === currentFileId && scopedFiles.some((file) => file.id === fromSelection.value)
    ? fromSelection.value
    : scopedFiles.some((file) => file.id === currentFileId) ? currentFileId : scopedFiles[0]?.id ?? "";
  const currentQueryResult = queryResult?.revision === (repository.revision ?? repository.version) && queryResult.directory === directory ? queryResult : null;
  const publishQueryResult = (value: { fileIds: string[]; edgeIds: string[]; label: string; edges: DependencyEdge[] }) => setQueryResult({ ...value, revision: repository.revision ?? repository.version, directory });
  const graphNodes = useMemo(() => nodes.map((node) => ({ ...node, data: { ...node.data, queryHighlighted: Boolean(currentQueryResult?.fileIds.includes(node.id)) } })), [nodes, currentQueryResult]);
  const graphEdges = useMemo(() => edges.map((edge) => {
    const active = Boolean(currentQueryResult?.edgeIds.includes(edge.id));
    return { ...edge, style: { ...edge.style, stroke: active ? "var(--accent)" : edge.style?.stroke, strokeWidth: active ? 3 : edge.style?.strokeWidth, opacity: currentQueryResult ? active ? 1 : 0.08 : edge.style?.opacity } };
  }), [edges, currentQueryResult]);
  const runQuery = () => {
    if (queryMode === "path") {
      const result = findDependencyPath(scopedSnapshot, fromId, toId, direction);
      publishQueryResult(result.status === "found" ? { fileIds: result.files, edgeIds: result.edges.map((link: { edge: DependencyEdge }) => link.edge.id), edges: result.edges.map((link: { edge: DependencyEdge }) => link.edge), label: `静态依赖路径 · ${result.files.length} 个文件` } : { fileIds: [], edgeIds: [], edges: [], label: result.status === "missing" ? "请选择仍存在于当前快照的两个文件。" : "当前静态图中没有找到依赖路径。" });
    } else if (queryMode === "impact") {
      const result = findPotentialImpact(scopedSnapshot, fromId);
      publishQueryResult({ fileIds: [fromId, ...result.flatMap((link: { to: string }) => [link.to])], edgeIds: result.slice(0, 200).map((link: { edge: DependencyEdge }) => link.edge.id), edges: result.slice(0, 200).map((link: { edge: DependencyEdge }) => link.edge), label: `潜在影响范围 · ${result.length} 条静态引用${result.length > 200 ? ` · 展示前 200 条，另有 ${result.length - 200} 条` : ""}` });
    } else {
      const result = findCycleForFile(scopedSnapshot, fromId);
      publishQueryResult({ fileIds: [...new Set(result.flatMap((edge: DependencyEdge) => [edge.fromId, edge.toId]))], edgeIds: result.map((edge: DependencyEdge) => edge.id), edges: result, label: result.length ? `当前文件所在的循环依赖 · ${result.length} 条静态引用` : "当前文件未发现循环依赖。" });
    }
  };
  useEffect(() => {
    if (!graphReady || !graphActive) return;
    const frame = requestAnimationFrame(() => setHasMountedFlow(true));
    return () => cancelAnimationFrame(frame);
  }, [graphReady, graphActive]);
  const shouldRenderFlow = graphReady && (graphActive || hasMountedFlow);

  return <section className={`graph-pane${mobileView !== "graph" ? " mobile-hidden" : ""}`} aria-label="依赖关系图" data-graph-ready={graphReady} data-graph-active={graphActive}>
    <div className="graph-toolbar">
      <div className="graph-title-group"><span className="toolbar-icon"><Waypoints size={16} /></span><div><h2>依赖关系</h2><span>{graphLabel}{hiddenCount > 0 ? ` · 已隐藏 ${hiddenCount}` : ""}</span></div></div>
      <div className="graph-actions">
        <label className="graph-directory-filter"><span className="sr-only">筛选图谱目录</span><select aria-label="筛选图谱目录" value={directory} disabled={disabled} onChange={(event) => onDirectoryChange(event.target.value)}><option value="">全部目录</option>{directories.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        {scopedFileCount <= 200 && scopedFileCount > 1 && <button disabled={disabled} onClick={onToggleScope} aria-label={showAll ? "查看当前关联" : "查看所选目录全图"} data-tooltip={showAll ? "查看当前关联" : "查看所选目录全图"}><Waypoints size={15} /></button>}
        <button disabled={disabled} onClick={onLocateCurrent} aria-label="定位当前文件" title="定位当前文件"><Crosshair size={15} /></button>
        <button disabled={disabled} onClick={onResetLayout} aria-label="重置布局" title="重置布局"><RotateCcw size={15} /></button>
      </div>
    </div>
    <div className="graph-query" aria-label="依赖查询">
      <div className="graph-query-controls">
        <select aria-label="依赖查询类型" value={queryMode} disabled={disabled} onChange={(event) => { setQueryMode(event.target.value as typeof queryMode); setQueryResult(null); }}><option value="path">查找依赖路径</option><option value="impact">潜在影响范围</option><option value="cycle">循环依赖</option></select>
        {queryMode === "path" ? <><select aria-label="路径起点" value={fromId} onChange={(event) => setFromSelection({ currentFileId, value: event.target.value })}>{scopedFiles.map((file) => <option key={file.id} value={file.id}>{file.path}</option>)}</select><ArrowDownUp size={14} aria-hidden="true" /><select aria-label="路径终点" value={toId} onChange={(event) => setToId(event.target.value)}><option value="">选择终点</option>{scopedFiles.map((file) => <option key={file.id} value={file.id}>{file.path}</option>)}</select><button type="button" aria-label={direction === "imports" ? "查询导入方向" : "查询被导入方向"} title="切换依赖方向" onClick={() => setDirection((value) => value === "imports" ? "imported-by" : "imports")}><ArrowDownUp size={15} /></button></> : <select aria-label="查询文件" value={fromId} onChange={(event) => setFromSelection({ currentFileId, value: event.target.value })}>{scopedFiles.map((file) => <option key={file.id} value={file.id}>{file.path}</option>)}</select>}
        <button type="button" className="graph-query-run" disabled={disabled || !fromId || queryMode === "path" && !toId} onClick={runQuery}><Search size={14} />查询</button>
      </div>
      {currentQueryResult && <div className="graph-query-result" aria-live="polite"><strong>{currentQueryResult.label}</strong>{currentQueryResult.edges.map((edge) => <button key={edge.id} type="button" onClick={() => onOpenReference(edge.reference)}><span>{repository.files.find((file) => file.id === edge.fromId)?.path} → {repository.files.find((file) => file.id === edge.toId)?.path}</span><small>第 {edge.reference.line} 行 · {resolutionBasisLabels[edge.resolutionBasis ?? ""] ?? "静态引用关系"}{edge.typeOnly ? " · 类型引用" : ""}</small></button>)}</div>}
    </div>
    <div ref={canvasRef} className="graph-canvas" aria-label="文件依赖关系图">
      {shouldRenderFlow && <div className="graph-flow-mount" aria-hidden={!graphActive} style={{ visibility: graphActive ? "visible" : "hidden", pointerEvents: graphActive ? "auto" : "none" }}><ReactFlowProvider><GraphFlowCanvas nodes={graphNodes} edges={graphEdges} onNodesChange={onNodesChange} onNodeClick={onNodeClick} onInit={onInit} showAll={showAll} /></ReactFlowProvider></div>}
      <div className="graph-legend" aria-label="依赖图图例"><span className="legend-direction is-outgoing"><i />当前文件引用</span><span className="legend-direction is-incoming"><i />引用当前文件</span><span className="legend-divider" /><span className="legend-dot" />当前文件</div>
      <div className="graph-helper"><span>拖动节点整理视图</span><span className="helper-separator">·</span><span>滚轮缩放</span></div>
    </div>
  </section>;
}
