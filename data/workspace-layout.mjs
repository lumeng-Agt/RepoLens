export const DEFAULT_WORKSPACE_LAYOUT = Object.freeze({
  version: 1,
  structure: Object.freeze({ files: 22, graph: 48, details: 30 }),
  reading: Object.freeze({ files: 28, details: 72 }),
});

// Native-hidden Electron windows pause rAF even when visibilityState is visible.
// Preserve the two measurement turns, with a task fallback and cancellation.
export function afterLayoutMeasurements(callback, window = globalThis) {
  let cancelled = false;
  const cancellations = [];
  const next = action => {
    let frame = 0, timer = 0, completed = false;
    const cancel = () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
    const run = () => {
      if (completed || cancelled) return;
      completed = true;
      cancel();
      action();
    };
    frame = window.requestAnimationFrame(run);
    timer = window.setTimeout(run, 32);
    cancellations.push(cancel);
  };
  next(() => next(callback));
  return () => { cancelled = true; for (const cancel of cancellations) cancel(); };
}

/** Reapply preferences after the panel library has measured its new pixel limits. */
export function observeWorkspacePanelSizes(targets, window = globalThis) {
  const widths = new Map();
  const replays = new Map();
  const observer = new window.ResizeObserver(entries => {
    for (const entry of entries) {
      const apply = targets.get(entry.target);
      const width = entry.contentRect.width;
      if (!apply) continue;
      if (width <= 0) {
        widths.set(entry.target, 0);
        replays.get(entry.target)?.(); replays.delete(entry.target);
        continue;
      }
      if (Math.abs((widths.get(entry.target) ?? -1) - width) < 0.5) continue;
      widths.set(entry.target, width);
      replays.get(entry.target)?.();
      replays.set(entry.target, afterLayoutMeasurements(() => { replays.delete(entry.target); apply(); }, window));
    }
  });
  for (const element of targets.keys()) observer.observe(element);
  return () => { observer.disconnect(); for (const cancel of replays.values()) cancel(); replays.clear(); };
}

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
