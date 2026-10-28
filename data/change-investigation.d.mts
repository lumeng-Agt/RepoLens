import type { RepositorySnapshot, RevisionComparison } from "./model";
export type ChangeCheck = { fileId: string; path: string; kind: "test" | "consumer"; reasons: string[]; dependencyPath: string[]; edgeIds: string[] };
export function suggestChangeChecks(snapshot: RepositorySnapshot, changes: RevisionComparison["files"]): { candidates: ChangeCheck[]; limitations: string[] };
