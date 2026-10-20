import type { DependencyEdge, RepositorySnapshot } from "./model";
export function findDependencyPath(snapshot: RepositorySnapshot, fromFileId: string, toFileId: string, direction?: "imports" | "imported-by"): { status: "found"; files: string[]; edges: { edge: DependencyEdge; from: string; to: string }[] } | { status: "not-found" | "missing" };
export function findPotentialImpact(snapshot: RepositorySnapshot, fileId: string): { edge: DependencyEdge; from: string; to: string }[];
export function findCycleForFile(snapshot: RepositorySnapshot, fileId: string): DependencyEdge[];
