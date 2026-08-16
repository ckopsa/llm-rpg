import { resolve } from "node:path";
import { defineConfig } from "vite";
import { forgePlugin } from "./forge-plugin";
import { piperPlugin } from "./piper-plugin";

export default defineConfig({
  // Served from "/" in dev and from "/<repo>/" on GitHub Pages. The CI sets
  // BASE_PATH; anything that references an asset must go through BASE_URL
  // (see render/manifest.ts) or it will 404 under a subdirectory.
  base: process.env.BASE_PATH ?? "/",
  plugins: [forgePlugin(), piperPlugin()],
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
