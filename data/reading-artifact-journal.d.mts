export type ReadingArtifactJournal<TNote = unknown, TTour = unknown> = {
  sequence: number;
  notes: Map<string, { sequence: number; operation: "delete" } | { sequence: number; operation: "upsert"; value: TNote }>;
  tours: Map<string, { sequence: number; operation: "delete" } | { sequence: number; operation: "upsert"; value: TTour }>;
};
export function createReadingArtifactJournal<TNote = unknown, TTour = unknown>(): ReadingArtifactJournal<TNote, TTour>;
export function stageReadingArtifactChanges<TNote, TTour>(journal: ReadingArtifactJournal<TNote, TTour>, kind: "notes" | "tours", before: (TNote | TTour)[], after: (TNote | TTour)[]): ReadingArtifactJournal<TNote, TTour>;
export function applyReadingArtifactJournal<TNote, TTour>(records: TNote[], journal: ReadingArtifactJournal<TNote, TTour>, kind: "notes"): TNote[];
export function applyReadingArtifactJournal<TNote, TTour>(records: TTour[], journal: ReadingArtifactJournal<TNote, TTour>, kind: "tours"): TTour[];
export function readingArtifactJournalCheckpoint<TNote, TTour>(journal: ReadingArtifactJournal<TNote, TTour>): number;
export function acknowledgeReadingArtifactJournal<TNote, TTour>(journal: ReadingArtifactJournal<TNote, TTour>, kind: "notes" | "tours", checkpoint: number): ReadingArtifactJournal<TNote, TTour>;
export function hasReadingArtifactOperations<TNote, TTour>(journal: ReadingArtifactJournal<TNote, TTour>, kind?: "notes" | "tours"): boolean;
