import { describe, expect, it } from "vitest";
import {
  dedupeBy,
  parseDateUtc,
  parsePrice,
  parseRows,
  toNumberOrNull,
  transformPrice,
  transformSite,
} from "../scripts/lib/csv-backfill.mjs";

// QLD has shipped two header conventions inside the 2026 dataset:
//   • Underscores (Jan, Feb, Apr, May 2026): "Site_Name", "Fuel_Type", …
//   • Spaces      (Mar 2026):                 "Site Name", "Fuel Type", …
// Both describe the same columns. parseRows normalises space → underscore so
// downstream transforms only need to know one shape. These fixtures are tiny
// hand-rolled CSVs covering the columns the transforms touch.

const UNDERSCORE_CSV = `SiteId,Site_Name,Site_Brand,Sites_Address_Line_1,Site_Suburb,Site_State,Site_Post_Code,Site_Latitude,Site_Longitude,Fuel_Type,Price,TransactionDateutc
61200001,Test Servo Spring Hill,United,12 Main St,Spring Hill,QLD,4000,-27.460000,153.020000,Unleaded,1899,15/05/2026 06:30
`;

const SPACE_CSV = `SiteId,Site Name,Site Brand,Sites Address Line 1,Site Suburb,Site State,Site Post Code,Site Latitude,Site Longitude,Fuel Type,Price,TransactionDateutc
61200001,Test Servo Spring Hill,United,12 Main St,Spring Hill,QLD,4000,-27.460000,153.020000,Unleaded,1899,15/05/2026 06:30
`;

describe("parseRows header normalisation", () => {
  it("parses underscore-headers and exposes underscored field names", () => {
    const [row] = parseRows(UNDERSCORE_CSV);
    expect(row.Site_Name).toBe("Test Servo Spring Hill");
    expect(row.Fuel_Type).toBe("Unleaded");
    expect(row.Site_Post_Code).toBe("4000");
  });

  it("parses space-headers and exposes the same underscored field names", () => {
    const [row] = parseRows(SPACE_CSV);
    expect(row.Site_Name).toBe("Test Servo Spring Hill");
    expect(row.Fuel_Type).toBe("Unleaded");
    expect(row.Site_Post_Code).toBe("4000");
  });

  it("produces identical row objects from both header conventions", () => {
    expect(parseRows(SPACE_CSV)).toEqual(parseRows(UNDERSCORE_CSV));
  });

  it("strips a leading UTF-8 BOM", () => {
    const [row] = parseRows(`﻿${UNDERSCORE_CSV}`);
    expect(row.SiteId).toBe("61200001");
  });
});

describe("transform* feed identically from either header convention", () => {
  it("transformSite matches across schemas", () => {
    const [underscore] = parseRows(UNDERSCORE_CSV).map(transformSite);
    const [space] = parseRows(SPACE_CSV).map(transformSite);
    expect(space).toEqual(underscore);
    expect(underscore).toMatchObject({
      site_id: 61200001,
      name: "Test Servo Spring Hill",
      postcode: "4000",
      state: "QLD",
      lat: -27.46,
      lng: 153.02,
      brand_name: "United",
    });
  });

  it("transformPrice matches across schemas", () => {
    const [underscore] = parseRows(UNDERSCORE_CSV).map(transformPrice);
    const [space] = parseRows(SPACE_CSV).map(transformPrice);
    expect(space).toEqual(underscore);
    expect(underscore).toEqual({
      site_id: 61200001,
      fuel_name: "Unleaded",
      price: 1.899,
      transaction_date_utc: "2026-05-15T06:30:00Z",
      data_source: "csv_backfill",
      collection_method: null,
    });
  });
});

describe("low-level helpers", () => {
  it("parseDateUtc handles single-digit day/month/hour", () => {
    expect(parseDateUtc("4/1/2026 6:05")).toBe("2026-01-04T06:05:00Z");
  });

  it("parseDateUtc throws on unrecognised format", () => {
    expect(() => parseDateUtc("2026-01-04")).toThrow(/Unrecognised date/);
  });

  it("parsePrice converts tenths-of-cents to $/L", () => {
    expect(parsePrice("1860")).toBeCloseTo(1.86, 3);
  });

  it("toNumberOrNull returns null for empty / non-numeric", () => {
    expect(toNumberOrNull("")).toBeNull();
    expect(toNumberOrNull(null)).toBeNull();
    expect(toNumberOrNull("abc")).toBeNull();
    expect(toNumberOrNull("1.5")).toBe(1.5);
  });

  it("dedupeBy keeps the last occurrence of each key (Map insertion order)", () => {
    const rows = [
      { id: 1, v: "a" },
      { id: 2, v: "b" },
      { id: 1, v: "c" },
    ];
    expect(dedupeBy(rows, (r) => r.id)).toEqual([
      { id: 1, v: "c" },
      { id: 2, v: "b" },
    ]);
  });
});
