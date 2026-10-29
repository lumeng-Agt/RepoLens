export {};

declare global {
  var __REPOLENS_RUNTIME__: { apiOrigin: string; desktop: boolean } | undefined;

  interface Window {
    repoLens?: {
      selectDirectory(): Promise<string | null>;
      openInEditor(input: { repositoryId: string; revision: string; persistenceSessionId?: string; fileId: string; contentHash: string; line: number }): Promise<boolean>;
      quit(): Promise<void>;
      onBackendStatus(listener: (status: { available: boolean; message: string }) => void): () => void;
    };
  }
}
