import { describe, expect, it } from "vitest";
import { bearerAuthorized } from "./cron-auth";

describe("bearerAuthorized", () => {
  it("is open when no secret is configured", () => {
    expect(bearerAuthorized(null, undefined)).toBe(true);
    expect(bearerAuthorized("Bearer anything", undefined)).toBe(true);
    expect(bearerAuthorized(null, "")).toBe(true);
  });

  it("rejects a missing header when a secret is set", () => {
    expect(bearerAuthorized(null, "s3cret")).toBe(false);
  });

  it("rejects the wrong scheme", () => {
    expect(bearerAuthorized("Token s3cret", "s3cret")).toBe(false);
    expect(bearerAuthorized("bearer s3cret", "s3cret")).toBe(false);
    expect(bearerAuthorized("s3cret", "s3cret")).toBe(false);
  });

  it("rejects the wrong token, including length mismatches", () => {
    expect(bearerAuthorized("Bearer wrong", "s3cret")).toBe(false);
    expect(bearerAuthorized("Bearer s3cret-plus-suffix", "s3cret")).toBe(false);
    expect(bearerAuthorized("Bearer ", "s3cret")).toBe(false);
  });

  it("accepts the correct bearer token", () => {
    expect(bearerAuthorized("Bearer s3cret", "s3cret")).toBe(true);
  });
});
