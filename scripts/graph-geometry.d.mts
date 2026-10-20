import type { Page } from "@playwright/test";

export type GraphNodeGeometry = {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  selected: boolean;
};

export type GraphGeometry = {
  canvas: { left: number; top: number; right: number; bottom: number; width: number; height: number };
  node: GraphNodeGeometry;
  nodes: GraphNodeGeometry[];
  viewportTransform: string;
  viewport: { width: number; height: number };
};

export function waitForStableGraphGeometry(page: Page, options?: {
  timeoutMs?: number;
  expectedNodeIds?: string[];
  minimumNodeCount?: number;
}): Promise<GraphGeometry>;

export function graphNodesAreSeparated(geometry: GraphGeometry, gapInCanvasUnits?: number, epsilon?: number): boolean;
