export const DEFAULT_WORKSPACE_LAYOUT = Object.freeze({
  version: 1,
  structure: Object.freeze({ files: 22, graph: 48, details: 30 }),
  reading: Object.freeze({ files: 28, details: 72 }),
});

function normalizeParts(parts, keys) {
  if (!parts || typeof parts !== "object") return null;
  const values = keys.map((key) => parts[key]);
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 100)) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total < 1) return null;
  return Object.fromEntries(keys.map((key, index) => [key, Math.round(values[index] / total * 10_000) / 100]));
}

export function normalizeWorkspaceLayout(value) {
  if (!value || typeof value !== "object" || value.version !== 1) return null;
  const structure = normalizeParts(value.structure, ["files", "graph", "details"]);
  const reading = normalizeParts(value.reading, ["files", "details"]);
  return structure && reading ? { version: 1, structure, reading, ...(typeof value.chatWidth === "number" && Number.isFinite(value.chatWidth) && value.chatWidth >= 320 && value.chatWidth <= 800 ? { chatWidth: value.chatWidth } : {}) } : null;
}

export function workspaceOuterLayout(preferences, mode) {
  const value = normalizeWorkspaceLayout(preferences) ?? DEFAULT_WORKSPACE_LAYOUT;
  if (mode === "reading") return { files: value.reading.files, content: value.reading.details };
  return { files: value.structure.files, content: value.structure.graph + value.structure.details };
}

export function workspaceInnerLayout(preferences, mode) {
  const current = normalizeWorkspaceLayout(preferences) ?? DEFAULT_WORKSPACE_LAYOUT;
  if (mode === "reading") return { graph: 0, details: 100 };
  const content = current.structure.graph + current.structure.details;
  return normalizeParts({ graph: current.structure.graph / content * 100, details: current.structure.details / content * 100 }, ["graph", "details"]);
}

export function updateWorkspaceLayout(preferences, mode, area, layout) {
  const current = normalizeWorkspaceLayout(preferences) ?? DEFAULT_WORKSPACE_LAYOUT;
  const values = area === "outer"
    ? normalizeParts({ files: layout.files, content: layout.content }, ["files", "content"])
    : normalizeParts({ graph: layout.graph, details: layout.details }, ["graph", "details"]);
  if (!values) return current;
  if (mode === "reading") {
    if (area !== "outer") return current;
    return normalizeWorkspaceLayout({ ...current, reading: { files: values.files, details: values.content } }) ?? current;
  }
  if (area === "outer") {
    const previousContent = current.structure.graph + current.structure.details;
    return normalizeWorkspaceLayout({ ...current, structure: {
      files: values.files,
      graph: values.content * current.structure.graph / previousContent,
      details: values.content * current.structure.details / previousContent,
    } }) ?? current;
  }
  const content = current.structure.graph + current.structure.details;
  return normalizeWorkspaceLayout({ ...current, structure: {
    files: current.structure.files,
    graph: content * values.graph / 100,
    details: content * values.details / 100,
  } }) ?? current;
}
