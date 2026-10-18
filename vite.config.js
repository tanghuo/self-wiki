import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const rendererRoot = path.resolve(projectRoot, "src/renderer");
const apiTarget = process.env.EXTERNAL_API_URL || `http://127.0.0.1:${process.env.API_PORT || 8765}`;

export default defineConfig({
  root: rendererRoot,
  base: "./",
  plugins: [react()],
  build: {
    outDir: path.resolve(projectRoot, "dist/renderer"),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(rendererRoot, "index.html"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": { target: apiTarget, changeOrigin: false },
    },
  },
});
