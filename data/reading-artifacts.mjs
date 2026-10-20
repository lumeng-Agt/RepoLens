import { createAiRouteRecord } from "./ai-route.mjs";

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().filter((key) => key !== "stale").map((key) => [key, stableValue(value[key])]));
}

function sameValue(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function sameRouteContent(left, right) {
  return sameValue({ title: left.title, goal: left.goal, steps: routeSteps(left) }, { title: right.title, goal: right.goal, steps: routeSteps(right) });
}

export function readingArtifactConflictFingerprint(existingNotes, incomingNotes, existingTours, incomingTours) {
  const noteConflicts = incomingNotes.flatMap((incoming) => {
    const collision = existingNotes.find((item) => item.id === incoming.id);
    return collision && !sameValue(collision, incoming) ? [[incoming.id, stableValue(collision), stableValue(incoming)]] : [];
  });
  const tourConflicts = incomingTours.flatMap((incoming) => {
    const collision = existingTours.find((item) => item.signature === incoming.signature);
    return collision && !sameRouteContent(collision, incoming) ? [[incoming.signature, stableValue(collision), stableValue(incoming)]] : [];
  });
  return JSON.stringify({ notes: noteConflicts, tours: tourConflicts });
}

export function mergeReadingNotes(existing, incoming, createId = () => globalThis.crypto.randomUUID()) {
  const result = [...existing];
  let added = 0;
  let skipped = 0;
  let conflicts = 0;
  for (const note of incoming) {
    const collision = result.find((item) => item.id === note.id);
    if (collision && sameValue(collision, note)) { skipped += 1; continue; }
    const copy = collision ? { ...note, id: createId() } : note;
    if (collision) conflicts += 1;
    result.push(copy);
    added += 1;
  }
  return { records: result, added, skipped, conflicts };
}

function routeSteps(route) {
  if (Array.isArray(route.sourceSteps) && route.sourceSteps.length) return route.sourceSteps;
  return (route.steps ?? []).map((step) => ({
    fileId: step.focusFileId,
    purpose: step.description,
    ...(step.relationship ? { relationship: step.relationship } : {}),
    ...(step.question ? { question: step.question } : {}),
    references: [{ fileId: step.reference.fileId, startLine: step.reference.line, ...(step.reference.endLine ? { endLine: step.reference.endLine } : {}) }],
  }));
}

export function mergeSavedTours(existing, incoming) {
  const result = [...existing];
  let added = 0;
  let skipped = 0;
  let conflicts = 0;
  for (const route of incoming) {
    const collision = result.find((item) => item.signature === route.signature);
    if (collision && sameRouteContent(collision, route)) { skipped += 1; continue; }
    let copy = route;
    if (collision) {
      conflicts += 1;
      const title = `${route.title}（导入副本）`;
      copy = createAiRouteRecord({
        repositoryId: route.repositoryId,
        entryFileId: routeSteps(route)[0]?.fileId ?? route.entryFileId,
        revision: route.revision,
        title,
        goal: route.goal,
        steps: routeSteps(route),
        contextFiles: route.contextFiles ?? [],
      });
      let suffix = 2;
      while (result.some((item) => item.signature === copy.signature)) {
        copy = createAiRouteRecord({ ...copy, title: `${title} ${suffix++}` , steps: routeSteps(route) });
      }
      if (route.stale) copy.stale = true;
    }
    if (result.some((item) => item.signature === copy.signature && sameRouteContent(item, copy))) { skipped += 1; continue; }
    result.push(copy);
    added += 1;
  }
  return { records: result, added, skipped, conflicts };
}

export function isReadingRangeValid(lineCount, startLine, endLine) {
  return Number.isInteger(lineCount) && lineCount > 0 && Number.isInteger(startLine) && startLine >= 1 && startLine <= lineCount && (endLine === undefined || (Number.isInteger(endLine) && endLine >= startLine && endLine <= lineCount));
}
