import { defineConfig } from "vitest/config";

// Own config so runs inside mcp/ never inherit the repo root's vitest setup
// (root aliases and include globs don't apply to this subproject).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
