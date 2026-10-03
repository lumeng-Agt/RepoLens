/** @param {import("../components/repolens/AiResultView").AiResultRecord | null} result @param {import("./model").RepositorySnapshot} snapshot */
export function aiResultIsStale(result, snapshot) {
  if (!result || result.__repositoryId !== snapshot.id) return false;
  const contexts = Array.isArray(result.__contextFiles) ? result.__contextFiles : [];
  if (!contexts.length) return result.__revision !== snapshot.revision;
  return aiContextIsStale(contexts, snapshot);
}

/** @param {{fileId:string,contentHash:string}[]} contexts @param {import("./model").RepositorySnapshot} snapshot */
export function aiContextIsStale(contexts, snapshot) {
  const current = new Map(snapshot.files.map((file) => [file.id, file.contentHash ?? ""]));
  return contexts.some((file) => !current.has(file.fileId) || current.get(file.fileId) !== file.contentHash);
}

/** @param {import("../components/repolens/AiResultView").AiResultRecord | null} result @param {string} repositoryId */
export function aiRouteStepsFromResult(result, repositoryId) {
  if (!result || result.__repositoryId !== repositoryId || result.__mode !== "route" || !Array.isArray(result.__routeSteps)) return null;
  return result.__routeSteps;
}
