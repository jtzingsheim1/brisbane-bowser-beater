import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Python analysis pipeline — its own venv (.venv/) ships thousands of
    // vendored JS files (jupyter et al.) that have nothing to do with our TS.
    "analysis/**",
    // MCP subproject — own package.json/tsconfig; checked by the CI `mcp`
    // job (tsc + vitest + esbuild), not by the root toolchain.
    "mcp/**",
  ]),
]);

export default eslintConfig;
