import type { Page } from '@playwright/test';
import { graphNodesAreSeparated as checkSeparation, waitForStableGraphGeometry as waitForStable } from '../../scripts/graph-geometry.mjs';
import type { GraphGeometry } from '../../scripts/graph-geometry.mjs';

export type { GraphGeometry };

/** Wait for 24 fresh, consecutive frames with unchanged canvas and every graph node. */
export async function waitForStableGraphGeometry(page: Page, options?: {
  timeoutMs?: number;
  expectedNodeIds?: string[];
  minimumNodeCount?: number;
}): Promise<GraphGeometry> {
  return waitForStable(page, options);
}

export function graphNodesAreSeparated(geometry: GraphGeometry, gapInCanvasUnits = 16, epsilon = 0.5): boolean {
  return checkSeparation(geometry, gapInCanvasUnits, epsilon);
}

export function isGraphNodeWithinBounds(geometry: GraphGeometry, margin = 24, epsilon = 0.5): boolean {
  const { canvas, node } = geometry;
  return node.left >= canvas.left + margin - epsilon
    && node.top >= canvas.top + margin - epsilon
    && node.right <= canvas.right - margin + epsilon
    && node.bottom <= canvas.bottom - margin + epsilon;
}
