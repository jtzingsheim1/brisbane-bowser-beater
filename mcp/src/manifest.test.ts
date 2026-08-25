// Guards on the curated RAG corpus (mcp/corpus-manifest.txt): every listed
// file exists, internal working notes are never listed, and every corpus
// doc passes the same language-discipline sweep as the server's own
// strings, since retrieved passages become tool output.

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUDIENCE_ANCHORED_TERMS,
  BANNED_LANGUAGE,
} from "./banned-language.js";

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

  it("is formatted exactly as the deploy shell parser requires", () => {
    // The workflow's `while read` loop does not trim and needs a trailing
    // newline; enforce the strict format here so the unit test and the
    // shell parser can never disagree about an entry.
    const raw = readFileSync(
      join(REPO_ROOT, "mcp/corpus-manifest.txt"),
      "utf-8",
    );
    expect(raw.endsWith("\n"), "must end with a newline").toBe(true);
    for (const line of raw.split("\n")) {
      expect(line, "no leading/trailing whitespace").toBe(line.trim());
      expect(line.includes("\r"), "no carriage returns").toBe(false);
    }
    for (const entry of manifestEntries()) {
      expect(
        /^[A-Za-z0-9._/-]+$/.test(entry),
        `${entry} must use the conservative character set the workflow enforces`,
      ).toBe(true);
    }
  });

  it("never lists internal working notes", () => {
    const entries = manifestEntries();
    for (const excluded of ["CLAUDE.md", "PLAN.md", "AGENTS.md"]) {
      expect(entries, `${excluded} is internal`).not.toContain(excluded);
    }
  });

  // Shared by both discipline sweeps so their mechanics cannot diverge:
  // case-insensitive substring match over every corpus doc.
  function sweepCorpus(terms: readonly string[], label: string) {
    for (const entry of manifestEntries()) {
      const text = readFileSync(join(REPO_ROOT, entry), "utf-8").toLowerCase();
      for (const term of terms) {
        expect(text, `${label} "${term}" in ${entry}`).not.toContain(term);
      }
    }
  }

  it("keeps banned framing out of every corpus doc", () => {
    sweepCorpus(BANNED_LANGUAGE, "banned term");
  });

  it("keeps reader-anchored framing out of every corpus doc", () => {
    // Corpus docs describe what the project does, never who is assumed
    // to read it (see banned-language.ts). A hit here means the doc
    // needs rewording, not the list loosening.
    sweepCorpus(AUDIENCE_ANCHORED_TERMS, "reader-anchored term");
  });
});
