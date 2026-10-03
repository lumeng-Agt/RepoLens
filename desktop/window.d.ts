export {};

declare global {
  var __REPOLENS_RUNTIME__: { apiOrigin: string; desktop: boolean } | undefined;

  interface Window {
    repoLens?: {
      selectDirectory(): Promise<string | null>;
      quit(): Promise<void>;
    };
  }
}
