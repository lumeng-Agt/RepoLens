import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  resolve: { alias: { "@": root } },
  server: { host: "127.0.0.1", strictPort: true },
  preview: { host: "127.0.0.1", strictPort: true },
  build: {
    outDir: mode === "desktop" ? "desktop/renderer" : "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/react/") || id.includes("node_modules/react-dom/")) return "vendor-react";
          if (id.includes("@xyflow") || id.includes("@dagrejs")) return "vendor-flow";
          if (id.includes("radix-ui") || id.includes("@radix-ui") || id.includes("cmdk")) return "vendor-ui";
          if (id.includes("lucide-react")) return "vendor-icons";
        },
      },
    },
  },
}));
