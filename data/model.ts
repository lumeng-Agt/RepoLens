export type SourceReference = {
  fileId: string;
  line: number;
  endLine?: number;
};

export type ImportRecord = {
  targetPath: string;
  specifier: string;
  resolution?: "file" | "package";
};

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
  imports: ImportRecord[];
};

export type DependencyEdge = {
  id: string;
  fromId: string;
  toId: string;
  specifier: string;
  kind?: "import" | "export" | "dynamic" | "require" | "style" | "from-import" | "package";
  resolution?: "file" | "package";
  typeOnly?: boolean;
  reference: SourceReference;
};

export type TourStep = {
  id: string;
  title: string;
  focusFileId: string;
  description: string;
  reference: SourceReference;
};

export type RepositorySnapshot = {
  id: string;
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
  mode: "explanation" | "route" | "question";
  baseUrl: string;
  model: string;
  files: { fileId: string; startLine: number; endLine: number; contentHash: string }[];
  characters: number;
  expiresAt: number;
  question?: string;
  history?: { role: "user" | "assistant"; content: string }[];
  retrievalInsufficient?: boolean;
};

export type AiRouteRecord = {
  repositoryId: string;
  entryFileId: string;
  revision: string;
  title: string;
  signature: string;
  sourceSteps: { fileId: string; purpose: string; references: { fileId: string; startLine: number; endLine?: number | null }[] }[];
  steps: TourStep[];
  contextFiles: { fileId: string; contentHash: string }[];
};
