export type SourceReference = {
  fileId: string;
  line: number;
  endLine?: number;
};

export type InvestigationEvidenceKind = "static-dependency" | "retrieval-match" | "model-inference";
export type InvestigationItem = { id: string; title: string; responsibility: string; reason: string; basis?: InvestigationEvidenceKind; contextFiles?: { fileId: string; contentHash: string; startLine: number; endLine: number }[]; references: { fileId: string; startLine: number; endLine?: number }[] };
export type InvestigationResult = { summary: string; items: InvestigationItem[]; questions: { question: string; suggestedFileId?: string }[] };
export type Investigation = InvestigationResult & {
  id: string; title: string; question: string; workspaceId: string; repositoryName: string; ref?: string; commit?: string;
  excludedFileIds: string[]; verifiedItemIds: string[]; checks?: Record<string, "pending" | "checked" | "irrelevant">;
  contextFiles: { fileId: string; contentHash: string; startLine: number; endLine: number }[];
  selectionReasons?: Record<string, string[]>; createdAt: number; updatedAt: number; [key: string]: unknown;
};

export type ImportRecord = {
  targetPath: string;
  specifier: string;
  resolution?: "file" | "package";
};

export type SymbolDetail = { name: string; kind: "function" | "class" | "interface" | "type" | "enum" | "method"; startLine: number; endLine: number };

export type FileRecord = {
  id: string;
  path: string;
  name: string;
  kind: "typescript" | "style" | "python" | "go";
  role?: string;
  summary?: string;
  source?: string;
  language?: string;
  contentHash?: string;
  symbols?: string[];
  symbolDetails?: SymbolDetail[];
  imports: ImportRecord[];
};

export type DependencyEdge = {
  id: string;
  fromId: string;
  toId: string;
  specifier: string;
  kind?: "import" | "export" | "dynamic" | "require" | "style" | "from-import" | "package";
  resolution?: "file" | "package";
  resolutionBasis?: "relative-path" | "config-alias" | "typescript-resolution" | "python-module" | "python-submodule" | "go-package-expanded";
  typeOnly?: boolean;
  reference: SourceReference;
};

export type TourStep = {
  id: string;
  title: string;
  focusFileId: string;
  description: string;
  reference: SourceReference;
  relationship?: string;
  question?: string;
};

export type RepositorySnapshot = {
  id: string;
  /** Stable local persistence key; GitHub repositories use a ref-scoped value while id remains the service session identity. */
  workspaceId?: string;
  /** Identifies the opened service session so late writes cannot target a newer ref. */
  persistenceSessionId?: string;
  version: string;
  name: string;
  description: string;
  files: FileRecord[];
  dependencies: DependencyEdge[];
  tour: TourStep[];
  source?: "sample" | "local";
  origin?: {
    kind: "github";
    url: string;
    owner: string;
    repository: string;
    requestedRef: string;
    resolvedRef: string;
    commit: string;
    subdirectory: string;
  };
  revision?: string;
  sequence?: number;
  configPath?: string[];
  diagnostics?: { path?: string; message: string }[];
  unresolved?: { fileId: string; specifier: string; line: number; kind: string; external: boolean }[];
};

export type AiPreview = {
  id: string;
  repositoryId: string;
  revision: string;
  entryFileId: string;
  mode: "explanation" | "route" | "question" | "investigation";
  goal?: string;
  baseUrl: string;
  model: string;
  files: { fileId: string; startLine: number; endLine: number; contentHash: string; reasons?: string[] }[];
  characters: number;
  tokenEstimate?: number;
  expiresAt: number;
  question?: string;
  history?: { role: "user" | "assistant"; content: string }[];
  excludedFileIds?: string[]; retrievalInsufficient?: boolean;
};

export type AiRouteRecord = {
  repositoryId: string;
  entryFileId: string;
  revision: string;
  title: string;
  goal?: string;
  signature: string;
  sourceSteps: { fileId: string; purpose: string; relationship?: string; question?: string; references: { fileId: string; startLine: number; endLine?: number | null }[] }[];
  steps: TourStep[];
  contextFiles: { fileId: string; contentHash: string }[];
  /** Imported references may be retained for their notes while navigation remains disabled. */
  stale?: boolean;
};

export type AiSavedResult = {
  /** Older saved results may predate one or more of these metadata fields. */
  __repositoryId?: string;
  __entryFileId?: string;
  __revision?: string;
  __mode?: "explanation" | "route" | "question" | "investigation";
  __contextFiles?: { fileId: string; contentHash: string }[];
  __routeSteps?: TourStep[];
  role?: string;
  title?: string;
  answer?: string;
  keyPoints?: string[];
  references?: { fileId: string; startLine: number; endLine?: number }[];
  steps?: { fileId: string; purpose: string; references: { fileId: string; startLine: number; endLine?: number }[] }[];
  insufficientEvidence?: boolean;
  /** Preserve forward-compatible fields when reading older or newer local records. */
  [key: string]: unknown;
};

export type AiQuestionReference = {
  fileId: string;
  startLine: number;
  endLine?: number;
};

export type AiQuestionMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  references: AiQuestionReference[];
  contextFiles: { fileId: string; contentHash: string; startLine?: number; endLine?: number }[];
  claims?: { text: string; referenceIndices: number[] }[];
  insufficientEvidence?: boolean;
  stale?: boolean;
};

export type AiQuestionConversation = {
  id: string;
  title: string;
  messages: AiQuestionMessage[];
  updatedAt: number;
};

export type SearchRequest = {
  repositoryId: string;
  revision: string;
  query: string;
  offset?: number;
  pathPrefix?: string;
  language?: string;
  matchCase?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  excludeTests?: boolean;
};

export type SearchResult = {
  fileId: string;
  path: string;
  language: string;
  line: number;
  text: string;
  contextStartColumn: number;
  contextEndColumn: number;
  lineLength: number;
  matchStartColumn: number;
  matchEndColumn: number;
};

export type SearchResponse = {
  revision: string;
  filesSearched: number;
  offset: number;
  pageSize: number;
  total: number;
  results: SearchResult[];
  hasMore: boolean;
  capped: boolean;
};

export type RepositoryOverview = {
  revision: string;
  readme: { path: string; summary: string | null } | null;
  manifests: string[];
  candidates: { fileId: string; path: string; reason: string }[];
  directories: { name: string; files: number }[];
  languages: { name: string; files: number }[];
  tests: string[];
  testCount: number;
  diagnosticCount: number;
  limitations: string;
};

export type DependencyQuery = {
  fromFileId: string;
  toFileId?: string;
  direction: "imports" | "imported-by";
  kind: "path" | "impact" | "cycle";
};

export type DependencyPathResult = {
  status: "found" | "not-found" | "missing";
  files?: string[];
  edgeIds?: string[];
};

export type ReadingNote = {
  id: string;
  fileId: string;
  path: string;
  startLine: number;
  endLine?: number;
  text: string;
  contentHash: string;
  commit?: string;
  createdAt: number;
  stale?: boolean;
  kind: "note" | "bookmark" | "question";
};

export type RevisionComparison = {
  revision: string;
  mode: "working-tree" | "commits";
  baseCommit: string;
  headCommit: string;
  files: { status: "added" | "modified" | "deleted" | "renamed"; path: string; oldPath?: string }[];
  diff: string;
  skipped?: { path: string; reason: string }[];
  limits: { maxFiles: number; maxDiffBytes: number };
};
