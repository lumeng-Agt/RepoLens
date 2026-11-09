function keyedRecords(kind, records) {
  const result = new Map();
  const occurrences = new Map();
  for (const record of records) {
    const id = kind === "notes" ? record.id : record.signature;
    if (typeof id === "string") { result.set(id, record); continue; }
    // Opaque legacy records keep their raw data and multiplicity; do not invent persisted ids.
    const base = `\0legacy:${JSON.stringify(record)}`;
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    result.set(`${base}:${occurrence}`, record);
  }
  return result;
}

function equalRecord(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createReadingArtifactJournal() {
  return { sequence: 0, notes: new Map(), tours: new Map() };
}

export function stageReadingArtifactChanges(journal, kind, before, after) {
  if (kind !== "notes" && kind !== "tours") throw new Error("Unknown reading artifact kind.");
  const next = { ...journal, [kind]: new Map(journal[kind]) };
  const oldById = keyedRecords(kind, before);
  const newById = keyedRecords(kind, after);
  for (const [key, value] of oldById) {
    if (!newById.has(key)) next[kind].set(key, { sequence: ++next.sequence, operation: "delete" });
    else if (!equalRecord(value, newById.get(key))) next[kind].set(key, { sequence: ++next.sequence, operation: "upsert", value: newById.get(key) });
  }
  for (const [key, value] of newById) {
    if (!oldById.has(key)) next[kind].set(key, { sequence: ++next.sequence, operation: "upsert", value });
  }
  return next;
}

export function applyReadingArtifactJournal(records, journal, kind) {
  const merged = keyedRecords(kind, records);
  for (const [key, entry] of [...journal[kind]].sort((left, right) => left[1].sequence - right[1].sequence)) {
    if (entry.operation === "delete") merged.delete(key);
    else {
      merged.delete(key);
      merged.set(key, entry.value);
    }
  }
  return [...merged.values()];
}

export function readingArtifactJournalCheckpoint(journal) {
  return journal.sequence;
}

export function acknowledgeReadingArtifactJournal(journal, kind, checkpoint) {
  if (kind !== "notes" && kind !== "tours") throw new Error("Unknown reading artifact kind.");
  const next = { ...journal, notes: new Map(journal.notes), tours: new Map(journal.tours) };
  for (const [key, entry] of next[kind]) if (entry.sequence <= checkpoint) next[kind].delete(key);
  return next;
}

export function hasReadingArtifactOperations(journal, kind) {
  return kind ? journal[kind].size > 0 : journal.notes.size > 0 || journal.tours.size > 0;
}
