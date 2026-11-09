import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MarkerType, type Edge, useNodesState } from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import { separateOverlappingGraphNodes } from "@/data/graph-layout.mjs";
import { enqueueWorkspacePersistence } from "@/data/workspace-persistence.mjs";
import { localWorkspaceProvider, type WorkspaceSession } from "@/data/providers";
import type { GraphNode } from "@/components/repolens/GraphPanel";
import type { RepositorySnapshot } from "@/data/model";

export function layoutGraph(
  snapshot: RepositorySnapshot,
  selectedId: string,
  showAll = false,
  compact = false,
  directory = "",
  nodePositions: Map<string, { x: number; y: number }> = new Map()
): { nodes: GraphNode[]; edges: Edge[] } {
  const workspaceId = snapshot.workspaceId ?? snapshot.id;
  const inDirectory = (id: string) => !directory || id.startsWith(`${directory}/`);
  const scopedFiles = snapshot.files.filter((file) => inDirectory(file.id));
  const scopedIds = new Set(scopedFiles.map((file) => file.id));
  const neighborhood = [
    ...new Set(
      snapshot.dependencies
        .filter(
          (edge) =>
            scopedIds.has(edge.fromId) &&
            scopedIds.has(edge.toId) &&
            (edge.fromId === selectedId || edge.toId === selectedId)
        )
        .flatMap((edge) => [edge.fromId, edge.toId])
    ),
  ]
    .filter((id) => id !== selectedId)
    .sort((a, b) => a.localeCompare(b));
  const visibleIds = showAll ? scopedIds : new Set([selectedId, ...neighborhood].slice(0, 100));
  const visibleFiles = snapshot.files.filter((file) => visibleIds.has(file.id));
  const visibleDependencies = snapshot.dependencies.filter(
    (edge) => visibleIds.has(edge.fromId) && visibleIds.has(edge.toId)
  );
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: compact ? "TB" : "LR",
    nodesep: compact ? 8 : 38,
    ranksep: compact ? 28 : 74,
    marginx: compact ? 10 : 34,
    marginy: compact ? 12 : 32,
  });

  for (const file of visibleFiles) {
    graph.setNode(file.id, { width: compact ? 140 : 160, height: compact ? 60 : 68 });
  }
  for (const dependency of visibleDependencies) {
    graph.setEdge(dependency.fromId, dependency.toId);
  }
  dagre.layout(graph);

  const nodes: GraphNode[] = visibleFiles.map((file) => {
    const position = graph.node(file.id);
    return {
      id: file.id,
      type: "fileCard",
      deletable: false,
      measured: { width: compact ? 140 : 160, height: compact ? 60 : 68 },
      position: nodePositions.get(`${workspaceId}:${file.id}`) ?? {
        x: position.x - (compact ? 70 : 80),
        y: position.y - (compact ? 30 : 34),
      },
      data: { file, selected: file.id === selectedId, compact },
      selected: file.id === selectedId,
    };
  });

  const edges: Edge[] = visibleDependencies.map((dependency) => {
    const importsFromCurrent = dependency.fromId === selectedId;
    const importsCurrent = dependency.toId === selectedId;
    const connected = importsFromCurrent || importsCurrent;
    return {
      id: dependency.id,
      deletable: false,
      source: dependency.fromId,
      target: dependency.toId,
      type: "smoothstep",
      animated: false,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 14,
        height: 14,
        color: importsFromCurrent
          ? "var(--thread-outgoing)"
          : importsCurrent
          ? "var(--thread-incoming)"
          : "var(--border-strong)",
      },
      style: {
        stroke: importsFromCurrent
          ? "var(--thread-outgoing)"
          : importsCurrent
          ? "var(--thread-incoming)"
          : "var(--border-strong)",
        strokeWidth: connected ? 1.8 : 1.15,
        opacity: connected ? 1 : 0.2,
      },
    };
  });
  return { nodes, edges };
}

export interface UseGraphCoordinatesOptions {
  repository: RepositorySnapshot;
  workspaceId: string;
  selectedFileId: string;
  showAllGraph: boolean;
  compactGraph: boolean;
  graphDirectory: string;
  layoutVersion: number;
  desktopMode: boolean;
  savedDataClearBusy: boolean;
  workspacePersistenceReadyKeys: Set<string>;
  onSetRepoMessage: (message: string) => void;
  nodePositionSessionKey: (repository: RepositorySnapshot) => string;
  nodePositionSignature: (positions: Record<string, { x: number; y: number }>) => string;
  workspaceSession: (repository: RepositorySnapshot) => WorkspaceSession;
  bootSnapshotId: string;
  nodePositionsReadyKey?: string | null;
  setNodePositionsReadyKey?: React.Dispatch<React.SetStateAction<string | null>>;
}

export function useGraphCoordinates({
  repository,
  workspaceId,
  selectedFileId,
  showAllGraph,
  compactGraph,
  graphDirectory,
  layoutVersion,
  desktopMode,
  savedDataClearBusy,
  workspacePersistenceReadyKeys,
  onSetRepoMessage,
  nodePositionSessionKey,
  nodePositionSignature,
  workspaceSession,
  bootSnapshotId,
  nodePositionsReadyKey: externalNodePositionsReadyKey,
  setNodePositionsReadyKey: externalSetNodePositionsReadyKey,
}: UseGraphCoordinatesOptions) {
  const [nodePositions, setNodePositions] = useState(new Map<string, { x: number; y: number }>());
  const nodePositionsRef = useRef(nodePositions);
  useLayoutEffect(() => {
    nodePositionsRef.current = nodePositions;
  }, [nodePositions]);

  const graphNodeDragging = useRef(false);
  const graphLayoutAnchor = useRef<string | undefined>(undefined);
  const nodePositionsPersisted = useRef(new Map<string, string>());
  const dirtyNodePositions = useRef(new Map<string, Set<string>>());
  const pendingNodePositionRestore = useRef<{ key: string; workspaceId: string; signature: string } | null>(null);
  const [internalNodePositionsReadyKey, setInternalNodePositionsReadyKey] = useState<string | null>(null);
  const nodePositionsReadyKey = externalNodePositionsReadyKey !== undefined ? externalNodePositionsReadyKey : internalNodePositionsReadyKey;
  const setNodePositionsReadyKey = externalSetNodePositionsReadyKey ?? setInternalNodePositionsReadyKey;

  const layoutOwner = useRef({ version: 0, repositoryId: bootSnapshotId });
  const activeNodePositionKeyRef = useRef(nodePositionSessionKey(repository));
  useLayoutEffect(() => {
    activeNodePositionKeyRef.current = nodePositionSessionKey(repository);
  }, [repository, nodePositionSessionKey]);

  const initialLayout = useMemo(
    () => layoutGraph(repository, selectedFileId, showAllGraph, compactGraph, graphDirectory, nodePositions),
    [repository, selectedFileId, showAllGraph, compactGraph, graphDirectory, nodePositions]
  );

  const [nodes, setNodes, onNodesChangeBase] = useNodesState<GraphNode>(initialLayout.nodes);
  const graphNodesRef = useRef<GraphNode[]>(nodes);
  useLayoutEffect(() => {
    graphNodesRef.current = nodes;
  }, [nodes]);
  const edges = initialLayout.edges;

  // Restore pending node positions
  useEffect(() => {
    const pending = pendingNodePositionRestore.current;
    if (!pending || pending.workspaceId !== workspaceId) return;
    const prefix = `${workspaceId}:`;
    const current = Object.fromEntries(
      [...nodePositions].flatMap(([key, point]) =>
        key.startsWith(prefix) ? [[key.slice(prefix.length), point] as const] : []
      )
    );
    if (nodePositionSignature(current) !== pending.signature) return;
    pendingNodePositionRestore.current = null;
    setNodePositionsReadyKey(pending.key);
  }, [nodePositions, nodePositionSignature, workspaceId]);

  // Synchronize graph nodes and run collision avoidance
  useEffect(() => {
    const sameWorkspace = layoutOwner.current.repositoryId === workspaceId;
    const shouldReset = layoutOwner.current.version !== layoutVersion;
    if (!sameWorkspace || shouldReset) graphLayoutAnchor.current = undefined;
    const present = new Set(repository.files.map((file) => `${workspaceId}:${file.id}`));
    // Drop removed files and clear positions only when an explicit layout reset occurs.
    setNodePositions((previous) => {
      let changed = false;
      const next = new Map<string, { x: number; y: number }>();
      for (const [id, position] of previous) {
        const isCurrentRepository = id.startsWith(`${workspaceId}:`);
        if (isCurrentRepository && (shouldReset || !present.has(id))) {
          changed = true;
          continue;
        }
        next.set(id, position);
      }
      return changed ? next : previous;
    });

    const next = initialLayout.nodes.map((node) => {
      const existing = graphNodesRef.current.find((candidate) => candidate.id === node.id);
      const savedPosition = nodePositions.get(`${workspaceId}:${node.id}`);
      const position = !shouldReset
        ? graphNodeDragging.current
          ? existing?.position ?? node.position
          : savedPosition
          ? node.position
          : (sameWorkspace ? existing?.position : undefined) ?? node.position
        : node.position;
      const dimensionsMatch =
        existing?.measured?.width === node.measured?.width && existing?.measured?.height === node.measured?.height;
      return {
        ...node,
        ...(dimensionsMatch && existing?.measured ? { measured: existing.measured } : {}),
        position,
        selected: node.id === selectedFileId,
        data: { ...node.data, selected: node.id === selectedFileId },
      };
    });

    const resolved = graphNodeDragging.current
      ? next
      : separateOverlappingGraphNodes(next, {
          gap: compactGraph ? 12 : 16,
          anchorId: graphLayoutAnchor.current,
        });
    setNodes(resolved);
    if (!graphNodeDragging.current) {
      const adjusted = resolved.filter(
        (node, index) => node.position.x !== next[index].position.x || node.position.y !== next[index].position.y
      );
      if (adjusted.length)
        setNodePositions((previous) => {
          let changed = false;
          const updated = new Map(previous);
          for (const node of adjusted) {
            const key = `${workspaceId}:${node.id}`;
            const current = updated.get(key);
            if (current?.x === node.position.x && current?.y === node.position.y) continue;
            updated.set(key, node.position);
            changed = true;
          }
          return changed ? updated : previous;
        });
    }
    layoutOwner.current = { version: layoutVersion, repositoryId: workspaceId };
  }, [
    compactGraph,
    initialLayout,
    layoutVersion,
    nodePositions,
    repository.files,
    repository.id,
    selectedFileId,
    setNodes,
    workspaceId,
  ]);

  // Handle user dragging nodes
  const onNodesChange = useCallback(
    (changes: Parameters<typeof onNodesChangeBase>[0]) => {
      if (savedDataClearBusy) return;
      const positionChanges = changes.filter((change) => change.type === "position");
      const dragState = [...positionChanges].reverse().find((change) => typeof change.dragging === "boolean")?.dragging;
      if (typeof dragState === "boolean") graphNodeDragging.current = dragState;
      if (dragState === false) {
        const completedDrag = [...positionChanges].reverse().find((change) => change.dragging === false && change.position);
        if (completedDrag) graphLayoutAnchor.current = completedDrag.id;
      }
      for (const change of changes) {
        if (change.type === "position" && change.position) {
          setNodePositions((previous) => new Map(previous).set(`${workspaceId}:${change.id}`, change.position!));
          const positionsKey = nodePositionSessionKey(repository);
          if (desktopMode && !workspacePersistenceReadyKeys.has(positionsKey)) {
            const dirty = dirtyNodePositions.current.get(workspaceId) ?? new Set<string>();
            dirty.add(change.id);
            dirtyNodePositions.current.set(workspaceId, dirty);
          }
        }
      }
      onNodesChangeBase(changes);
    },
    [
      desktopMode,
      nodePositionSessionKey,
      onNodesChangeBase,
      repository,
      savedDataClearBusy,
      workspaceId,
      workspacePersistenceReadyKeys,
    ]
  );

  // Auto-save debounced node positions
  useEffect(() => {
    if (!desktopMode || savedDataClearBusy || repository.id === bootSnapshotId) return;
    const positionsKey = nodePositionSessionKey(repository);
    if (nodePositionsReadyKey !== positionsKey) return;
    const timer = window.setTimeout(() => {
      const positions = Object.fromEntries(
        [...nodePositions].flatMap(([key, point]) => {
          const prefix = `${workspaceId}:`;
          return key.startsWith(prefix) ? [[key.slice(prefix.length), point] as const] : [];
        })
      );
      const serialized = nodePositionSignature(positions);
      if (serialized === nodePositionsPersisted.current.get(positionsKey)) return;
      const save = enqueueWorkspacePersistence(workspaceId, async () => {
        if (!workspacePersistenceReadyKeys.has(positionsKey)) return;
        await localWorkspaceProvider.saveNodePositions(workspaceSession(repository), positions);
        nodePositionsPersisted.current.set(positionsKey, serialized);
        const currentPositions = Object.fromEntries(
          [...nodePositionsRef.current].flatMap(([key, point]) => {
            const prefix = `${workspaceId}:`;
            return key.startsWith(prefix) ? [[key.slice(prefix.length), point] as const] : [];
          })
        );
        if (nodePositionSignature(currentPositions) === serialized) dirtyNodePositions.current.delete(workspaceId);
      });
      void save.catch((error: Error) => {
        if (activeNodePositionKeyRef.current === positionsKey)
          onSetRepoMessage(`节点位置尚未保存到本地：${error.message}`);
      });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [
    bootSnapshotId,
    desktopMode,
    nodePositionSessionKey,
    nodePositionSignature,
    nodePositions,
    nodePositionsReadyKey,
    onSetRepoMessage,
    repository,
    repository.id,
    savedDataClearBusy,
    workspaceId,
    workspacePersistenceReadyKeys,
    workspaceSession,
  ]);

  return {
    nodes,
    setNodes,
    edges,
    onNodesChange,
    nodePositions,
    setNodePositions,
    nodePositionsRef,
    nodePositionsPersisted,
    dirtyNodePositions,
    pendingNodePositionRestore,
    nodePositionsReadyKey,
    setNodePositionsReadyKey,
    activeNodePositionKeyRef,
  };
}
