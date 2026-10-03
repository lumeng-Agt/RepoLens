import type { MouseEvent, RefObject } from "react";
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
import { Crosshair, FileCode2, FileText, RotateCcw, Waypoints } from "lucide-react";
import type { FileRecord } from "@/data/model";

export type GraphNodeData = { file: FileRecord; selected: boolean; compact: boolean };
export type GraphNode = Node<GraphNodeData, "fileCard">;

function GraphFileCard({ data, selected }: NodeProps<GraphNode>) {
  const { file } = data;
  const Icon = file.kind === "style" ? FileText : FileCode2;
  return <div className={`graph-file-card${selected ? " is-selected" : ""}${data.compact ? " is-compact" : ""}`}>
    <Handle type="target" position={Position.Left} />
    <span className={`graph-file-icon${file.kind === "style" ? " is-style" : ""}`}><Icon size={15} aria-hidden="true" /></span>
    <span className="graph-file-copy"><span className="graph-file-name">{file.name}</span><span className="graph-file-role">{file.role}</span></span>
    {selected && <span className="graph-selected-dot" aria-label="当前文件" />}
    <Handle type="source" position={Position.Right} />
  </div>;
}

const nodeTypes = { fileCard: GraphFileCard };

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
      aria-label="代码文件导入关系，选择一个节点查看详情"
    ><Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#273541" /><Controls showInteractive={false} position="bottom-right" fitViewOptions={{ padding: 0.18, minZoom: 0.08, maxZoom: 1.35 }} /></ReactFlow>
  </div>;
}

export function GraphPanel({
  mobileView, directory, directories, graphLabel, scopedFileCount, hiddenCount, showAll,
  graphReady, graphActive, canvasRef, nodes, edges, onNodesChange, onNodeClick, onInit, onDirectoryChange, onToggleScope, onLocateCurrent, onResetLayout,
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
  onNodesChange: OnNodesChange<GraphNode>;
  onNodeClick: (event: MouseEvent, node: GraphNode) => void;
  onInit: (instance: ReactFlowInstance<GraphNode>) => void;
  onDirectoryChange: (directory: string) => void;
  onToggleScope: () => void;
  onLocateCurrent: () => void;
  onResetLayout: () => void;
}) {
  return <section className={`graph-pane${mobileView !== "graph" ? " mobile-hidden" : ""}`} aria-label="模块依赖图">
    <div className="graph-toolbar">
      <div className="graph-title-group"><span className="toolbar-icon"><Waypoints size={16} /></span><div><h2>模块关系</h2><span>{graphLabel}{hiddenCount > 0 ? ` · 已隐藏 ${hiddenCount}` : ""}</span></div></div>
      <div className="graph-actions">
        <label className="graph-directory-filter"><span className="sr-only">筛选图谱目录</span><select aria-label="筛选图谱目录" value={directory} onChange={(event) => onDirectoryChange(event.target.value)}><option value="">全部目录</option>{directories.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        {scopedFileCount <= 200 && scopedFileCount > 1 && <button onClick={onToggleScope} aria-label={showAll ? "查看当前关联" : "查看所选目录全图"} data-tooltip={showAll ? "查看当前关联" : "查看所选目录全图"}><Waypoints size={15} /></button>}
        <button onClick={onLocateCurrent} aria-label="定位当前文件" data-tooltip="定位当前文件"><Crosshair size={15} /></button>
        <button onClick={onResetLayout} aria-label="重置布局" data-tooltip="重置布局"><RotateCcw size={15} /></button>
      </div>
    </div>
    <div ref={canvasRef} className="graph-canvas" aria-label="文件依赖关系图">
      {graphReady && graphActive && <ReactFlowProvider><GraphFlowCanvas nodes={nodes} edges={edges} onNodesChange={onNodesChange} onNodeClick={onNodeClick} onInit={onInit} showAll={showAll} /></ReactFlowProvider>}
      <div className="graph-legend"><span className="legend-sample"><i /></span><span>当前文件导入目标文件</span><span className="legend-divider" /><span className="legend-dot" />当前文件</div>
      <div className="graph-helper"><span>拖动节点整理视图</span><span className="helper-separator">·</span><span>滚轮缩放</span></div>
    </div>
  </section>;
}
