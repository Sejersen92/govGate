import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseJUnitXml } from "../src/parsers/junit.js";

const fixture = (name: string) =>
  readFileSync(join(__dirname, "fixtures", name), "utf8");

describe("parseJUnitXml", () => {
  it("parses a testsuites root with multiple suites", () => {
    const tests = parseJUnitXml(fixture("junit-vitest.xml"));
    expect(tests).toHaveLength(4);

    const pass = tests[0];
    expect(pass.name).toBe("completes checkout with sandbox card @mt-1");
    expect(pass.status).toBe("pass");
    expect(pass.file).toBe("src/checkout.spec.ts");
    expect(pass.id).toBe("src/checkout.spec.ts::completes checkout with sandbox card @mt-1");

    const fail = tests[2];
    expect(fail.status).toBe("fail");
    expect(fail.message).toContain("expected 402 but received 500");

    const skipped = tests[3];
    expect(skipped.status).toBe("skipped");
  });

  it("parses nested testsuite elements and errors as failures", () => {
    const tests = parseJUnitXml(fixture("junit-nested-suites.xml"));
    expect(tests).toHaveLength(2);
    expect(tests[0].status).toBe("pass");
    expect(tests[0].id).toBe("Login flow::redirects to signin");
    expect(tests[1].status).toBe("fail");
    expect(tests[1].message).toContain("timeout");
  });

  it("parses a single testsuite root (pytest style)", () => {
    const tests = parseJUnitXml(fixture("junit-single-suite.xml"));
    expect(tests).toHaveLength(2);
    expect(tests[0].id).toBe("tests.test_api::test_health_endpoint");
  });

  it("returns empty for an empty report", () => {
    expect(parseJUnitXml(fixture("junit-empty.xml"))).toHaveLength(0);
  });
});
