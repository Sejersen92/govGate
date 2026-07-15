import type { ParsedTest } from "./parsers/types.js";

export type Mappings = Record<string, string[]>;

export type CaseResult = {
  caseNumber: number;
  status: "pass" | "fail";
  notes: string;
  tests: ParsedTest[];
};

export type MappingOutcome = {
  results: CaseResult[];
  unmappedTests: ParsedTest[];
  /** Cases that only had skipped tests — intentionally not reported (stay pending). */
  skippedOnlyCases: number[];
};

const TAG_RE = /@mt-(\d+)\b/g;

// .NET JUnit loggers emit METHOD names, not display names, so @mt tags never
// reach the XML. Identifier-style names (no whitespace) may instead carry an
// underscore-delimited token: Mt5_DuplicateEmail, Profiles_Mt12_NotFound.
const METHOD_TAG_RE = /(?:^|_)mt[-_]?(\d+)(?=_|$)/gi;

// A pattern with "*" wildcards, matched case-insensitively against the bare
// test name and (when the pattern contains "::") the full "<scope>::<name>" id.
function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

// xUnit [Theory] display names append inline args: `Mt11_Forward(status: "500")`.
// The args carry whitespace/quotes that would disqualify the whole name from
// method-token matching, so strip a trailing "(...)" to recover the bare method
// name. [Fact] names (no parens) are returned unchanged.
function bareMethodName(name: string): string {
  return name.replace(/\s*\(.*\)$/, "");
}

function tagCases(test: ParsedTest): number[] {
  const haystack = `${test.name} ${test.classname ?? ""}`;
  const cases = [...haystack.matchAll(TAG_RE)].map((m) => Number(m[1]));
  const bare = bareMethodName(test.name);
  if (!/\s/.test(bare)) {
    cases.push(...[...bare.matchAll(METHOD_TAG_RE)].map((m) => Number(m[1])));
  }
  return cases;
}

export function resolveCases(test: ParsedTest, mappings: Mappings): number[] {
  const cases = new Set<number>(tagCases(test));
  for (const [num, patterns] of Object.entries(mappings)) {
    for (const pattern of patterns) {
      const regex = patternToRegex(pattern);
      const candidates = pattern.includes("::") ? [test.id] : [test.name, test.id];
      if (candidates.some((c) => regex.test(c))) {
        cases.add(Number(num));
        break;
      }
    }
  }
  return [...cases];
}

const NOTE_CAP = 4000;
const MESSAGE_CAP = 500;

function truncate(s: string, cap: number): string {
  return s.length <= cap ? s : s.slice(0, cap - 12) + "… [truncated]";
}

function buildNotes(tests: ParsedTest[], status: "pass" | "fail"): string {
  if (status === "pass") {
    const ids = tests.filter((t) => t.status === "pass").map((t) => t.id);
    const shown = ids.slice(0, 10);
    const more = ids.length - shown.length;
    return truncate(
      `${ids.length} automated test(s) passed:\n` +
        shown.map((id) => `- ${id}`).join("\n") +
        (more > 0 ? `\n… and ${more} more` : ""),
      NOTE_CAP,
    );
  }
  const failing = tests.filter((t) => t.status === "fail");
  return truncate(
    `${failing.length} automated test(s) failed:\n` +
      failing
        .map((t) => `- ${t.id}: ${truncate(t.message ?? "no message", MESSAGE_CAP)}`)
        .join("\n"),
    NOTE_CAP,
  );
}

// Worst-status-wins aggregation per case. Cases whose mapped tests were all
// skipped are non-observations and are not reported at all.
export function mapTestsToCases(tests: ParsedTest[], mappings: Mappings): MappingOutcome {
  const byCase = new Map<number, ParsedTest[]>();
  const unmappedTests: ParsedTest[] = [];

  for (const test of tests) {
    const cases = resolveCases(test, mappings);
    if (cases.length === 0) {
      unmappedTests.push(test);
      continue;
    }
    for (const num of cases) {
      const list = byCase.get(num) ?? [];
      list.push(test);
      byCase.set(num, list);
    }
  }

  const results: CaseResult[] = [];
  const skippedOnlyCases: number[] = [];
  for (const [caseNumber, caseTests] of [...byCase.entries()].sort((a, b) => a[0] - b[0])) {
    const anyFail = caseTests.some((t) => t.status === "fail");
    const anyPass = caseTests.some((t) => t.status === "pass");
    if (!anyFail && !anyPass) {
      skippedOnlyCases.push(caseNumber);
      continue;
    }
    const status = anyFail ? "fail" : "pass";
    results.push({ caseNumber, status, notes: buildNotes(caseTests, status), tests: caseTests });
  }

  return { results, unmappedTests, skippedOnlyCases };
}
