// Guards on the curated RAG corpus (mcp/corpus-manifest.txt): every listed
// file exists, internal working notes are never listed, and every corpus
// doc passes the same language-discipline sweep as the server's own
// strings, since retrieved passages become tool output.

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BANNED_LANGUAGE } from "./banned-language.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../..");

function manifestEntries(): string[] {
  const raw = readFileSync(join(REPO_ROOT, "mcp/corpus-manifest.txt"), "utf-8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

describe("corpus manifest", () => {
  it("lists at least the core public docs, all of which exist", () => {
    const entries = manifestEntries();
    expect(entries).toContain("README.md");
    expect(entries).toContain("mcp/README.md");
    expect(entries.length).toBeGreaterThanOrEqual(5);
    for (const entry of entries) {
      expect(entry.endsWith(".md"), `${entry} must be markdown`).toBe(true);
      expect(entry.startsWith("/"), `${entry} must be repo-relative`).toBe(
        false,
      );
      expect(entry.includes(".."), `${entry} must not traverse up`).toBe(
        false,
      );
      expect(existsSync(join(REPO_ROOT, entry)), `${entry} must exist`).toBe(
        true,
      );
    }
  });

  it("never lists internal working notes", () => {
    const entries = manifestEntries();
    for (const excluded of ["CLAUDE.md", "PLAN.md", "AGENTS.md"]) {
      expect(entries, `${excluded} is internal`).not.toContain(excluded);
    }
  });

  it("keeps banned framing out of every corpus doc", () => {
    for (const entry of manifestEntries()) {
      const text = readFileSync(join(REPO_ROOT, entry), "utf-8").toLowerCase();
      for (const banned of BANNED_LANGUAGE) {
        expect(text, `banned term "${banned}" in ${entry}`).not.toContain(
          banned,
        );
      }
    }
  });
});
