import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  root: "src/web",
  publicDir: false,
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
  server: {
    port: 5273,
    proxy: {
      "/api": "http://127.0.0.1:8973",
    },
  },
  resolve: {
    alias: {
      "@resources": fileURLToPath(new URL("./resources", import.meta.url)),
    },
  },
  plugins: [react()],
});
