import test from "node:test";
import assert from "node:assert/strict";
import { separateOverlappingGraphNodes } from "./graph-layout.mjs";

function collides(left, right, gap = 16) {
  const leftWidth = left.measured?.width ?? left.width ?? 160;
  const rightWidth = right.measured?.width ?? right.width ?? 160;
  const leftHeight = left.measured?.height ?? left.height ?? 68;
  const rightHeight = right.measured?.height ?? right.height ?? 68;
  return !(left.position.x + leftWidth + gap <= right.position.x
    || right.position.x + rightWidth + gap <= left.position.x
    || left.position.y + leftHeight + gap <= right.position.y
    || right.position.y + rightHeight + gap <= left.position.y);
}

test("graph collision repair preserves a separated layout exactly", () => {
  const nodes = [
    { id: "entry.ts", selected: true, position: { x: 0, y: 0 } },
    { id: "service.ts", position: { x: 220, y: 0 } },
    { id: "model.ts", position: { x: 220, y: 100 } },
  ];

  assert.deepEqual(separateOverlappingGraphNodes(nodes), nodes);
});

test("restored collision repair is deterministic and does not prioritize the selected node", () => {
  const nodes = [
    { id: "seed.ts", position: { x: 260, y: 44 } },
    { id: "taskService.ts", selected: true, position: { x: 260, y: 100 } },
    { id: "useTasks.ts", position: { x: 0, y: 100 } },
  ];

  const repaired = separateOverlappingGraphNodes(nodes);
  const byId = new Map(repaired.map((node) => [node.id, node]));

  assert.deepEqual(byId.get("seed.ts").position, { x: 260, y: 44 });
  assert.deepEqual(byId.get("taskService.ts").position, { x: 260, y: 184 });
  assert.deepEqual(byId.get("useTasks.ts").position, { x: 0, y: 100 });
  for (let left = 0; left < repaired.length; left += 1) {
    for (let right = left + 1; right < repaired.length; right += 1) {
      assert.equal(collides(repaired[left], repaired[right]), false, `${repaired[left].id} overlaps ${repaired[right].id}`);
    }
  }
});

test("graph collision repair is deterministic and respects measured node sizes", () => {
  const nodes = [
    { id: "a.ts", selected: true, measured: { width: 180, height: 76 }, position: { x: 100, y: 100 } },
    { id: "b.ts", measured: { width: 180, height: 76 }, position: { x: 100, y: 158 } },
  ];

  const first = separateOverlappingGraphNodes(nodes);
  const second = separateOverlappingGraphNodes(nodes);
  assert.deepEqual(first, second);
  assert.equal(collides(first[0], first[1]), false);
});

test("graph collision repair keeps the most recently dragged node fixed", () => {
  const nodes = [
    { id: "a.ts", selected: true, position: { x: 0, y: 0 } },
    { id: "b.ts", position: { x: 0, y: 20 } },
  ];
  const resolved = separateOverlappingGraphNodes(nodes, { anchorId: "b.ts" });
  const byId = new Map(resolved.map((node) => [node.id, node]));
  assert.deepEqual(byId.get("b.ts").position, { x: 0, y: 20 });
  assert.notDeepEqual(byId.get("a.ts").position, { x: 0, y: 0 });
  assert.equal(collides(byId.get("a.ts"), byId.get("b.ts")), false);
});

test("drag collision leaves an unrelated neighboring node in place", () => {
  const nodes = [
    { id: "dragged.ts", position: { x: 0, y: 0 } },
    { id: "collision.ts", selected: true, position: { x: 0, y: 0 } },
    { id: "neighbor.ts", position: { x: 0, y: -84 } },
  ];

  const repaired = separateOverlappingGraphNodes(nodes, { anchorId: "dragged.ts" });
  const byId = new Map(repaired.map((node) => [node.id, node]));

  assert.deepEqual(byId.get("dragged.ts").position, { x: 0, y: 0 });
  assert.deepEqual(byId.get("neighbor.ts").position, { x: 0, y: -84 });
  assert.deepEqual(byId.get("collision.ts").position, { x: 0, y: 84 });
  for (let left = 0; left < repaired.length; left += 1) {
    for (let right = left + 1; right < repaired.length; right += 1) {
      assert.equal(collides(repaired[left], repaired[right]), false, `${repaired[left].id} overlaps ${repaired[right].id}`);
    }
  }
});

test("collision repair does not let file selection change placement priority", () => {
  const nodes = [
    { id: "a.ts", selected: true, position: { x: 0, y: 0 } },
    { id: "b.ts", position: { x: 0, y: 0 } },
    { id: "c.ts", position: { x: 0, y: 0 } },
  ];
  const flippedSelection = nodes.map((node) => ({ ...node, selected: !node.selected }));

  const first = separateOverlappingGraphNodes(nodes);
  const second = separateOverlappingGraphNodes(flippedSelection);
  assert.deepEqual(first.map(({ id, position }) => [id, position]), second.map(({ id, position }) => [id, position]));
  for (let left = 0; left < first.length; left += 1) {
    for (let right = left + 1; right < first.length; right += 1) {
      assert.equal(collides(first[left], first[right]), false, `${first[left].id} overlaps ${first[right].id}`);
    }
  }
});

test("dense collision repair is deterministic and preserves every non-colliding node", () => {
  const nodes = Array.from({ length: 24 }, (_, index) => ({
    id: `collision-${index.toString().padStart(2, "0")}.ts`,
    position: { x: 0, y: 0 },
  }));
  nodes.push({ id: "untouched.ts", position: { x: 900, y: 900 } });

  const first = separateOverlappingGraphNodes(nodes);
  const second = separateOverlappingGraphNodes(nodes);
  const byId = new Map(first.map((node) => [node.id, node]));

  assert.deepEqual(first, second);
  assert.deepEqual(byId.get("untouched.ts").position, { x: 900, y: 900 });
  for (let left = 0; left < first.length; left += 1) {
    for (let right = left + 1; right < first.length; right += 1) {
      assert.equal(collides(first[left], first[right]), false, `${first[left].id} overlaps ${first[right].id}`);
    }
  }
});
