import { ReadingTourImportSchema } from "./local-contracts.mjs";

/** Display-only inspection: never normalize or write the record returned by storage. */
export function getReadingTourStatus(route, files) {
  if (!ReadingTourImportSchema.safeParse(route).success || !route.signature || !route.steps.length)
    return { state: "legacy", readable: false, editable: false };
  const references = new Set(route.steps.flatMap(step => [step.focusFileId, step.reference.fileId]));
  for (const step of route.sourceSteps ?? []) for (const reference of step.references) references.add(reference.fileId);
  const contexts = new Map(route.contextFiles.map(file => [file.fileId, file.contentHash]));
  if ([...references].some(id => !contexts.get(id))) return { state: "unknown", readable: false, editable: true };
  if (route.stale || route.contextFiles.some(context => !files.has(context.fileId) || files.get(context.fileId).contentHash !== context.contentHash))
    return { state: "stale", readable: false, editable: true };
  return { state: "current", readable: true, editable: true };
}
