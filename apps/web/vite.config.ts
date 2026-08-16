import { resolve } from "node:path";
import { defineConfig } from "vite";
import { forgePlugin } from "./forge-plugin";

export default defineConfig({
  plugins: [forgePlugin()],
  optimizeDeps: {
    exclude: ["@llm-rpg/engine"],
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        sprites: resolve(__dirname, "sprites.html"),
      },
    },
  },
  server: {
    fs: {
      // allow importing the engine source and game files from the repo root
      allow: ["../.."],
    },
  },
});
