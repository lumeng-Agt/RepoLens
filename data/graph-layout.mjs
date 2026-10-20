/**
 * Nudge only colliding graph nodes, keeping the drag anchor and every
 * collision-free saved position unchanged.
 */
export function separateOverlappingGraphNodes(nodes, { gap = 16, width = 160, height = 68, anchorId } = {}) {
  if (nodes.length < 2) return nodes;

  const dimensions = (node) => ({
    width: node.measured?.width ?? node.width ?? width,
    height: node.measured?.height ?? node.height ?? height,
  });
  const overlaps = (position, size, other, otherPosition = other.position) => {
    const otherSize = dimensions(other);
    return !(position.x + size.width + gap <= otherPosition.x
      || otherPosition.x + otherSize.width + gap <= position.x
      || position.y + size.height + gap <= otherPosition.y
      || otherPosition.y + otherSize.height + gap <= position.y);
  };

  const byPosition = (left, right) => left.position.y - right.position.y
    || left.position.x - right.position.x
    || left.id.localeCompare(right.id);
  const anchor = nodes.find((node) => node.id === anchorId);
  let fixed;
  let moving;

  if (anchor) {
    const anchorSize = dimensions(anchor);
    fixed = [anchor, ...nodes.filter((node) => node !== anchor && !overlaps(anchor.position, anchorSize, node)).sort(byPosition)];
    moving = nodes.filter((node) => node !== anchor && !fixed.includes(node))
      .sort((left, right) => Math.hypot(left.position.x - anchor.position.x, left.position.y - anchor.position.y)
        - Math.hypot(right.position.x - anchor.position.x, right.position.y - anchor.position.y) || left.id.localeCompare(right.id));
  } else {
    const colliding = new Set();
    for (let left = 0; left < nodes.length; left += 1) {
      for (let right = left + 1; right < nodes.length; right += 1) {
        if (!overlaps(nodes[left].position, dimensions(nodes[left]), nodes[right])) continue;
        colliding.add(nodes[left]);
        colliding.add(nodes[right]);
      }
    }
    fixed = nodes.filter((node) => !colliding.has(node)).sort(byPosition);
    moving = nodes.filter((node) => colliding.has(node)).sort(byPosition);
  }

  const positions = new Map(fixed.map((node) => [node.id, node.position]));
  const placed = [...fixed];
  const movingPositions = new Map();

  for (const node of moving) {
    const origin = node.position;
    const size = dimensions(node);
    const stepX = size.width + gap;
    const stepY = size.height + gap;
    const furthestObstacle = placed.reduce((distance, other) => Math.max(
      distance,
      Math.abs(other.position.x - origin.x) / stepX,
      Math.abs(other.position.y - origin.y) / stepY,
    ), 0);
    const maxRing = Math.ceil(furthestObstacle) + placed.length + moving.length + 2;
    let position = placed.every((other) => !overlaps(origin, size, other, positions.get(other.id))) ? origin : undefined;

    for (let ring = 1; ring <= maxRing && !position; ring += 1) {
      const candidates = [];
      for (let xRing = -ring; xRing <= ring; xRing += 1) {
        for (let yRing = -ring; yRing <= ring; yRing += 1) {
          if (Math.max(Math.abs(xRing), Math.abs(yRing)) !== ring) continue;
          candidates.push({ x: origin.x + stepX * xRing, y: origin.y + stepY * yRing });
        }
      }
      candidates.sort((left, right) => {
        const leftDistance = (left.x - origin.x) ** 2 + (left.y - origin.y) ** 2;
        const rightDistance = (right.x - origin.x) ** 2 + (right.y - origin.y) ** 2;
        return leftDistance - rightDistance || left.y - right.y || left.x - right.x;
      });
      position = candidates.find((candidate) => placed.every((other) => !overlaps(candidate, size, other, positions.get(other.id))));
    }

    // A finite graph always has free grid cells outside its occupied bounds.
    if (!position) position = { x: origin.x, y: origin.y + stepY * (placed.length + 1) };
    positions.set(node.id, position);
    movingPositions.set(node.id, position);
    placed.push(node);
  }

  return nodes.map((node) => {
    const position = movingPositions.get(node.id) ?? node.position;
    return position.x === node.position.x && position.y === node.position.y ? node : { ...node, position };
  });
}
