import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(root, "desktop"),
  base: "/",
  plugins: [react()],
  resolve: { alias: { "@": root } },
  server: { host: "127.0.0.1", strictPort: true },
  build: {
    outDir: path.join(root, "desktop", "renderer"),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/react/") || id.includes("node_modules/react-dom/")) {
            return "vendor-react";
          }
          if (id.includes("@xyflow") || id.includes("@dagrejs")) {
            return "vendor-flow";
          }
          if (id.includes("radix-ui") || id.includes("@radix-ui") || id.includes("cmdk")) {
            return "vendor-ui";
          }
          if (id.includes("lucide-react")) {
            return "vendor-icons";
          }
        },
      },
    },
  },
});
