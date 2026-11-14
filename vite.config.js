import { defineConfig } from "vite";
import { createAssistantApi } from "./server/api.js";

const assistantApi = {
  name: "terralens-assistant-api",
  configureServer(server) {
    server.middlewares.use(createAssistantApi());
  },
  configurePreviewServer(server) {
    server.middlewares.use(createAssistantApi());
  },
};

export default defineConfig({
  base: "./",
  plugins: [assistantApi],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/zrender")) return "chart-renderer";
          if (id.includes("node_modules/echarts")) return "climate-charts";
          if (id.includes("node_modules/three")) return "earth-engine";
          if (id.includes("node_modules/leaflet")) return "map-engine";
        },
      },
    },
  },
});
