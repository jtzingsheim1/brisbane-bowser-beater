import { describe, expect, it } from "vitest";
import {
  isSanePriceDollars,
  priceToDollars,
  toUtcIso,
} from "../scripts/lib/qld-api.mjs";

describe("priceToDollars", () => {
  it("converts tenths-of-a-cent to $/L", () => {
    expect(priceToDollars(1899)).toBeCloseTo(1.899, 3);
  });
  it("returns null for non-finite input", () => {
    expect(priceToDollars("abc")).toBeNull();
  });
});

describe("isSanePriceDollars", () => {
  it("rejects the 9999 sentinel ($9.999 > $5.00 ceiling)", () => {
    expect(isSanePriceDollars(priceToDollars(9999))).toBe(false);
  });
  it("accepts a normal price", () => {
    expect(isSanePriceDollars(1.899)).toBe(true);
  });
  it("rejects null and out-of-band values", () => {
    expect(isSanePriceDollars(null)).toBe(false);
    expect(isSanePriceDollars(0.4)).toBe(false);
    expect(isSanePriceDollars(5.5)).toBe(false);
  });
});

describe("toUtcIso", () => {
  it("appends Z to a zone-less timestamp", () => {
    expect(toUtcIso("2026-05-25T04:10:18.237")).toBe("2026-05-25T04:10:18.237Z");
  });
  it("leaves an already-zoned timestamp untouched", () => {
    expect(toUtcIso("2026-05-25T04:10:18Z")).toBe("2026-05-25T04:10:18Z");
    expect(toUtcIso("2026-05-25T04:10:18+10:00")).toBe("2026-05-25T04:10:18+10:00");
  });
});
