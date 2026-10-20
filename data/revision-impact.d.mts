import type { AiRouteRecord, AiSavedResult, FileRecord, ReadingNote, RevisionComparison } from "./model";

export function findRevisionImpacts(input: {
  changes: RevisionComparison["files"];
  files: Pick<FileRecord, "id" | "path">[];
  notes?: ReadingNote[];
  tours?: AiRouteRecord[];
  results?: AiSavedResult[];
}): {
  notes: { kind: "note"; id: string; title: string; fileId: string; paths: string[] }[];
  tours: { kind: "tour"; id: string; title: string; fileId: string; paths: string[] }[];
  results: { kind: "result"; id: string; title: string; fileId?: string; paths: string[] }[];
  total: number;
};
