import { afterEach, describe, expect, it, vi } from "vitest";
import { supportEmail } from "./support";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("supportEmail", () => {
  it("is null when unset or blank, so the contact line is hidden", () => {
    vi.stubEnv("SUPPORT_EMAIL", "");
    expect(supportEmail()).toBeNull();
    vi.stubEnv("SUPPORT_EMAIL", "   ");
    expect(supportEmail()).toBeNull();
  });

  it("returns a trimmed address", () => {
    vi.stubEnv("SUPPORT_EMAIL", "  help@example.com ");
    expect(supportEmail()).toBe("help@example.com");
  });

  it("rejects values that aren't a plain address", () => {
    for (const bad of [
      "help",
      "help@example",
      "a b@example.com",
      "<x@y.z>",
      "help@example.com?subject=Hi&body=x",
      "help@example.com#x",
    ]) {
      vi.stubEnv("SUPPORT_EMAIL", bad);
      expect(supportEmail()).toBeNull();
    }
  });
});
