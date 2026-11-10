import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { ReactFlowInstance } from "@xyflow/react";
import type { GraphNode } from "@/components/repolens/GraphPanel";
import type { RepositorySnapshot } from "@/data/model";

interface GraphViewportOptions {
  repository: RepositorySnapshot;
  selectedFileId: string;
  graphCanMount: boolean;
  showGuideWelcome: boolean;
  compactGraph: boolean;
  setCompactGraph: Dispatch<SetStateAction<boolean>>;
}

export function useGraphViewport({ repository, selectedFileId, graphCanMount, showGuideWelcome, compactGraph, setCompactGraph }: GraphViewportOptions) {
  const compactGraphRef = useRef(compactGraph);
  useLayoutEffect(() => { compactGraphRef.current = compactGraph; }, [compactGraph]);
  const [flow, setFlow] = useState<ReactFlowInstance<GraphNode> | null>(null);
  const graphCanvasRef = useRef<HTMLDivElement>(null);
  const [graphReady, setGraphReady] = useState(false);
  const [graphSizeRevision, setGraphSizeRevision] = useState(0);
  const graphResizeRequest = useRef(0);
  const graphFocusRequest = useRef(0);
  const graphSizeRef = useRef({ width: 0, height: 0 });

  useEffect(() => {
    const canvas = graphCanvasRef.current;
    if (!canvas) return;
    let frame = 0;
    let pendingSize = { width: 0, height: 0 };
    let stableFrames = 0;
    const measureGraphSize = () => {
      frame = 0;
      const bounds = canvas.getBoundingClientRect();
      const previous = graphSizeRef.current;
      if (bounds.width <= 0 || bounds.height <= 0) {
        pendingSize = { width: 0, height: 0 };
        stableFrames = 0;
        if (previous.width > 0 || previous.height > 0) {
          graphSizeRef.current = { width: 0, height: 0 };
          setGraphReady(false);
        }
        return;
      }
      const matchesPending = Math.abs(pendingSize.width - bounds.width) < 1 && Math.abs(pendingSize.height - bounds.height) < 1;
      stableFrames = matchesPending ? stableFrames + 1 : 0;
      pendingSize = { width: bounds.width, height: bounds.height };
      if (stableFrames < 2) {
        frame = requestAnimationFrame(measureGraphSize);
        return;
      }
      const changed = Math.abs(previous.width - bounds.width) >= 1 || Math.abs(previous.height - bounds.height) >= 1;
      if (changed) {
        graphSizeRef.current = { width: bounds.width, height: bounds.height };
        setGraphSizeRevision((revision) => revision + 1);
      }
      setGraphReady(true);
      setCompactGraph((value) => value === (bounds.width <= 480) ? value : bounds.width <= 480);
    };
    const updateGraphSize = () => {
      if (frame) cancelAnimationFrame(frame);
      stableFrames = 0;
      frame = requestAnimationFrame(measureGraphSize);
    };
    updateGraphSize();
    const observer = new ResizeObserver(updateGraphSize);
    observer.observe(canvas);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [showGuideWelcome, setCompactGraph]);

  const focusGraphFile = useCallback((fileId: string) => {
    const request = ++graphFocusRequest.current;
    let attempts = 0;
    const locate = () => {
      if (request !== graphFocusRequest.current) return;
      const canvas = graphCanvasRef.current;
      const bounds = canvas?.getBoundingClientRect();
      const allNodes = flow?.getNodes() ?? [];
      const selected = allNodes.find((node) => node.id === fileId);
      const selectedWidth = selected?.measured?.width ?? selected?.width;
      const selectedHeight = selected?.measured?.height ?? selected?.height;
      if (!flow || !bounds || bounds.width <= 0 || bounds.height <= 0 || !selected || !selectedWidth || !selectedHeight) {
        if (attempts++ < 120) requestAnimationFrame(locate);
        return;
      }
      const adjacent = repository.dependencies.filter((edge) => edge.fromId === fileId || edge.toId === fileId).flatMap((edge) => [edge.fromId, edge.toId]);
      const ids = new Set([fileId, ...adjacent]);
      const dimensions = (node: GraphNode) => ({
        x: node.position.x,
        y: node.position.y,
        width: node.measured?.width ?? node.width ?? (compactGraphRef.current ? 140 : 160),
        height: node.measured?.height ?? node.height ?? (compactGraphRef.current ? 60 : 68),
      });
      const isFiniteBox = (box: ReturnType<typeof dimensions>) => [box.x, box.y, box.width, box.height].every(Number.isFinite) && box.width > 0 && box.height > 0;
      if (!isFiniteBox(dimensions(selected))) {
        if (attempts++ < 120) requestAnimationFrame(locate);
        return;
      }
      const boxFor = (targets: GraphNode[]) => {
        const values = targets.map(dimensions);
        const left = Math.min(...values.map((value) => value.x));
        const top = Math.min(...values.map((value) => value.y));
        const right = Math.max(...values.map((value) => value.x + value.width));
        const bottom = Math.max(...values.map((value) => value.y + value.height));
        return { x: (left + right) / 2, y: (top + bottom) / 2, width: right - left, height: bottom - top };
      };
      const neighbors = allNodes.filter((node) => node.id !== fileId && ids.has(node.id) && isFiniteBox(dimensions(node)));
      let targets = [selected, ...neighbors];
      let box = boxFor(targets);
      const fitZoom = Math.min((bounds.width - 48) / box.width, (bounds.height - 48) / box.height);
      if (fitZoom < 0.85 && neighbors.length) { targets = [selected]; box = boxFor(targets); }
      if (!Number.isFinite(box.x) || !Number.isFinite(box.y) || !Number.isFinite(box.width) || !Number.isFinite(box.height) || box.width <= 0 || box.height <= 0) {
        box = boxFor([selected]);
        targets = [selected];
      }
      const requestedZoom = Math.min(bounds.width - 48, bounds.height - 48) > 0 ? Math.min((bounds.width - 48) / box.width, (bounds.height - 48) / box.height) : 0.85;
      const zoom = Number.isFinite(requestedZoom) ? Math.max(0.85, Math.min(1.25, requestedZoom)) : 0.85;
      if (!Number.isFinite(box.x) || !Number.isFinite(box.y)) return;
      flow.setCenter(box.x, box.y, { zoom, duration: 0 });
    };
    requestAnimationFrame(locate);
  }, [flow, repository.dependencies]);

  useEffect(() => {
    if (!graphSizeRevision || !graphCanMount || !flow || !selectedFileId) return;
    const request = ++graphResizeRequest.current;
    let frame = 0;
    let attempts = 0;
    let lastViewport: { x: number; y: number; zoom: number } | null = null;
    let stableViewportFrames = 0;
    const preserveVisibleNode = () => {
      if (request !== graphResizeRequest.current) return;
      const canvas = graphCanvasRef.current;
      const bounds = canvas?.getBoundingClientRect();
      const nodeElement = canvas && [...canvas.querySelectorAll<HTMLElement>(".react-flow__node")].find((node) => node.dataset.id === selectedFileId);
      const nodeBounds = nodeElement?.getBoundingClientRect();
      if (!bounds || !nodeBounds || bounds.width <= 0 || bounds.height <= 0 || nodeBounds.width <= 0 || nodeBounds.height <= 0) {
        if (attempts++ < 120) frame = requestAnimationFrame(preserveVisibleNode);
        return;
      }
      const currentViewport = flow.getViewport();
      if (lastViewport && Math.abs(lastViewport.x - currentViewport.x) < 0.01 && Math.abs(lastViewport.y - currentViewport.y) < 0.01 && Math.abs(lastViewport.zoom - currentViewport.zoom) < 0.0001) {
        stableViewportFrames += 1;
      } else {
        stableViewportFrames = 0;
      }
      lastViewport = currentViewport;
      if (stableViewportFrames < 3) {
        if (attempts++ < 120) frame = requestAnimationFrame(preserveVisibleNode);
        return;
      }
      const margin = 24;
      const width = bounds.width - margin * 2;
      const height = bounds.height - margin * 2;
      if (nodeBounds.width > width || nodeBounds.height > height) {
        focusGraphFile(selectedFileId);
        return;
      }
      const deltaX = nodeBounds.left < bounds.left + margin
        ? bounds.left + margin - nodeBounds.left
        : nodeBounds.right > bounds.right - margin ? bounds.right - margin - nodeBounds.right : 0;
      const deltaY = nodeBounds.top < bounds.top + margin
        ? bounds.top + margin - nodeBounds.top
        : nodeBounds.bottom > bounds.bottom - margin ? bounds.bottom - margin - nodeBounds.bottom : 0;
      if (deltaX || deltaY) {
        flow.setViewport({ ...currentViewport, x: currentViewport.x + deltaX, y: currentViewport.y + deltaY }, { duration: 0 });
      }
    };
    frame = requestAnimationFrame(preserveVisibleNode);
    return () => {
      graphResizeRequest.current += 1;
      cancelAnimationFrame(frame);
    };
  }, [flow, graphCanMount, graphSizeRevision, selectedFileId, focusGraphFile]);

  useEffect(() => {
    if (flow && selectedFileId) focusGraphFile(selectedFileId);
  }, [flow, selectedFileId, repository.revision, focusGraphFile]);
  useEffect(() => {
    if (graphCanMount) return;
    graphFocusRequest.current += 1;
  }, [graphCanMount]);
  return { flow, setFlow, graphCanvasRef, graphReady, focusGraphFile };
}
