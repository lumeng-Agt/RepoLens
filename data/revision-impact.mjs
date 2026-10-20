const normalized = (value) => String(value ?? "").replaceAll("\\", "/").replace(/^\.\//, "");

/** Find saved reading records whose recorded source files changed in a revision comparison. */
export function findRevisionImpacts({ changes, files, notes = [], tours = [], results = [] }) {
  const changedPaths = new Set(changes.flatMap((item) => [item.path, item.oldPath].filter(Boolean).map(normalized)));
  const fileById = new Map(files.map((file) => [file.id, file]));
  const overlaps = (ids = [], paths = []) => {
    const knownPaths = [...ids].map((id) => normalized(fileById.get(id)?.path ?? id));
    return [...new Set([...paths.map(normalized), ...knownPaths].filter((path) => changedPaths.has(path)))].sort();
  };
  const noteImpacts = notes.flatMap((note) => {
    const paths = overlaps([note.fileId], [note.path]);
    return paths.length ? [{ kind: "note", id: note.id, title: note.text, fileId: note.fileId, paths }] : [];
  });
  const tourImpacts = tours.flatMap((tour) => {
    const ids = [...new Set([...(tour.contextFiles ?? []).map((item) => item.fileId), ...(tour.steps ?? []).flatMap((step) => [step.focusFileId, step.reference?.fileId])])];
    const paths = overlaps(ids);
    return paths.length ? [{ kind: "tour", id: tour.signature, title: tour.title, fileId: tour.entryFileId, paths }] : [];
  });
  const resultImpacts = results.flatMap((result, index) => {
    const ids = [...new Set([result.__entryFileId, ...(result.__contextFiles ?? []).map((item) => item.fileId)].filter(Boolean))];
    const paths = overlaps(ids);
    return paths.length ? [{ kind: "result", id: `${result.__entryFileId ?? "result"}:${index}`, title: String(result.role ?? result.title ?? result.answer ?? "AI 讲解").slice(0, 100), fileId: result.__entryFileId, paths }] : [];
  });
  return { notes: noteImpacts, tours: tourImpacts, results: resultImpacts, total: noteImpacts.length + tourImpacts.length + resultImpacts.length };
}
