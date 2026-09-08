import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Minimal Vitest setup. Tests are deliberately scoped (CLAUDE.md) to the
// deterministic logic that would silently mislead users or cost money if it
// regressed: the forecast projection, the narrative copy, the ingestion
// transforms, and the plan-cache hash.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
