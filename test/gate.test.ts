import { describe, expect, it } from "vitest";
import { evaluateGate, executedPercent, parseFailOn } from "../src/gate.js";

const counts = (over: Partial<Record<string, number>> = {}) => ({
  total: 10,
  pass: 6,
  fail: 0,
  na: 2,
  blocked: 0,
  pending: 2,
  ...over,
});

describe("gate", () => {
  it("passes with default fail-on when nothing failed", () => {
    const v = evaluateGate(counts(), { failOn: ["fail"] });
    expect(v.passed).toBe(true);
    expect(v.executedPercent).toBe(80);
  });

  it("fails when a case failed", () => {
    const v = evaluateGate(counts({ fail: 1, pass: 5 }), { failOn: ["fail"] });
    expect(v.passed).toBe(false);
    expect(v.reasons[0]).toContain("'fail'");
  });

  it("fail-on blocked only triggers when requested", () => {
    const c = counts({ blocked: 2, pass: 4 });
    expect(evaluateGate(c, { failOn: ["fail"] }).passed).toBe(true);
    expect(evaluateGate(c, { failOn: ["fail", "blocked"] }).passed).toBe(false);
  });

  it("enforces min-executed", () => {
    const v = evaluateGate(counts({ pending: 5, pass: 3 }), { failOn: ["fail"], minExecuted: 80 });
    expect(v.passed).toBe(false);
    expect(v.reasons[0]).toContain("50%");
  });

  it("handles zero totals", () => {
    expect(executedPercent(counts({ total: 0, pass: 0, na: 0, pending: 0 }))).toBe(0);
  });

  it("parses fail-on lists and rejects junk", () => {
    expect(parseFailOn("fail,blocked")).toEqual(["fail", "blocked"]);
    expect(() => parseFailOn("fail,nonsense")).toThrow();
  });
});
