import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      main: "electron/main.ts",
      preload: "electron/preload.ts"
    },
    format: ["cjs"],
    outDir: "dist-electron",
    sourcemap: true,
    clean: true,
    target: "node20",
    external: ["electron"]
  }
]);
