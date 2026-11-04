/// <reference types="vitest" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    // O LiveKit já sai em arquivo próprio (importação dinâmica); o React vai à parte para ficar em cache entre versões
    rollupOptions: { output: { manualChunks: { react: ["react", "react-dom"] } } },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3001",
      "/ws": { target: "ws://localhost:3001", ws: true },
    },
  },
  test: {
    environment: "jsdom",
  },
});
