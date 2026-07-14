import type { MappingOutcome } from "./mapping.js";
import type { GateVerdict, StatusCounts } from "./gate.js";

export function printMappingTable(outcome: MappingOutcome) {
  console.log("\nMapped cases:");
  if (outcome.results.length === 0) {
    console.log("  (none — no tests matched a case tag or mapping pattern)");
  }
  for (const r of outcome.results) {
    console.log(`  #${r.caseNumber} -> ${r.status.toUpperCase()} (${r.tests.length} test(s))`);
    for (const t of r.tests) console.log(`      ${t.status.padEnd(7)} ${t.id}`);
  }
  if (outcome.skippedOnlyCases.length) {
    console.log(
      `  Cases with only skipped tests (not reported): ${outcome.skippedOnlyCases.map((n) => `#${n}`).join(", ")}`,
    );
  }
  if (outcome.unmappedTests.length) {
    console.log(`\nUnmapped tests (${outcome.unmappedTests.length}) — add @mt-<case> tags or govgate/config.json mappings:`);
    for (const t of outcome.unmappedTests.slice(0, 20)) console.log(`  - ${t.id}`);
    if (outcome.unmappedTests.length > 20)
      console.log(`  … and ${outcome.unmappedTests.length - 20} more`);
  }
}

export function printCounts(counts: StatusCounts, executedPercent: number) {
  console.log(
    `\nRun totals: ${counts.total} cases — pass ${counts.pass}, fail ${counts.fail}, blocked ${counts.blocked}, na ${counts.na}, pending ${counts.pending} (${executedPercent}% executed)`,
  );
}

export function printUnknownCases(unknown: number[]) {
  if (!unknown.length) return;
  console.error(
    `\n!! WARNING: ${unknown.length} reported case number(s) do not exist in the suite: ${unknown
      .map((n) => `#${n}`)
      .join(", ")}\n!! Their results were DROPPED. Fix the @mt tags / mappings or re-import the suite.`,
  );
}

export function printGate(verdict: GateVerdict) {
  if (verdict.passed) {
    console.log("\nGate: PASSED");
  } else {
    console.error(`\nGate: FAILED\n${verdict.reasons.map((r) => `  - ${r}`).join("\n")}`);
  }
}

export function printRunUrl(baseUrl: string, runId: string) {
  console.log(`\nRun: ${baseUrl}/runs/${runId}`);
}
