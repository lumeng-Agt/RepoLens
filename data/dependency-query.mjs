function graphFor(snapshot, direction = "imports") {
  const reverse = direction === "imported-by";
  const adjacency = new Map(snapshot.files.map((file) => [file.id, []]));
  for (const edge of snapshot.dependencies) {
    const from = reverse ? edge.toId : edge.fromId;
    const to = reverse ? edge.fromId : edge.toId;
    if (!adjacency.has(from) || !adjacency.has(to)) continue;
    adjacency.get(from).push({ edge, from, to });
  }
  for (const values of adjacency.values()) values.sort((a, b) => a.to.localeCompare(b.to) || a.edge.id.localeCompare(b.edge.id));
  return adjacency;
}

export function findDependencyPath(snapshot, fromFileId, toFileId, direction = "imports") {
  if (!snapshot.files.some((file) => file.id === fromFileId) || !snapshot.files.some((file) => file.id === toFileId)) return { status: "missing" };
  if (fromFileId === toFileId) return { status: "found", files: [fromFileId], edges: [] };
  const adjacency = graphFor(snapshot, direction);
  const queue = [fromFileId];
  const previous = new Map([[fromFileId, null]]);
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
    const current = queue[queueIndex];
    for (const link of adjacency.get(current) ?? []) {
      if (previous.has(link.to)) continue;
      previous.set(link.to, { fileId: current, link });
      if (link.to === toFileId) {
        const edges = []; const files = [toFileId]; let cursor = toFileId;
        while (cursor !== fromFileId) { const item = previous.get(cursor); edges.push(item.link); files.push(item.fileId); cursor = item.fileId; }
        return { status: "found", files: files.reverse(), edges: edges.reverse() };
      }
      queue.push(link.to);
    }
  }
  return { status: "not-found" };
}

export function findPotentialImpact(snapshot, fileId) {
  const adjacency = graphFor(snapshot, "imported-by");
  if (!adjacency.has(fileId)) return [];
  const queue = [fileId]; const visited = new Set([fileId]); const links = [];
  while (queue.length) {
    const current = queue.shift();
    for (const link of adjacency.get(current) ?? []) {
      if (visited.has(link.to)) continue;
      visited.add(link.to); queue.push(link.to); links.push(link);
    }
  }
  return links;
}

export function findCycleForFile(snapshot, fileId) {
  const adjacency = graphFor(snapshot, "imports");
  if (!adjacency.has(fileId)) return [];
  const visited = new Set(); const order = [];
  for (const start of adjacency.keys()) {
    if (visited.has(start)) continue;
    visited.add(start); const stack = [{ node: start, index: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1]; const links = adjacency.get(frame.node) ?? [];
      if (frame.index < links.length) {
        const target = links[frame.index++].to;
        if (!visited.has(target)) { visited.add(target); stack.push({ node: target, index: 0 }); }
      } else { order.push(frame.node); stack.pop(); }
    }
  }
  const reverse = new Map([...adjacency.keys()].map((id) => [id, []]));
  for (const [from, links] of adjacency) for (const link of links) reverse.get(link.to)?.push(from);
  const assigned = new Set(); let component = [];
  for (let index = order.length - 1; index >= 0; index--) {
    const start = order[index]; if (assigned.has(start)) continue;
    const members = []; const stack = [start]; assigned.add(start);
    while (stack.length) { const node = stack.pop(); members.push(node); for (const target of reverse.get(node) ?? []) if (!assigned.has(target)) { assigned.add(target); stack.push(target); } }
    if (members.includes(fileId)) { component = members; break; }
  }
  if (component.length === 1 && !(adjacency.get(fileId) ?? []).some((link) => link.to === fileId)) return [];
  const members = new Set(component);
  return snapshot.dependencies.filter((edge) => members.has(edge.fromId) && members.has(edge.toId)).sort((a, b) => a.fromId.localeCompare(b.fromId) || a.toId.localeCompare(b.toId) || a.reference.line - b.reference.line);
}
