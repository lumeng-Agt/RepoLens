/** Wait for all visible graph nodes, the canvas, and its viewport to stop moving. */
export async function waitForStableGraphGeometry(page, {
  timeoutMs = 10_000,
  expectedNodeIds = [],
  minimumNodeCount = 1,
} = {}) {
  return page.evaluate(({ limit, requiredNodeIds, minimumCount }) => new Promise((resolve, reject) => {
    let previous = "";
    let stableFrames = 0;
    let animationFrame = 0;
    const finish = (error, geometry) => {
      clearTimeout(timeout);
      if (animationFrame) cancelAnimationFrame(animationFrame);
      if (error) reject(error);
      else resolve(geometry);
    };
    const timeout = window.setTimeout(() => finish(new Error(`Graph geometry did not stabilize within ${limit}ms.`)), limit);

    const inspect = () => {
      const canvasElement = document.querySelector(".graph-canvas");
      const viewportElement = document.querySelector(".react-flow__viewport");
      const nodeElements = [...document.querySelectorAll(".react-flow__node")];
      const canvasRect = canvasElement?.getBoundingClientRect();
      const validNodes = nodeElements.length >= minimumCount
        && nodeElements.every((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });

      if (canvasRect && viewportElement && canvasRect.width > 0 && canvasRect.height > 0 && validNodes) {
        const rounded = (value) => Math.round(value * 1000) / 1000;
        const canvas = {
          left: rounded(canvasRect.left), top: rounded(canvasRect.top), right: rounded(canvasRect.right), bottom: rounded(canvasRect.bottom),
          width: rounded(canvasRect.width), height: rounded(canvasRect.height),
        };
        const nodes = nodeElements.map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            id: element.getAttribute("data-id") ?? "",
            left: rounded(rect.left), top: rounded(rect.top), right: rounded(rect.right), bottom: rounded(rect.bottom),
            width: rounded(rect.width), height: rounded(rect.height),
            selected: element.classList.contains("is-selected") || Boolean(element.querySelector(".graph-file-card.is-selected")),
          };
        }).sort((left, right) => left.id.localeCompare(right.id));
        const expectedPresent = requiredNodeIds.every((id) => nodes.some((node) => node.id === id));
        const viewportTransform = viewportElement.style.transform;
        const selected = nodes.find((node) => node.selected);

        if (expectedPresent && selected) {
          const geometry = { canvas, node: selected, nodes, viewportTransform, viewport: { width: innerWidth, height: innerHeight } };
          const signature = JSON.stringify(geometry);
          stableFrames = signature === previous ? stableFrames + 1 : 0;
          previous = signature;
          if (stableFrames >= 24) {
            finish(null, geometry);
            return;
          }
        } else {
          previous = "";
          stableFrames = 0;
        }
      } else {
        previous = "";
        stableFrames = 0;
      }

      animationFrame = requestAnimationFrame(inspect);
    };

    animationFrame = requestAnimationFrame(inspect);
  }), { limit: timeoutMs, requiredNodeIds: expectedNodeIds, minimumCount: minimumNodeCount });
}

export function graphNodesAreSeparated(geometry, gapInCanvasUnits = 16, epsilon = 0.5) {
  const scaleMatch = geometry.viewportTransform.match(/scale\(([-\d.]+)\)/);
  const scale = scaleMatch ? Number(scaleMatch[1]) : 1;
  const minimumGap = Math.max(0, gapInCanvasUnits * scale - epsilon);

  for (let leftIndex = 0; leftIndex < geometry.nodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < geometry.nodes.length; rightIndex += 1) {
      const left = geometry.nodes[leftIndex];
      const right = geometry.nodes[rightIndex];
      const horizontalGap = Math.max(right.left - left.right, left.left - right.right);
      const verticalGap = Math.max(right.top - left.bottom, left.top - right.bottom);
      if (horizontalGap < minimumGap && verticalGap < minimumGap) return false;
    }
  }
  return true;
}
