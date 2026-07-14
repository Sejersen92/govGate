import { describe, expect, it } from "vitest";
import { mapTestsToCases, resolveCases } from "../src/mapping.js";
import type { ParsedTest } from "../src/parsers/types.js";

const test = (over: Partial<ParsedTest>): ParsedTest => ({
  id: over.file || over.classname ? `${over.file ?? over.classname}::${over.name}` : (over.name ?? "t"),
  name: "t",
  status: "pass",
  ...over,
});

describe("resolveCases", () => {
  it("extracts multiple @mt tags from the name", () => {
    expect(resolveCases(test({ name: "price scales @mt-1 @mt-3" }), {})).toEqual([1, 3]);
  });

  it("extracts tags from classname", () => {
    expect(resolveCases(test({ name: "x", classname: "Suite @mt-7" }), {})).toEqual([7]);
  });

  it("does not match @mt-1x as case 1", () => {
    expect(resolveCases(test({ name: "weird @mt-1x" }), {})).toEqual([]);
  });

  it("matches bare-name patterns case-insensitively with wildcards", () => {
    expect(resolveCases(test({ name: "Renders Legal Links" }), { "12": ["*legal links*"] })).toEqual([12]);
  });

  it("matches file::name patterns only against the full id", () => {
    const t = test({ name: "pays with saved card", file: "checkout.spec.ts" });
    expect(resolveCases(t, { "4": ["checkout.spec.ts::pays with saved card"] })).toEqual([4]);
    expect(resolveCases(t, { "4": ["other.spec.ts::pays with saved card"] })).toEqual([]);
  });

  it("unions tags and config mappings", () => {
    const t = test({ name: "checkout works @mt-2", file: "checkout.spec.ts" });
    expect(resolveCases(t, { "9": ["checkout.spec.ts::*"] }).sort()).toEqual([2, 9]);
  });

  it("matches Mt<n> tokens in identifier-style method names (.NET JUnit loggers)", () => {
    expect(resolveCases(test({ name: "Mt5_DuplicateEmail_Rejected" }), {})).toEqual([5]);
    expect(resolveCases(test({ name: "Profiles_Mt12_NotFound" }), {})).toEqual([12]);
    expect(resolveCases(test({ name: "Delete_Resolves_MT28" }), {})).toEqual([28]);
    expect(resolveCases(test({ name: "Batch_Mt_7_Works" }), {})).toEqual([7]);
  });

  it("does not apply the method-name convention to names with spaces", () => {
    expect(resolveCases(test({ name: "the mt5 terminal renders" }), {})).toEqual([]);
  });

  it("does not false-positive on embedded substrings", () => {
    expect(resolveCases(test({ name: "Format2_Works" }), {})).toEqual([]);
    expect(resolveCases(test({ name: "GMT5_Timezone" }), {})).toEqual([]);
  });
});

describe("mapTestsToCases", () => {
  it("aggregates worst-status-wins", () => {
    const outcome = mapTestsToCases(
      [
        test({ name: "a @mt-5", status: "pass" }),
        test({ name: "b @mt-5", status: "fail", message: "boom" }),
        test({ name: "c @mt-6", status: "pass" }),
      ],
      {},
    );
    expect(outcome.results).toHaveLength(2);
    expect(outcome.results[0]).toMatchObject({ caseNumber: 5, status: "fail" });
    expect(outcome.results[0].notes).toContain("boom");
    expect(outcome.results[1]).toMatchObject({ caseNumber: 6, status: "pass" });
  });

  it("keeps all-skipped cases out of the results (stay pending)", () => {
    const outcome = mapTestsToCases([test({ name: "s @mt-9", status: "skipped" })], {});
    expect(outcome.results).toHaveLength(0);
    expect(outcome.skippedOnlyCases).toEqual([9]);
  });

  it("collects unmapped tests", () => {
    const outcome = mapTestsToCases([test({ name: "no tag here" })], {});
    expect(outcome.unmappedTests).toHaveLength(1);
    expect(outcome.results).toHaveLength(0);
  });

  it("caps notes length", () => {
    const long = "x".repeat(10_000);
    const outcome = mapTestsToCases(
      [test({ name: "f @mt-1", status: "fail", message: long })],
      {},
    );
    expect(outcome.results[0].notes.length).toBeLessThanOrEqual(4000);
  });
});
