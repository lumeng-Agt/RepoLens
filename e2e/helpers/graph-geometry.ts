import type { Page } from '@playwright/test';

export type GraphGeometry = {
  canvas: { left: number; top: number; right: number; bottom: number; width: number; height: number };
  node: { left: number; top: number; right: number; bottom: number; width: number; height: number };
  viewportTransform: string;
  viewport: { width: number; height: number };
};

/** Wait for 24 fresh, consecutive animation frames with unchanged graph geometry. */
export async function waitForStableGraphGeometry(page: Page, timeoutMs = 10_000): Promise<GraphGeometry> {
  return page.evaluate(({ timeoutMs: limit }) => new Promise<GraphGeometry>((resolve, reject) => {
    const rounded = (value: number) => Math.round(value * 1000) / 1000;
    let previous = '';
    let stableFrames = 0;
    const timeout = window.setTimeout(() => reject(new Error(`Graph geometry did not stabilize within ${limit}ms.`)), limit);

    const inspect = () => {
      const canvasElement = document.querySelector('.graph-canvas');
      const nodeElement = document.querySelector('.graph-file-card.is-selected');
      const viewportElement = document.querySelector('.react-flow__viewport') as HTMLElement | null;
      const canvasRect = canvasElement?.getBoundingClientRect();
      const nodeRect = nodeElement?.getBoundingClientRect();

      if (canvasRect && nodeRect && viewportElement && canvasRect.width > 0 && canvasRect.height > 0 && nodeRect.width > 0 && nodeRect.height > 0) {
        const canvas = {
          left: rounded(canvasRect.left), top: rounded(canvasRect.top), right: rounded(canvasRect.right), bottom: rounded(canvasRect.bottom),
          width: rounded(canvasRect.width), height: rounded(canvasRect.height),
        };
        const node = {
          left: rounded(nodeRect.left), top: rounded(nodeRect.top), right: rounded(nodeRect.right), bottom: rounded(nodeRect.bottom),
          width: rounded(nodeRect.width), height: rounded(nodeRect.height),
        };
        const viewportTransform = viewportElement.style.transform;
        const geometry: GraphGeometry = { canvas, node, viewportTransform, viewport: { width: innerWidth, height: innerHeight } };
        const signature = JSON.stringify(geometry);
        stableFrames = signature === previous ? stableFrames + 1 : 0;
        previous = signature;
        if (stableFrames >= 24) {
          clearTimeout(timeout);
          resolve(geometry);
          return;
        }
      } else {
        previous = '';
        stableFrames = 0;
      }

      requestAnimationFrame(inspect);
    };

    requestAnimationFrame(inspect);
  }), { timeoutMs });
}

export function isGraphNodeWithinBounds(geometry: GraphGeometry, margin = 24, epsilon = 0.5): boolean {
  const { canvas, node } = geometry;
  return node.left >= canvas.left + margin - epsilon
    && node.top >= canvas.top + margin - epsilon
    && node.right <= canvas.right - margin + epsilon
    && node.bottom <= canvas.bottom - margin + epsilon;
}
